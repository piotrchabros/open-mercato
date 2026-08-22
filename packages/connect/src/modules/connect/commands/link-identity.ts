import { LockMode } from '@mikro-orm/core'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  ConnectCase,
  ConnectContactIdentity,
  ConnectIdentityLinkAudit,
  ConnectManualMatchTask,
} from '../data/entities'
import { stageDomainEvent } from '../lib/domain-outbox'

/**
 * Link a contact identity to a customer.
 *
 * The order here is the security property: the customer reference is validated
 * through the source-owned contract BEFORE any Connect row is written. A stale,
 * forged, deleted, wrong-kind, sibling-organization or foreign-tenant id must
 * not produce a link audit, a closed task or a projection — and all six produce
 * the same `customer_missing`, so the API cannot be used to probe which
 * customers exist.
 *
 * Linking while an unlink is in flight is refused. A link admitted mid-unlink
 * would create an association outside the inventory the saga already committed
 * to, and it would survive the retraction.
 */

const linkSchema = z.object({
  identityId: z.string().uuid(),
  customerKind: z.enum(['person', 'company']),
  customerId: z.string().uuid(),
  reason: z.string().max(500).optional(),
  expectedUpdatedAt: z.string().optional(),
  actor: z.object({
    userId: z.string().uuid(),
    tenantId: z.string().uuid(),
    organizationId: z.string().uuid(),
    features: z.array(z.string()),
  }),
})

export type LinkIdentityInput = z.infer<typeof linkSchema>

export type LinkIdentityResult =
  | { status: 'linked'; identityId: string; associationEpoch: number; updatedAt: string }
  | { status: 'noop'; identityId: string; updatedAt: string }
  | { status: 'not_found' }
  | { status: 'customer_missing' }
  | { status: 'unlink_in_progress'; sagaId: string }
  | { status: 'conflict'; currentUpdatedAt: string }

export const CONNECT_LINK_IDENTITY_COMMAND_ID = 'connect.customer_match.link'

type ContainerLike = { resolve: <T = unknown>(name: string) => T }

type InteractionLifecycleLike = {
  resolveCustomerReference: (input: {
    kind: 'person' | 'company'
    id: string
    scope: { tenantId: string; organizationId: string }
  }) => Promise<{ status: string }>
}

export async function linkIdentity(
  container: ContainerLike,
  rawInput: LinkIdentityInput,
  now: Date = new Date(),
): Promise<LinkIdentityResult> {
  const input = linkSchema.parse(rawInput)
  const { actor } = input

  // Validate the customer FIRST, outside the transaction, so a bad reference
  // never reaches a Connect write at all.
  const lifecycle = container.resolve<InteractionLifecycleLike>('customersInteractionLifecycle')
  const reference = await lifecycle.resolveCustomerReference({
    kind: input.customerKind,
    id: input.customerId,
    scope: { tenantId: actor.tenantId, organizationId: actor.organizationId },
  })
  if (reference.status !== 'resolved') return { status: 'customer_missing' }

  const rootEm = (container.resolve('em') as EntityManager).fork()

  return rootEm.transactional(async (tem) => {
    const em = tem as EntityManager

    // The shared identity lock: ingest, link, unlink and projection all take it,
    // so their decisions serialize instead of racing.
    const identity = await em.findOne(
      ConnectContactIdentity,
      {
        id: input.identityId,
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!identity) return { status: 'not_found' }

    if (identity.unlinkPendingSagaId) {
      return { status: 'unlink_in_progress', sagaId: identity.unlinkPendingSagaId }
    }

    if (input.expectedUpdatedAt) {
      const current = identity.updatedAt.toISOString()
      if (new Date(input.expectedUpdatedAt).toISOString() !== current) {
        return { status: 'conflict', currentUpdatedAt: current }
      }
    }

    if (identity.customerId === input.customerId && identity.customerKind === input.customerKind) {
      return { status: 'noop', identityId: identity.id, updatedAt: identity.updatedAt.toISOString() }
    }

    const previousKind = identity.customerKind ?? null
    const previousId = identity.customerId ?? null

    identity.customerKind = input.customerKind
    identity.customerId = input.customerId
    identity.linkState = 'linked'
    identity.matchMethod = 'manual'
    identity.confidence = 100
    // A NEW association epoch: projections created under the previous link
    // belong to a retraction group this one's unlink must not reach.
    identity.associationEpoch += 1

    em.persist(
      em.create(ConnectIdentityLinkAudit, {
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
        identityId: identity.id,
        action: previousId ? 'relink' : 'link',
        actorUserId: actor.userId,
        fromCustomerKind: previousKind,
        fromCustomerId: previousId,
        toCustomerKind: input.customerKind,
        toCustomerId: input.customerId,
        reason: input.reason ?? null,
      }),
    )

    // Cases already attached to this identity adopt the new customer, so the
    // agent's view and the timeline agree immediately.
    await em.execute(
      `update "connect_cases" set "customer_kind" = ?, "customer_id" = ?, "updated_at" = ?
        where "tenant_id" = ? and "organization_id" = ? and "customer_id" is null
          and "id" in (
            select "current_case_id" from "connect_identity_case_bindings"
             where "tenant_id" = ? and "organization_id" = ? and "identity_id" = ?
               and "current_case_id" is not null
          )`,
      [
        input.customerKind,
        input.customerId,
        now,
        actor.tenantId,
        actor.organizationId,
        actor.tenantId,
        actor.organizationId,
        identity.id,
      ],
    )

    const openTask = await em.findOne(ConnectManualMatchTask, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      identityId: identity.id,
      status: 'open',
    })
    if (openTask) {
      openTask.status = 'resolved'
      openTask.resolution = 'linked'
      openTask.resolvedAt = now
    }

    stageDomainEvent(em, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      sourceEventId: `connect.projection.status_changed:link:${identity.id}:${identity.associationEpoch}`,
      aggregateId: identity.id,
      aggregateVersion: identity.associationEpoch,
      eventType: 'connect.projection.status_changed',
      payload: {
        identityId: identity.id,
        action: previousId ? 'relink' : 'link',
        associationEpoch: identity.associationEpoch,
        fromStatus: previousId ? 'linked' : 'unresolved',
        toStatus: 'linked',
        occurredAt: now.toISOString(),
      },
    })

    await em.flush()
    return {
      status: 'linked',
      identityId: identity.id,
      associationEpoch: identity.associationEpoch,
      updatedAt: identity.updatedAt.toISOString(),
    }
  })
}

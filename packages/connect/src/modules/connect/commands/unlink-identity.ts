import { LockMode } from '@mikro-orm/core'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  ConnectContactIdentity,
  ConnectIdentityLinkAudit,
  ConnectManualMatchTask,
  ConnectPendingProjection,
  ConnectPendingRetraction,
  ConnectRetractionSaga,
} from '../data/entities'
import { CONNECT_PROJECTION_NAMESPACE, buildSagaId } from '../lib/projection-key'
import { stageDomainEvent } from '../lib/domain-outbox'

const logger = createLogger('connect').child({ component: 'unlink-identity' })

/**
 * Unlink an identity from a customer, and take back everything the link
 * exposed.
 *
 * A wrong link puts another customer's conversations on someone's timeline, so
 * clearing the identity row alone — what earlier designs did — leaves the actual
 * exposure in place. This is therefore a two-module saga, ordered so that no
 * intermediate state is unsafe:
 *
 *   1. **Fence and commit the inventory** under the shared identity lock. From
 *      this moment no new projection can be admitted for this association, so
 *      the inventory cannot grow behind the saga's back.
 *   2. **Hide everything at the source, all-or-none.** A partial hide would leave
 *      part of the wrong customer's timeline visible, which is the failure.
 *   3. **Clear locally and record `commit`.** Only now does Connect stop showing
 *      the association — after the source has already hidden it, never before.
 *   4. **Finalize** the hidden interactions as tombstoned, with bounded retry.
 *
 * If step 2 or 3 fails, the decision is `abort` and the fence is cleared, so the
 * identity is usable again. Recovery reads both ledgers rather than guessing
 * from a lost acknowledgement.
 */

const unlinkSchema = z.object({
  identityId: z.string().uuid(),
  reason: z.string().min(1).max(500),
  expectedUpdatedAt: z.string().optional(),
  actor: z.object({
    userId: z.string().uuid(),
    tenantId: z.string().uuid(),
    organizationId: z.string().uuid(),
    features: z.array(z.string()),
  }),
})

export type UnlinkIdentityInput = z.infer<typeof unlinkSchema>

export type UnlinkIdentityResult =
  | { status: 'unlinked'; identityId: string; sagaId: string; retractedCount: number }
  | { status: 'not_linked'; identityId: string }
  | { status: 'not_found' }
  | { status: 'in_progress'; sagaId: string }
  | { status: 'source_unavailable'; sagaId: string }
  | { status: 'inventory_conflict'; sagaId: string }
  | { status: 'conflict'; currentUpdatedAt: string }

export const CONNECT_UNLINK_IDENTITY_COMMAND_ID = 'connect.customer_match.unlink'

type ContainerLike = { resolve: <T = unknown>(name: string) => T }

type InteractionLifecycleLike = {
  beginRetractionSaga: (input: Record<string, unknown>) => Promise<{ status: string }>
  commitRetractionSaga: (input: Record<string, unknown>) => Promise<{ status: string }>
  abortRetractionSaga: (input: Record<string, unknown>) => Promise<{ status: string }>
}

const RETRACT_FEATURE = 'customers.interactions.retract'

export async function unlinkIdentity(
  container: ContainerLike,
  rawInput: UnlinkIdentityInput,
  now: Date = new Date(),
): Promise<UnlinkIdentityResult> {
  const input = unlinkSchema.parse(rawInput)
  const { actor } = input
  const rootEm = (container.resolve('em') as EntityManager).fork()

  // ── (1) Fence and commit the inventory ─────────────────────
  const prepared = await rootEm.transactional(async (tem) => {
    const em = tem as EntityManager
    const identity = await em.findOne(
      ConnectContactIdentity,
      { id: input.identityId, tenantId: actor.tenantId, organizationId: actor.organizationId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!identity) return { kind: 'not_found' as const }
    if (identity.unlinkPendingSagaId) {
      return { kind: 'in_progress' as const, sagaId: identity.unlinkPendingSagaId }
    }
    if (!identity.customerId) return { kind: 'not_linked' as const, identityId: identity.id }
    if (input.expectedUpdatedAt) {
      const current = identity.updatedAt.toISOString()
      if (new Date(input.expectedUpdatedAt).toISOString() !== current) {
        return { kind: 'conflict' as const, currentUpdatedAt: current }
      }
    }

    const sagaId = buildSagaId(identity.id, identity.associationEpoch)
    const projections = await em.find(ConnectPendingProjection, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      identityId: identity.id,
      associationEpoch: identity.associationEpoch,
      status: 'projected',
    })
    const inventory = projections.map((row) => row.projectionKey).sort(compareKeys)

    // The fence. Every other writer checks it under this same lock, so from
    // here the inventory cannot grow behind the saga's back.
    identity.unlinkPendingSagaId = sagaId
    identity.unlinkPendingEpoch = identity.associationEpoch

    const saga = em.create(ConnectRetractionSaga, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      identityId: identity.id,
      sagaId,
      epoch: identity.associationEpoch,
      associationEpoch: identity.associationEpoch,
      inventory,
      phase: 'pending_hide',
      decision: 'undecided',
      actorUserId: actor.userId,
    })
    em.persist(saga)
    await em.flush()

    return {
      kind: 'prepared' as const,
      identityId: identity.id,
      sagaId,
      epoch: identity.associationEpoch,
      inventory,
      customerKind: identity.customerKind ?? null,
      customerId: identity.customerId,
      projections: projections.map((row) => ({
        projectionKey: row.projectionKey,
        caseId: row.caseId,
      })),
    }
  })

  if (prepared.kind !== 'prepared') {
    if (prepared.kind === 'not_found') return { status: 'not_found' }
    if (prepared.kind === 'in_progress') return { status: 'in_progress', sagaId: prepared.sagaId }
    if (prepared.kind === 'not_linked') return { status: 'not_linked', identityId: prepared.identityId }
    return { status: 'conflict', currentUpdatedAt: prepared.currentUpdatedAt }
  }

  const lifecycle = container.resolve<InteractionLifecycleLike>('customersInteractionLifecycle')
  const sagaScope = {
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
    namespace: CONNECT_PROJECTION_NAMESPACE,
    sagaId: prepared.sagaId,
    epoch: prepared.epoch,
  }
  const trustedActor = {
    serviceId: 'connect.projection',
    userId: actor.userId,
    features: [RETRACT_FEATURE],
  }

  // ── (2) Hide everything at the source, all-or-none ─────────
  let begun: { status: string }
  try {
    begun = await lifecycle.beginRetractionSaga({
      scope: sagaScope,
      actor: trustedActor,
      identityId: prepared.identityId,
      associationEpoch: prepared.epoch,
      inventory: prepared.inventory,
      reason: input.reason,
      idempotencyKey: prepared.sagaId,
    })
  } catch (err) {
    logger.warn('retraction begin failed; leaving the saga for recovery', { sagaId: prepared.sagaId, err })
    return { status: 'source_unavailable', sagaId: prepared.sagaId }
  }

  if (begun.status === 'inventory_conflict') {
    // The caller's view of the group drifted. Abort rather than hide a partial
    // set, and release the fence so the identity is usable again.
    await abortSaga(container, rootEm, lifecycle, sagaScope, trustedActor, prepared.identityId, now)
    return { status: 'inventory_conflict', sagaId: prepared.sagaId }
  }
  if (begun.status !== 'begun' && begun.status !== 'already_begun') {
    await abortSaga(container, rootEm, lifecycle, sagaScope, trustedActor, prepared.identityId, now)
    return { status: 'source_unavailable', sagaId: prepared.sagaId }
  }

  // ── (3) Clear locally and record the commit decision ───────
  const cleared = await rootEm.fork().transactional(async (tem) => {
    const em = tem as EntityManager
    const identity = await em.findOne(
      ConnectContactIdentity,
      { id: prepared.identityId, tenantId: actor.tenantId, organizationId: actor.organizationId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    const saga = await em.findOne(ConnectRetractionSaga, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      sagaId: prepared.sagaId,
      epoch: prepared.epoch,
    })
    // A newer fence means another unlink already took over; never clear it.
    if (!identity || !saga || identity.unlinkPendingSagaId !== prepared.sagaId) return false

    identity.customerKind = null
    identity.customerId = null
    identity.linkState = 'unresolved'
    identity.confidence = null
    identity.matchMethod = null
    identity.unlinkPendingSagaId = null
    identity.unlinkPendingEpoch = null

    // Every Case attached through this identity loses the association too —
    // clearing only the identity row is what left the exposure in place before.
    await em.execute(
      `update "connect_cases" set "customer_kind" = null, "customer_id" = null, "updated_at" = ?
        where "tenant_id" = ? and "organization_id" = ? and "customer_id" = ?
          and "id" in (
            select "case_id" from "connect_pending_projections"
             where "tenant_id" = ? and "identity_id" = ? and "association_epoch" = ?
          )`,
      [
        now,
        actor.tenantId,
        actor.organizationId,
        prepared.customerId,
        actor.tenantId,
        prepared.identityId,
        prepared.epoch,
      ],
    )

    em.persist(
      em.create(ConnectIdentityLinkAudit, {
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
        identityId: prepared.identityId,
        action: 'unlink',
        actorUserId: actor.userId,
        fromCustomerKind: prepared.customerKind,
        fromCustomerId: prepared.customerId,
        toCustomerKind: null,
        toCustomerId: null,
        reason: input.reason,
      }),
    )

    // The identity is unresolved again, so it needs a human.
    const openTask = await em.findOne(ConnectManualMatchTask, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      identityId: prepared.identityId,
      status: 'open',
    })
    if (!openTask) {
      em.persist(
        em.create(ConnectManualMatchTask, {
          tenantId: actor.tenantId,
          organizationId: actor.organizationId,
          identityId: prepared.identityId,
          status: 'open',
          sourceEventId: `unlink:${prepared.sagaId}`,
        }),
      )
    }

    for (const projection of prepared.projections) {
      em.persist(
        em.create(ConnectPendingRetraction, {
          tenantId: actor.tenantId,
          organizationId: actor.organizationId,
          sagaId: prepared.sagaId,
          caseId: projection.caseId,
          identityId: prepared.identityId,
          projectionKey: projection.projectionKey,
          formerCustomerKind: prepared.customerKind,
          formerCustomerId: prepared.customerId,
          status: 'pending',
        }),
      )
    }

    saga.decision = 'commit'
    saga.phase = 'finalizing'
    await em.flush()
    return true
  })

  if (!cleared) {
    await abortSaga(container, rootEm, lifecycle, sagaScope, trustedActor, prepared.identityId, now)
    return { status: 'source_unavailable', sagaId: prepared.sagaId }
  }

  // ── (4) Publish the commit; finalize drains asynchronously ──
  try {
    await lifecycle.commitRetractionSaga({ scope: sagaScope, actor: trustedActor })
  } catch (err) {
    // The local decision is already durable, so recovery replays this.
    logger.warn('commit publish failed; recovery will replay it', { sagaId: prepared.sagaId, err })
  }

  const em = rootEm.fork()
  stageDomainEvent(em, {
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
    sourceEventId: `connect.projection.status_changed:unlink:${prepared.sagaId}`,
    aggregateId: prepared.identityId,
    aggregateVersion: prepared.epoch,
    eventType: 'connect.projection.status_changed',
    payload: {
      identityId: prepared.identityId,
      action: 'unlink',
      sagaId: prepared.sagaId,
      fromStatus: 'linked',
      toStatus: 'unresolved',
      occurredAt: now.toISOString(),
    },
  })
  await em.flush()

  return {
    status: 'unlinked',
    identityId: prepared.identityId,
    sagaId: prepared.sagaId,
    retractedCount: prepared.projections.length,
  }
}

function compareKeys(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1
}

/**
 * Abort: record the decision, tell the source, then release the fence.
 *
 * That order matters. Releasing the fence first would let a new link start
 * while the source still believes the inventory is hidden.
 */
async function abortSaga(
  _container: ContainerLike,
  rootEm: EntityManager,
  lifecycle: InteractionLifecycleLike,
  sagaScope: Record<string, unknown>,
  trustedActor: Record<string, unknown>,
  identityId: string,
  now: Date,
): Promise<void> {
  const em = rootEm.fork()
  const saga = await em.findOne(ConnectRetractionSaga, {
    tenantId: sagaScope.tenantId as string,
    organizationId: sagaScope.organizationId as string,
    sagaId: sagaScope.sagaId as string,
    epoch: sagaScope.epoch as number,
  })
  if (saga && saga.decision === 'undecided') {
    saga.decision = 'abort'
    saga.phase = 'aborted'
    saga.completedAt = now
    await em.flush()
  }

  try {
    await lifecycle.abortRetractionSaga({ scope: sagaScope, actor: trustedActor })
  } catch (err) {
    logger.warn('abort publish failed; recovery will replay it', { sagaId: sagaScope.sagaId, err })
    return
  }

  const fenceEm = rootEm.fork()
  const identity = await fenceEm.findOne(ConnectContactIdentity, {
    id: identityId,
    tenantId: sagaScope.tenantId as string,
    organizationId: sagaScope.organizationId as string,
  })
  // Clear ONLY the matching fence: a newer unlink must not be released by an
  // older one's abort.
  if (identity && identity.unlinkPendingSagaId === sagaScope.sagaId) {
    identity.unlinkPendingSagaId = null
    identity.unlinkPendingEpoch = null
    await fenceEm.flush()
  }
}

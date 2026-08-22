import type { EntityManager } from '@mikro-orm/postgresql'
import {
  ConnectCase,
  ConnectContactIdentity,
  ConnectPendingProjection,
} from '../data/entities'
import { buildProjectionKey } from '../lib/projection-key'

/**
 * Stage a Customer-timeline projection when a Case is resolved.
 *
 * The row is written even when the identity is still UNRESOLVED: it waits in
 * `pending` until a link supplies a customer, and the drain worker picks it up
 * then. Skipping unresolved work here would mean a Case resolved before its
 * identity was matched never reaches the timeline at all.
 *
 * The projection key is deterministic, so a redelivered event upserts the same
 * row rather than staging a second timeline entry.
 */
export const metadata = {
  event: 'connect.case.resolved',
  persistent: true,
  id: 'connect:case-resolved-projection',
}

type SubscriberContext = { resolve: <T = unknown>(name: string) => T }

type Payload = {
  caseId?: string
  tenantId?: string
  organizationId?: string
}

export default async function handler(payload: Payload, ctx: SubscriberContext): Promise<void> {
  if (
    typeof payload?.caseId !== 'string' ||
    typeof payload?.tenantId !== 'string' ||
    typeof payload?.organizationId !== 'string'
  ) {
    return
  }

  const em = (ctx.resolve('em') as EntityManager).fork()
  const target = await em.findOne(ConnectCase, {
    id: payload.caseId,
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    deletedAt: null,
  })
  if (!target) return

  const identity = await em.findOne(ConnectContactIdentity, {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    customerId: target.customerId ?? null,
  })
  const associationEpoch = identity?.associationEpoch ?? 0
  const projectionVersion = associationEpoch + 1
  const projectionKey = buildProjectionKey(target.id, projectionVersion)

  const existing = await em.findOne(ConnectPendingProjection, {
    tenantId: payload.tenantId,
    projectionKey,
  })
  if (existing) return

  em.persist(
    em.create(ConnectPendingProjection, {
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      caseId: target.id,
      identityId: identity?.id ?? null,
      customerKind: target.customerKind ?? null,
      customerId: target.customerId ?? null,
      projectionKey,
      projectionVersion,
      associationEpoch,
      status: 'pending',
    }),
  )
  try {
    await em.flush()
  } catch {
    // The deterministic-key unique index rejected a concurrent insert; the
    // winner staged the same projection.
  }
}

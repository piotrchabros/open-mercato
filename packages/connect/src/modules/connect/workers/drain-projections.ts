import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  ConnectCase,
  ConnectContactIdentity,
  ConnectPendingProjection,
} from '../data/entities'
import { CONNECT_PROJECTION_NAMESPACE } from '../lib/projection-key'
import { CONNECT_QUEUES } from '../lib/queue'

const logger = createLogger('connect').child({ component: 'drain-projections' })

/**
 * Materialize staged projections onto the Customer timeline.
 *
 * Connect never writes customer tables. It calls the source-owned lifecycle
 * contract with a DETERMINISTIC source key, so a retry is recognised as the
 * same projection rather than creating a second timeline entry.
 *
 * The unlink fence is re-checked under the identity lock immediately before the
 * peer call. A projection admitted while an unlink is in flight would fall
 * outside the inventory that saga already committed to, and would survive the
 * retraction it should have been part of — so it waits instead.
 */
export const metadata: WorkerMeta = {
  queue: CONNECT_QUEUES.projectionDrain,
  id: 'connect:drain-projections',
  concurrency: 2,
}

export const CONNECT_PROJECTION_BATCH_SIZE = 25
export const CONNECT_PROJECTION_LEASE_MS = 5 * 60 * 1000
export const CONNECT_PROJECTION_MAX_ATTEMPTS = 10

type HandlerContext = JobContext & { resolve: <T = unknown>(name: string) => T }

type InteractionLifecycleLike = {
  createInteraction: (input: Record<string, unknown>) => Promise<{ status: string }>
}

const RETRACT_FEATURE = 'customers.interactions.retract'

export default async function handle(
  _job: QueuedJob<Record<string, unknown>>,
  ctx: HandlerContext,
): Promise<void> {
  const rootEm = ctx.resolve<EntityManager>('em').fork()
  const now = new Date()
  const leaseExpiresAt = new Date(now.getTime() + CONNECT_PROJECTION_LEASE_MS)

  const claimed = (await rootEm.execute(
    `update "connect_pending_projections"
        set "lease_expires_at" = ?, "attempts" = "attempts" + 1, "updated_at" = ?
      where "id" in (
        select "id" from "connect_pending_projections"
         where "status" = 'pending'
           and "customer_id" is not null
           and ("lease_expires_at" is null or "lease_expires_at" < ?)
         order by "created_at" asc
         limit ?
         for update skip locked
      )
      returning "id"`,
    [leaseExpiresAt, now, now, CONNECT_PROJECTION_BATCH_SIZE],
  )) as Array<{ id: string }>

  let lifecycle: InteractionLifecycleLike
  try {
    lifecycle = ctx.resolve<InteractionLifecycleLike>('customersInteractionLifecycle')
  } catch {
    logger.warn('customers interaction lifecycle unavailable; projections stay pending')
    return
  }

  for (const row of claimed) {
    await drainOne(rootEm.fork(), lifecycle, row.id, now)
  }
}

async function drainOne(
  em: EntityManager,
  lifecycle: InteractionLifecycleLike,
  projectionId: string,
  now: Date,
): Promise<void> {
  const projection = await em.findOne(ConnectPendingProjection, { id: projectionId })
  if (!projection || projection.status !== 'pending') return
  if (!projection.customerId || !projection.customerKind || !projection.identityId) return

  // Re-check the fence under the identity lock, immediately before the peer
  // call. Anything admitted after an unlink began would escape its inventory.
  const identity = await em.findOne(
    ConnectContactIdentity,
    { id: projection.identityId, tenantId: projection.tenantId },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  )
  if (!identity) return
  if (identity.unlinkPendingSagaId) {
    // Release the lease and wait; the saga decides first.
    projection.leaseExpiresAt = null
    await em.flush()
    return
  }
  // The association changed since the row was staged, so this projection is for
  // a link that no longer exists.
  if (identity.associationEpoch !== projection.associationEpoch) {
    projection.status = 'superseded'
    projection.leaseExpiresAt = null
    await em.flush()
    return
  }

  const target = await em.findOne(ConnectCase, {
    id: projection.caseId,
    tenantId: projection.tenantId,
    organizationId: projection.organizationId,
  })
  if (!target) {
    projection.status = 'superseded'
    projection.leaseExpiresAt = null
    await em.flush()
    return
  }

  const result = await lifecycle
    .createInteraction({
      scope: { tenantId: projection.tenantId, organizationId: projection.organizationId },
      actor: { serviceId: 'connect.projection', userId: null, features: [RETRACT_FEATURE] },
      customer: { kind: projection.customerKind, id: projection.customerId },
      namespace: CONNECT_PROJECTION_NAMESPACE,
      sourceKey: projection.projectionKey,
      identityId: projection.identityId,
      associationEpoch: projection.associationEpoch,
      payload: {
        interactionType: 'connect_case',
        // The masked label, never the subject: a timeline entry is read by
        // anyone with customer access.
        title: target.displayLabel,
        body: null,
        occurredAt: target.resolvedAt ?? now,
        channelProviderKey: null,
      },
    })
    .catch((err: unknown) => {
      logger.warn('projection create failed', { projectionKey: projection.projectionKey, err })
      return { status: 'error' }
    })

  if (result.status === 'created' || result.status === 'duplicate') {
    projection.status = 'projected'
    projection.projectedAt = now
    projection.lastError = null
  } else if (result.status === 'customer_missing' || result.status === 'conflict') {
    // Definitive: retrying cannot make a deleted customer reappear, and a
    // payload conflict means this key already means something else.
    projection.status = 'failed'
    projection.lastError = result.status
  } else if (projection.attempts >= CONNECT_PROJECTION_MAX_ATTEMPTS) {
    projection.status = 'failed'
    projection.lastError = 'attempts_exhausted'
  } else {
    projection.lastError = result.status
  }
  projection.leaseExpiresAt = null
  await em.flush()
}

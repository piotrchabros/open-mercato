import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ConnectPendingRetraction, ConnectRetractionSaga } from '../data/entities'
import { CONNECT_PROJECTION_NAMESPACE } from '../lib/projection-key'
import { CONNECT_QUEUES } from '../lib/queue'

const logger = createLogger('connect').child({ component: 'finalize-retractions' })

/**
 * Turn source-hidden interactions into tombstones.
 *
 * By the time a job reaches here the customer's timeline is ALREADY clear —
 * `beginRetractionSaga` hid the whole inventory before Connect cleared its own
 * associations. Finalizing is the bookkeeping that makes the hide permanent, so
 * a delay here is an operational lag, never a disclosure.
 *
 * It only ever runs for a saga whose decision is `commit`. Finalizing an
 * undecided or aborted saga would tombstone interactions the coordinator may
 * still restore.
 */
export const metadata: WorkerMeta = {
  queue: CONNECT_QUEUES.projectionDrain,
  id: 'connect:finalize-retractions',
  concurrency: 1,
}

export const CONNECT_RETRACTION_BATCH_SIZE = 50
export const CONNECT_RETRACTION_LEASE_MS = 5 * 60 * 1000
export const CONNECT_RETRACTION_MAX_ATTEMPTS = 10

type HandlerContext = JobContext & { resolve: <T = unknown>(name: string) => T }

type InteractionLifecycleLike = {
  finalizeRetractionSaga: (input: Record<string, unknown>) => Promise<{ status: string }>
}

const RETRACT_FEATURE = 'customers.interactions.retract'

export default async function handle(
  _job: QueuedJob<Record<string, unknown>>,
  ctx: HandlerContext,
): Promise<void> {
  const em = ctx.resolve<EntityManager>('em').fork()
  const now = new Date()
  const leaseExpiresAt = new Date(now.getTime() + CONNECT_RETRACTION_LEASE_MS)

  const claimed = (await em.execute(
    `update "connect_pending_retractions"
        set "lease_expires_at" = ?, "attempts" = "attempts" + 1, "updated_at" = ?
      where "id" in (
        select "id" from "connect_pending_retractions"
         where "status" = 'pending'
           and ("lease_expires_at" is null or "lease_expires_at" < ?)
         order by "created_at" asc
         limit ?
         for update skip locked
      )
      returning "id"`,
    [leaseExpiresAt, now, now, CONNECT_RETRACTION_BATCH_SIZE],
  )) as Array<{ id: string }>
  if (claimed.length === 0) return

  let lifecycle: InteractionLifecycleLike
  try {
    lifecycle = ctx.resolve<InteractionLifecycleLike>('customersInteractionLifecycle')
  } catch {
    logger.warn('customers interaction lifecycle unavailable; retractions stay pending and hidden')
    return
  }

  // Group by saga: finalize is a per-saga operation at the source, so calling it
  // once per row would be N identical calls.
  const rows = await em.find(ConnectPendingRetraction, { id: { $in: claimed.map((row) => row.id) } })
  const bySaga = new Map<string, ConnectPendingRetraction[]>()
  for (const row of rows) {
    const bucket = bySaga.get(row.sagaId) ?? []
    bucket.push(row)
    bySaga.set(row.sagaId, bucket)
  }

  for (const [sagaId, bucket] of bySaga) {
    const saga = await em.findOne(ConnectRetractionSaga, { tenantId: bucket[0].tenantId, sagaId })
    if (!saga) {
      // Nothing to finalize against. Leave the rows pending rather than
      // inventing a terminal state for work whose saga we cannot see.
      for (const row of bucket) row.leaseExpiresAt = null
      continue
    }
    // Only a committed saga may finalize: an undecided or aborted one may still
    // have its hidden interactions restored.
    if (saga.decision !== 'commit') {
      for (const row of bucket) row.leaseExpiresAt = null
      continue
    }

    const result = await lifecycle
      .finalizeRetractionSaga({
        scope: {
          tenantId: saga.tenantId,
          organizationId: saga.organizationId,
          namespace: CONNECT_PROJECTION_NAMESPACE,
          sagaId: saga.sagaId,
          epoch: saga.epoch,
        },
        actor: { serviceId: 'connect.projection', userId: null, features: [RETRACT_FEATURE] },
      })
      .catch((err: unknown) => {
        logger.warn('retraction finalize failed', { sagaId, err })
        return { status: 'error' }
      })

    const settled = result.status === 'finalized' || result.status === 'already_finalized'
    for (const row of bucket) {
      if (settled) {
        row.status = 'finalized'
        row.finalizedAt = now
        row.lastError = null
      } else if (row.attempts >= CONNECT_RETRACTION_MAX_ATTEMPTS) {
        // Terminal for automation, and loud: the interactions stay HIDDEN at the
        // source, so this is an operational alert rather than an exposure.
        row.status = 'failed'
        row.lastError = 'attempts_exhausted'
        logger.error('retraction finalize exhausted its attempts; interactions remain hidden', {
          sagaId,
          projectionKey: row.projectionKey,
        })
      } else {
        row.lastError = result.status
      }
      row.leaseExpiresAt = null
    }

    if (settled) {
      saga.phase = 'completed'
      saga.completedAt = now
    }
  }

  await em.flush()
}

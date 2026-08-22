import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ConnectContactIdentity, ConnectRetractionSaga } from '../data/entities'
import { CONNECT_PROJECTION_NAMESPACE } from '../lib/projection-key'
import { CONNECT_QUEUES } from '../lib/queue'

const logger = createLogger('connect').child({ component: 'recover-retraction-sagas' })

/**
 * Converge an unlink saga after a lost acknowledgement or a coordinator crash.
 *
 * It never guesses. It asks the SOURCE what it already recorded
 * (`listRetractions`) and reconciles to that, because the two systems' ledgers
 * are the only evidence — inferring a decision from a missing HTTP response is
 * exactly how a customer's timeline ends up half-cleared.
 *
 * The identity fence is only ever cleared for the MATCHING saga and epoch: a
 * newer unlink must not be released by an older one's recovery.
 */
export const metadata: WorkerMeta = {
  queue: CONNECT_QUEUES.projectionRecovery,
  id: 'connect:recover-retraction-sagas',
  concurrency: 1,
}

export const CONNECT_SAGA_RECOVERY_BATCH_SIZE = 25
export const CONNECT_SAGA_RECOVERY_LEASE_MS = 5 * 60 * 1000

type HandlerContext = JobContext & { resolve: <T = unknown>(name: string) => T }

type InteractionLifecycleLike = {
  listRetractions: (input: Record<string, unknown>) => Promise<{
    status: string
    decision?: 'commit' | 'abort' | null
    finalized?: boolean
    inventory?: string[]
  }>
  commitRetractionSaga: (input: Record<string, unknown>) => Promise<{ status: string }>
  abortRetractionSaga: (input: Record<string, unknown>) => Promise<{ status: string }>
}

const RETRACT_FEATURE = 'customers.interactions.retract'
const UNSETTLED_PHASES = ['pending_hide', 'committing', 'finalizing'] as const

export default async function handle(
  _job: QueuedJob<Record<string, unknown>>,
  ctx: HandlerContext,
): Promise<void> {
  const rootEm = ctx.resolve<EntityManager>('em').fork()
  const now = new Date()
  const leaseExpiresAt = new Date(now.getTime() + CONNECT_SAGA_RECOVERY_LEASE_MS)

  const claimed = (await rootEm.execute(
    `update "connect_retraction_sagas"
        set "lease_expires_at" = ?, "attempts" = "attempts" + 1, "updated_at" = ?
      where "id" in (
        select "id" from "connect_retraction_sagas"
         where "phase" = any(?)
           and ("lease_expires_at" is null or "lease_expires_at" < ?)
         order by "created_at" asc
         limit ?
         for update skip locked
      )
      returning "id"`,
    [leaseExpiresAt, now, [...UNSETTLED_PHASES], now, CONNECT_SAGA_RECOVERY_BATCH_SIZE],
  )) as Array<{ id: string }>
  if (claimed.length === 0) return

  let lifecycle: InteractionLifecycleLike
  try {
    lifecycle = ctx.resolve<InteractionLifecycleLike>('customersInteractionLifecycle')
  } catch {
    logger.warn('customers interaction lifecycle unavailable; sagas stay unsettled')
    return
  }

  for (const row of claimed) {
    await recoverOne(rootEm.fork(), lifecycle, row.id, now)
  }
}

async function recoverOne(
  em: EntityManager,
  lifecycle: InteractionLifecycleLike,
  sagaRowId: string,
  now: Date,
): Promise<void> {
  const saga = await em.findOne(ConnectRetractionSaga, { id: sagaRowId })
  if (!saga) return

  const scope = {
    tenantId: saga.tenantId,
    organizationId: saga.organizationId,
    namespace: CONNECT_PROJECTION_NAMESPACE,
    sagaId: saga.sagaId,
    epoch: saga.epoch,
  }
  const actor = { serviceId: 'connect.projection', userId: null, features: [RETRACT_FEATURE] }

  // Read the source ledger rather than inferring anything from our own gap.
  type SourceState = {
    status: string
    decision?: 'commit' | 'abort' | null
    finalized?: boolean
    inventory?: string[]
  }
  const sourceState: SourceState = await lifecycle
    .listRetractions({ scope, actor })
    .catch((): SourceState => ({ status: 'error' }))

  if (sourceState.status === 'error') {
    saga.leaseExpiresAt = null
    saga.lastError = 'source_unreachable'
    await em.flush()
    return
  }

  if (sourceState.status === 'missing') {
    // The source never saw a begin, so nothing is hidden there. Abort locally
    // and release the fence; there is no hidden inventory to restore.
    saga.decision = 'abort'
    saga.phase = 'aborted'
    saga.completedAt = now
    saga.leaseExpiresAt = null
    await em.flush()
    await clearMatchingFence(em, saga)
    return
  }

  // The source already decided. Adopt its decision — it is the ledger that
  // governs what the customer can see.
  if (sourceState.decision === 'abort') {
    saga.decision = 'abort'
    saga.phase = 'aborted'
    saga.completedAt = now
    saga.leaseExpiresAt = null
    await em.flush()
    await clearMatchingFence(em, saga)
    return
  }

  if (saga.decision === 'commit' || sourceState.decision === 'commit') {
    // Republish the commit: a lost acknowledgement is the common case, and the
    // source operation is idempotent.
    if (sourceState.decision !== 'commit') {
      await lifecycle.commitRetractionSaga({ scope, actor }).catch((err: unknown) => {
        logger.warn('commit republish failed; will retry', { sagaId: saga.sagaId, err })
        return { status: 'error' }
      })
    }
    saga.phase = sourceState.finalized ? 'completed' : 'finalizing'
    if (sourceState.finalized) saga.completedAt = now
    saga.leaseExpiresAt = null
    await em.flush()
    await clearMatchingFence(em, saga)
    return
  }

  // Hidden at the source but undecided on both sides: the coordinator died
  // between begin and commit. Abort is the safe convergence — it restores the
  // customer's timeline rather than tombstoning on the strength of an
  // intention nobody recorded.
  await lifecycle.abortRetractionSaga({ scope, actor }).catch((err: unknown) => {
    logger.warn('abort republish failed; will retry', { sagaId: saga.sagaId, err })
    return { status: 'error' }
  })
  saga.decision = 'abort'
  saga.phase = 'aborted'
  saga.completedAt = now
  saga.leaseExpiresAt = null
  await em.flush()
  await clearMatchingFence(em, saga)
}

/**
 * Release the identity fence, but only if it still belongs to this saga.
 *
 * A newer unlink may have started since; clearing its fence here would let a
 * link slip in while that saga's inventory is still open.
 */
async function clearMatchingFence(em: EntityManager, saga: ConnectRetractionSaga): Promise<void> {
  const fenceEm = em.fork()
  const identity = await fenceEm.findOne(
    ConnectContactIdentity,
    { id: saga.identityId, tenantId: saga.tenantId, organizationId: saga.organizationId },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  )
  if (!identity) return
  if (identity.unlinkPendingSagaId !== saga.sagaId) return
  if (identity.unlinkPendingEpoch !== saga.epoch) return
  identity.unlinkPendingSagaId = null
  identity.unlinkPendingEpoch = null
  await fenceEm.flush()
}

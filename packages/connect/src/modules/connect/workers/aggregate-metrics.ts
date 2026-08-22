import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { enumerateDays, rebuildDay, unreconciledCount } from '../lib/metrics-aggregate'
import { CONNECT_QUEUES } from '../lib/queue'

const logger = createLogger('connect').child({ component: 'aggregate-metrics' })

/**
 * Recompute daily aggregates.
 *
 * Two triggers, one code path:
 *
 *   - The scheduled sweep rebuilds a trailing window, not just yesterday. A
 *     delivery outcome confirmed three days late must land in its enqueue
 *     cohort, and rebuilding only the newest day would leave that cohort
 *     permanently wrong.
 *   - An explicit rebuild job names its own organization and range.
 *
 * Because a day's row is a pure function of that day's facts, running this
 * twice is indistinguishable from running it once. That is what lets the sweep
 * be aggressive about re-covering old days instead of trying to detect which
 * ones changed.
 */
export const metadata: WorkerMeta = {
  queue: CONNECT_QUEUES.metricsAggregate,
  id: 'connect:aggregate-metrics',
  concurrency: 1,
}

/**
 * How far back a scheduled sweep re-covers. Wide enough to absorb a delivery
 * outcome or a projection that settles days later; bounded so the sweep cost
 * does not grow with history.
 */
export const CONNECT_METRICS_REBUILD_WINDOW_DAYS = 7

type HandlerContext = JobContext & { resolve: <T = unknown>(name: string) => T }

type JobPayload = {
  tenantId?: string
  organizationId?: string
  from?: string
  to?: string
  /** Present only for an operator-triggered rebuild. */
  operationId?: string | null
}

type ProgressContext = { tenantId: string; organizationId?: string | null; userId?: string | null }

type ProgressServiceLike = {
  startJob: (jobId: string, ctx: ProgressContext) => Promise<unknown>
  incrementProgress: (jobId: string, delta: number, ctx: ProgressContext) => Promise<unknown>
  completeJob: (jobId: string, input: undefined, ctx: ProgressContext) => Promise<unknown>
  failJob: (jobId: string, input: { errorMessage: string }, ctx: ProgressContext) => Promise<unknown>
  isCancellationRequested: (
    jobId: string,
    tenantId: string,
    organizationId?: string | null,
  ) => Promise<boolean>
}

function shiftDays(day: string, delta: number): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + delta * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

export default async function handle(
  job: QueuedJob<JobPayload>,
  ctx: HandlerContext,
): Promise<void> {
  const em = (ctx.resolve<EntityManager>('em')).fork()
  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const payload = (job?.payload ?? {}) as JobPayload

  const to = payload.to ?? today
  const from = payload.from ?? shiftDays(today, -CONNECT_METRICS_REBUILD_WINDOW_DAYS)
  const days = enumerateDays(from, to)
  if (days.length === 0) {
    logger.warn('metrics rebuild received an empty or inverted range', { from, to })
    return
  }

  // Discover the scopes that actually have facts in the window. Enumerating
  // organizations from elsewhere would either miss a new one or generate empty
  // rows for organizations that never used Connect.
  const scopes = (await em.execute(
    `select distinct "tenant_id" as "tenantId", "organization_id" as "organizationId"
       from "connect_operational_facts"
      where "cohort_utc_date" >= ? and "cohort_utc_date" <= ?
        ${payload.tenantId ? 'and "tenant_id" = ?' : ''}
        ${payload.organizationId ? 'and "organization_id" = ?' : ''}`,
    [
      from,
      to,
      ...(payload.tenantId ? [payload.tenantId] : []),
      ...(payload.organizationId ? [payload.organizationId] : []),
    ],
  )) as Array<{ tenantId: string; organizationId: string }>

  // Progress is best-effort throughout. A missing or broken progress service
  // must not stop an aggregation the operator is waiting on — it only costs
  // them the progress bar.
  let progress: ProgressServiceLike | null = null
  const progressCtx: ProgressContext | null =
    payload.operationId && payload.tenantId
      ? { tenantId: payload.tenantId, organizationId: payload.organizationId ?? null }
      : null
  if (payload.operationId && progressCtx) {
    try {
      progress = ctx.resolve<ProgressServiceLike>('progressService')
      await progress.startJob(payload.operationId, progressCtx)
    } catch (err) {
      logger.debug('progress service unavailable for this rebuild', { err })
      progress = null
    }
  }

  for (const scope of scopes) {
    for (const utcDate of days) {
      // Cancellation stops UNSTARTED days only. A day already rebuilt stays
      // rebuilt, because its row is correct either way.
      if (progress && payload.operationId && progressCtx) {
        const cancelled = await progress
          .isCancellationRequested(payload.operationId, progressCtx.tenantId, progressCtx.organizationId)
          .catch(() => false)
        if (cancelled) {
          logger.warn('metrics rebuild cancelled by the operator', { operationId: payload.operationId })
          return
        }
      }
      const totals = await rebuildDay(em.fork(), { ...scope, utcDate }, now)
      const unreconciled = unreconciledCount(totals)
      // A complete past day must reconcile exactly. Today is still in flight,
      // so an open receipt there is normal rather than a defect.
      if (unreconciled !== 0 && utcDate !== today) {
        logger.error('inbound reconciliation is non-zero for a complete day', {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          utcDate,
          unreconciled,
        })
      }
      if (totals.appliedCountLimit !== null && totals.observedMaxPermittedPerSender > totals.appliedCountLimit) {
        // The suppression bound was exceeded for at least one sender. Reported
        // with the hash withheld — the operator needs to know it happened, not
        // who it was.
        logger.error('a sender was permitted more inbound than the applied limit', {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          utcDate,
          observed: totals.observedMaxPermittedPerSender,
          limit: totals.appliedCountLimit,
        })
      }
      if (progress && payload.operationId && progressCtx) {
        await progress.incrementProgress(payload.operationId, 1, progressCtx).catch(() => undefined)
      }
    }
  }

  if (progress && payload.operationId && progressCtx) {
    await progress.completeJob(payload.operationId, undefined, progressCtx).catch(() => undefined)
  }
}

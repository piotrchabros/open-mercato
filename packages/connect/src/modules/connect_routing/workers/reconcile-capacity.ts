import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { reconcileCapacityPayloadSchema } from '../data/validators'
import { CONNECT_ROUTING_QUEUES } from '../lib/queue'
import type { ConnectRoutingCapacityService } from '../lib/reconcile-capacity'

const logger = createLogger('connect_routing').child({ component: 'reconcile-capacity-worker' })

/**
 * Retry and deferral primitive for the capacity backfill.
 *
 * One job handles exactly one organization, and reconciliation recomputes
 * absolute counts, so a redelivered job is indistinguishable from a first
 * delivery. Concurrency 3 keeps the worker inside the queue package's 3–5
 * guidance and its connection budget while the work is database-bound.
 *
 * Phase 2 registers no recurring schedule for this queue. Freshness only means
 * something once routing consumes the numbers, so Phase 3 owns the cadence.
 */
export const metadata: WorkerMeta = {
  queue: CONNECT_ROUTING_QUEUES.capacityReconcile,
  id: 'connect-routing:reconcile-capacity',
  concurrency: 3,
}

type HandlerContext = JobContext & { resolve: <T = unknown>(name: string) => T }

export default async function handle(
  job: QueuedJob<unknown>,
  ctx: HandlerContext,
): Promise<void> {
  // Validated before anything is resolved or read. A job whose scope no longer
  // parses must fail here, not somewhere inside a scoped SQL predicate.
  const payload = reconcileCapacityPayloadSchema.parse(job?.payload ?? {})
  const service = ctx.resolve<ConnectRoutingCapacityService>('connectRoutingCapacityService')

  const result = await service.reconcile(payload)
  if (result.outcome === 'dependency_unavailable') {
    // Not thrown: retrying cannot conjure the reader back, and the checkpoint
    // already records why. An operator reruns once Connect is available.
    logger.warn('capacity reconciliation skipped; connect reader unavailable', {
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      errorCode: result.errorCode,
    })
  }
}

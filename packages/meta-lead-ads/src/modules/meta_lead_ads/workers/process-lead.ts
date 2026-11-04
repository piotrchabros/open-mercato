import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { MetaLeadEvent } from '../data/entities'
import { QUEUES, WORKER_IDS, type MetaScope } from '../lib/constants'
import { TransientLeadError } from '../lib/errors'
import { getMetaGraphClient, type MetaGraphClient } from '../lib/graph-client'
import { claimLeadEventForProcessing, processLeadEvent } from '../lib/lead-processor'
import { resolveJobScope, type ProcessLeadJob } from '../lib/queue'
import { applyTransientFailure } from '../lib/retry-policy'

const logger = createLogger('meta_lead_ads')

const MAX_ERROR_LENGTH = 500
const UNEXPECTED_ERROR_MESSAGE = '[internal] Unexpected processing error'
const INTERNAL_ERROR_MESSAGE = 'Lead processing failed unexpectedly'

export const metadata: WorkerMeta = {
  queue: QUEUES.process,
  id: WORKER_IDS.process,
  concurrency: 5,
}

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

function resolveGraphClient(ctx: HandlerContext): MetaGraphClient {
  try {
    return ctx.resolve<MetaGraphClient>('metaGraphClient')
  } catch {
    return getMetaGraphClient()
  }
}

function reportProcessingError(error: unknown, leadEventId: string): void {
  getTelemetryRuntime()?.reportError(error, {
    module: 'meta_lead_ads',
    code: 'meta_lead_ads.process_lead_failed',
    attributes: { leadEventId },
  })
}

async function markInternalFailure(em: EntityManager, leadEventId: string, scope: MetaScope): Promise<void> {
  try {
    await em.nativeUpdate(
      MetaLeadEvent,
      { id: leadEventId, tenantId: scope.tenantId, organizationId: scope.organizationId, status: 'processing' },
      {
        status: 'failed',
        lastErrorCode: 'unknown',
        lastError: INTERNAL_ERROR_MESSAGE.slice(0, MAX_ERROR_LENGTH),
        updatedAt: new Date(),
      },
    )
  } catch {
    logger.error('meta_lead_ads failed to mark lead event as failed', { leadEventId })
  }
}

export default async function handle(job: QueuedJob<ProcessLeadJob>, ctx: HandlerContext): Promise<void> {
  const payload = job.payload
  const leadEventId = payload.leadEventId
  const scope = resolveJobScope(payload)
  if (!leadEventId || !scope) return
  const em = ctx.resolve<EntityManager>('em').fork()
  const claimed = await claimLeadEventForProcessing(em, leadEventId, scope)
  if (!claimed) return

  const container = { resolve: ctx.resolve }
  try {
    await processLeadEvent({ container, em, graph: resolveGraphClient(ctx) }, leadEventId, scope)
  } catch (error) {
    const transient = error instanceof TransientLeadError
      ? error
      : new TransientLeadError('unknown', UNEXPECTED_ERROR_MESSAGE, { cause: error })
    if (!(error instanceof TransientLeadError)) reportProcessingError(error, leadEventId)
    try {
      await applyTransientFailure({ resolve: ctx.resolve, em }, leadEventId, transient, scope)
    } catch (retryError) {
      reportProcessingError(retryError, leadEventId)
      await markInternalFailure(em, leadEventId, scope)
    }
  }
}

import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { ProgressService } from '@open-mercato/core/modules/progress/lib/progressService'
import { MetaForm, MetaPage, MetaSyncRun } from '../data/entities'
import { QUEUES, STUCK_EVENT_MS, WORKER_IDS, type MetaScope } from '../lib/constants'
import { importListedLeads } from '../lib/backfill'
import { MetaGraphError, getMetaGraphClient } from '../lib/graph-client'
import { applyGraphErrorSideEffects, describeGraphError } from '../lib/page-service'
import { enqueueBackfill, resolveJobScope, type BackfillJob } from '../lib/queue'
import { graphOptionsFromCredentials, resolveAppCredentials } from '../lib/preset'
import { decryptionScope } from '../lib/scope'

const logger = createLogger('meta_lead_ads')

const TRANSIENT_RETRY_DELAY_MS = 60_000
const PAGE_UNAVAILABLE_ERROR = 'The Page or form is no longer available for backfill'
const RETRY_WINDOW_EXCEEDED_ERROR = 'Meta did not respond in time; backfill stopped'

export const metadata: WorkerMeta = {
  queue: QUEUES.backfill,
  id: WORKER_IDS.backfill,
  concurrency: 1,
}

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

type ProgressContext = { tenantId: string; organizationId: string; userId: string | null }

async function runProgressStep(step: () => Promise<unknown>): Promise<void> {
  try {
    await step()
  } catch {
    logger.warn('meta_lead_ads backfill progress update failed')
  }
}

function resolveProgressService(ctx: HandlerContext): ProgressService | null {
  try {
    return ctx.resolve<ProgressService>('progressService')
  } catch {
    return null
  }
}

async function finishRun(
  em: EntityManager,
  run: MetaSyncRun,
  scope: MetaScope,
  outcome: { status: 'completed' | 'failed'; error: string | null },
): Promise<void> {
  await em.nativeUpdate(
    MetaSyncRun,
    { id: run.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
    { status: outcome.status, error: outcome.error, finishedAt: new Date() },
  )
}

export default async function handle(job: QueuedJob<BackfillJob>, ctx: HandlerContext): Promise<void> {
  const payload = job.payload
  const scope = resolveJobScope(payload)
  if (!scope) {
    logger.warn('meta_lead_ads backfill skipped: job has no scope')
    return
  }
  const em = ctx.resolve<EntityManager>('em').fork()
  const decryption = decryptionScope(scope)
  const run = await em.findOne(MetaSyncRun, {
    id: payload.runId,
    kind: 'backfill',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    deletedAt: null,
  })
  if (!run || run.status !== 'running') return

  const progressService = payload.progressJobId ? resolveProgressService(ctx) : null
  const progressContext: ProgressContext = { ...scope, userId: null }
  const progressJobId = payload.progressJobId
  const failRun = async (error: string): Promise<void> => {
    await finishRun(em, run, scope, { status: 'failed', error })
    if (progressService && progressJobId) {
      await runProgressStep(() => progressService.failJob(progressJobId, { errorMessage: error }, progressContext))
    }
  }

  const form = await findOneWithDecryption(
    em,
    MetaForm,
    { id: payload.formId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    undefined,
    decryption,
  )
  const page = form
    ? await findOneWithDecryption(
        em,
        MetaPage,
        { id: form.pageId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
        undefined,
        decryption,
      )
    : null
  const pageToken = page?.pageAccessToken?.trim()
  if (!form || !page || !pageToken) {
    await failRun(PAGE_UNAVAILABLE_ERROR)
    return
  }

  if (!payload.after && progressService && progressJobId) {
    await runProgressStep(() => progressService.startJob(progressJobId, progressContext))
  }

  try {
    const credentials = await resolveAppCredentials({ resolve: ctx.resolve }, scope)
    const fromMs = run.rangeFrom.getTime()
    const toMs = run.rangeTo.getTime()
    const result = await getMetaGraphClient().listFormLeads({
      metaFormId: form.metaFormId,
      pageToken,
      fromUnix: Math.floor(fromMs / 1000) - 1,
      toUnix: Math.ceil(toMs / 1000) + 1,
      after: payload.after ?? null,
    }, graphOptionsFromCredentials(credentials))
    const imported = await importListedLeads({ em, page, form, leads: result.leads, source: 'backfill' })
    const checked = run.checked + imported.checked
    const importedTotal = run.imported + imported.imported
    const duplicates = run.duplicates + imported.duplicates
    await em.nativeUpdate(
      MetaSyncRun,
      { id: run.id, tenantId: scope.tenantId, organizationId: scope.organizationId },
      { checked, imported: importedTotal, duplicates },
    )
    run.checked = checked
    run.imported = importedTotal
    run.duplicates = duplicates
    if (progressService && progressJobId) {
      await runProgressStep(() =>
        progressService.updateProgress(
          progressJobId,
          { processedCount: checked, meta: { checked, imported: importedTotal, duplicates } },
          progressContext,
        ),
      )
    }

    if (result.paging.hasNext && result.paging.after) {
      await enqueueBackfill({ ...payload, tenantId: scope.tenantId, organizationId: scope.organizationId, after: result.paging.after })
      return
    }

    await finishRun(em, run, scope, { status: 'completed', error: null })
    if (progressService && progressJobId) {
      await runProgressStep(() =>
        progressService.completeJob(
          progressJobId,
          { resultSummary: { checked, imported: importedTotal, duplicates } },
          progressContext,
        ),
      )
    }
  } catch (error) {
    if (!(error instanceof MetaGraphError)) throw error
    if (error.classification.permanent) {
      await applyGraphErrorSideEffects({ em, resolve: ctx.resolve }, { page }, error.classification)
      await failRun(describeGraphError(error.classification))
      return
    }
    if (Date.now() - run.startedAt.getTime() > STUCK_EVENT_MS) {
      await failRun(RETRY_WINDOW_EXCEEDED_ERROR)
      return
    }
    await enqueueBackfill(
      { ...payload, tenantId: scope.tenantId, organizationId: scope.organizationId },
      { delayMs: TRANSIENT_RETRY_DELAY_MS },
    )
  }
}

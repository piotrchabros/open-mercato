import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { MetaForm, MetaLeadEvent, MetaPage, MetaSyncRun } from '../data/entities'
import { importListedLeads } from '../lib/backfill'
import {
  GRAPH_PAGE_LIMIT,
  QUEUES,
  RECONCILE_WINDOW_MS,
  STUCK_EVENT_MS,
  WORKER_IDS,
  type MetaLeadEventStatus,
  type MetaScope,
} from '../lib/constants'
import { MetaGraphError, type GraphCallOptions, type MetaGraphClient } from '../lib/graph-client'
import { applyGraphErrorSideEffects } from '../lib/page-service'
import { graphOptionsFromCredentials, resolveAppCredentials } from '../lib/preset'
import { enqueueProcessLead, resolveJobScope, type ScopedJob } from '../lib/queue'
import { decryptionScope } from '../lib/scope'

const logger = createLogger('meta_lead_ads')

const MAX_LEAD_PAGES_PER_FORM = 50
const SWEEP_BATCH = 500
const MAX_SWEEP_BATCHES = 100
const STUCK_STATUSES: MetaLeadEventStatus[] = ['received', 'processing', 'retrying']
const RECONCILE_FAILED_ERROR = 'Reconciliation failed'

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

type ReconcileCounters = { checked: number; imported: number; duplicates: number; failed: number }

type ReconcileDeps = {
  ctx: HandlerContext
  em: EntityManager
  graph: MetaGraphClient
  graphOptions: GraphCallOptions
  scope: MetaScope
  fromUnix: number
  toUnix: number
}

export const metadata: WorkerMeta = {
  queue: QUEUES.reconcile,
  id: WORKER_IDS.reconcile,
  concurrency: 1,
}

async function reconcileForm(
  deps: ReconcileDeps,
  page: MetaPage,
  pageToken: string,
  form: MetaForm,
  counters: ReconcileCounters,
): Promise<void> {
  let after: string | null = null
  for (let iteration = 0; iteration < MAX_LEAD_PAGES_PER_FORM; iteration += 1) {
    const listed = await deps.graph.listFormLeads(
      {
        metaFormId: form.metaFormId,
        pageToken,
        fromUnix: deps.fromUnix,
        toUnix: deps.toUnix,
        after,
        limit: GRAPH_PAGE_LIMIT,
      },
      deps.graphOptions,
    )
    const imported = await importListedLeads({
      em: deps.em,
      page,
      form,
      leads: listed.leads,
      source: 'reconciliation',
    })
    counters.checked += imported.checked
    counters.imported += imported.imported
    counters.duplicates += imported.duplicates
    if (!listed.paging.hasNext || !listed.paging.after) return
    after = listed.paging.after
  }
}

async function reconcilePage(
  deps: ReconcileDeps,
  page: MetaPage,
  forms: MetaForm[],
  counters: ReconcileCounters,
): Promise<void> {
  const pageToken = page.pageAccessToken?.trim()
  if (!pageToken) {
    counters.failed += forms.length
    logger.warn('meta_lead_ads reconcile skipped a page without an access token', { pageId: page.id })
    return
  }
  for (let index = 0; index < forms.length; index += 1) {
    try {
      await reconcileForm(deps, page, pageToken, forms[index], counters)
    } catch (error) {
      if (!(error instanceof MetaGraphError)) throw error
      counters.failed += forms.length - index
      logger.warn('meta_lead_ads reconcile Graph error, skipping the rest of the page', {
        pageId: page.id,
        errorClass: error.classification.errorClass,
      })
      await applyGraphErrorSideEffects(
        { em: deps.em, resolve: deps.ctx.resolve },
        { page, connectionId: page.connectionId },
        error.classification,
      )
      return
    }
  }
}

async function importRecentLeads(deps: ReconcileDeps, counters: ReconcileCounters): Promise<void> {
  const { em, scope } = deps
  const decryption = decryptionScope(scope)
  const pages = await findWithDecryption(
    em,
    MetaPage,
    { tenantId: scope.tenantId, organizationId: scope.organizationId, subscriptionStatus: 'active', deletedAt: null },
    undefined,
    decryption,
  )
  if (pages.length === 0) return
  const forms = await findWithDecryption(
    em,
    MetaForm,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      pageId: { $in: pages.map((page) => page.id) },
      isEnabled: true,
      deletedAt: null,
    },
    undefined,
    decryption,
  )
  for (const page of pages) {
    const pageForms = forms.filter((form) => form.pageId === page.id)
    if (pageForms.length === 0) continue
    await reconcilePage(deps, page, pageForms, counters)
  }
}

export async function sweepStuckLeadEvents(em: EntityManager, scope: MetaScope, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_EVENT_MS)
  const stuckFilter: FilterQuery<MetaLeadEvent> = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    status: { $in: STUCK_STATUSES },
    updatedAt: { $lt: cutoff },
    deletedAt: null,
  }
  let swept = 0
  for (let iteration = 0; iteration < MAX_SWEEP_BATCHES; iteration += 1) {
    const batch = await em
      .fork()
      .find(MetaLeadEvent, stuckFilter, { fields: ['id'], limit: SWEEP_BATCH, orderBy: { id: 'asc' } })
    if (batch.length === 0) break
    const ids = batch.map((row) => row.id)
    const affected = await em.nativeUpdate(
      MetaLeadEvent,
      { $and: [{ id: { $in: ids } }, stuckFilter] },
      { status: 'received', nextAttemptAt: null, updatedAt: new Date() },
    )
    for (const leadEventId of ids) {
      await enqueueProcessLead({ leadEventId, tenantId: scope.tenantId, organizationId: scope.organizationId })
    }
    swept += affected
    if (affected === 0 || batch.length < SWEEP_BATCH) break
  }
  return swept
}

export default async function handle(job: QueuedJob<ScopedJob>, ctx: HandlerContext): Promise<void> {
  const scope = resolveJobScope(job.payload)
  if (!scope) {
    logger.warn('meta_lead_ads reconcile job without scope ignored', { jobId: job.id })
    return
  }
  const em = ctx.resolve<EntityManager>('em').fork()
  const now = new Date()
  const rangeFrom = new Date(now.getTime() - RECONCILE_WINDOW_MS)
  const run = em.create(MetaSyncRun, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    kind: 'reconciliation',
    formId: null,
    rangeFrom,
    rangeTo: now,
  })
  await em.persist(run).flush()

  const counters: ReconcileCounters = { checked: 0, imported: 0, duplicates: 0, failed: 0 }
  try {
    const credentials = await resolveAppCredentials(ctx, scope)
    const deps: ReconcileDeps = {
      ctx,
      em,
      graph: ctx.resolve<MetaGraphClient>('metaGraphClient'),
      graphOptions: graphOptionsFromCredentials(credentials),
      scope,
      fromUnix: Math.floor(rangeFrom.getTime() / 1000),
      toUnix: Math.floor(now.getTime() / 1000),
    }
    await importRecentLeads(deps, counters)
    const swept = await sweepStuckLeadEvents(em, scope, now)
    Object.assign(run, counters, { status: 'completed', finishedAt: new Date() })
    await em.flush()
    logger.info('meta_lead_ads reconcile completed', {
      organizationId: scope.organizationId,
      ...counters,
      swept,
    })
  } catch (error) {
    Object.assign(run, counters, {
      status: 'failed',
      error: RECONCILE_FAILED_ERROR,
      finishedAt: new Date(),
    })
    await em.flush()
    logger.error('meta_lead_ads reconcile failed', {
      organizationId: scope.organizationId,
      errorName: error instanceof Error ? error.name : 'unknown',
    })
    throw error
  }
}

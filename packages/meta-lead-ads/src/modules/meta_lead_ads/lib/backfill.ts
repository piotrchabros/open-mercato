import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { ProgressService } from '@open-mercato/core/modules/progress/lib/progressService'
import { MetaForm, MetaPage, MetaSyncRun } from '../data/entities'
import type { BackfillInput, GraphLead } from '../data/validators'
import type { MetaLeadEventSource, MetaScope } from './constants'
import { insertLeadEvent } from './lead-events'
import { enqueueBackfill, enqueueProcessLead } from './queue'
import { decryptionScope } from './scope'

const logger = createLogger('meta_lead_ads')

export const BACKFILL_PROGRESS_JOB_TYPE = 'meta_lead_ads.backfill'

export type StartBackfillContext = {
  container: AwilixContainer
  em: EntityManager
  scope: MetaScope
  userId: string | null
}

export type StartBackfillResult = { runId: string; progressJobId: string | null }

export type ImportListedLeadsInput = {
  em: EntityManager
  page: MetaPage
  form: MetaForm
  leads: GraphLead[]
  source: Extract<MetaLeadEventSource, 'backfill' | 'reconciliation'>
}

export type ImportListedLeadsResult = { checked: number; imported: number; duplicates: number }

function backfillError(status: number, code: string, message: string): CrudHttpError {
  return new CrudHttpError(status, { error: message, code })
}

async function createProgressJob(
  container: AwilixContainer,
  scope: MetaScope,
  userId: string | null,
  form: MetaForm,
): Promise<string | null> {
  try {
    const progressService = container.resolve('progressService') as ProgressService
    const job = await progressService.createJob(
      {
        jobType: BACKFILL_PROGRESS_JOB_TYPE,
        name: `Meta lead backfill: ${form.name}`,
        cancellable: false,
        meta: { source: 'meta_lead_ads.backfill', formId: form.id },
      },
      { tenantId: scope.tenantId, organizationId: scope.organizationId, userId },
    )
    return job.id
  } catch (error) {
    logger.warn('meta_lead_ads backfill progress job could not be created', {
      errorName: error instanceof Error ? error.name : 'unknown',
    })
    return null
  }
}

export async function startBackfill(
  ctx: StartBackfillContext,
  input: BackfillInput,
): Promise<StartBackfillResult> {
  const { container, scope, userId } = ctx
  const em = ctx.em.fork()
  const decryption = decryptionScope(scope)
  const form = await findOneWithDecryption(
    em,
    MetaForm,
    { id: input.formId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    undefined,
    decryption,
  )
  if (!form) throw backfillError(404, 'form_not_found', 'Form not found')
  const page = await findOneWithDecryption(
    em,
    MetaPage,
    { id: form.pageId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    undefined,
    decryption,
  )
  if (!page || page.subscriptionStatus !== 'active') {
    throw backfillError(409, 'page_not_active', 'The Page is not active')
  }
  const run = await em.transactional(async (transaction) => {
    const lockedForm = await findOneWithDecryption(
      transaction,
      MetaForm,
      { id: form.id, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
      decryption,
    )
    if (!lockedForm) throw backfillError(404, 'form_not_found', 'Form not found')
    const running = await findOneWithDecryption(
      transaction,
      MetaSyncRun,
      {
        kind: 'backfill',
        formId: lockedForm.id,
        status: 'running',
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      },
      undefined,
      decryption,
    )
    if (running) throw backfillError(409, 'backfill_already_running', 'A backfill is already running for this form')
    const created = transaction.create(MetaSyncRun, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      kind: 'backfill',
      formId: lockedForm.id,
      rangeFrom: new Date(input.from),
      rangeTo: new Date(input.to),
      progressJobId: null,
    })
    await transaction.persist(created).flush()
    return created
  })

  const progressJobId = await createProgressJob(container, scope, userId, form)
  run.progressJobId = progressJobId
  await em.flush()

  try {
    await enqueueBackfill({
      runId: run.id,
      formId: form.id,
      from: input.from,
      to: input.to,
      after: null,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      progressJobId,
    })
  } catch (error) {
    run.status = 'failed'
    run.error = 'Backfill could not be queued'
    run.finishedAt = new Date()
    await em.flush()
    if (progressJobId) {
      try {
        const progressService = container.resolve('progressService') as ProgressService
        await progressService.failJob(
          progressJobId,
          { errorMessage: 'Backfill could not be queued' },
          { tenantId: scope.tenantId, organizationId: scope.organizationId, userId },
        )
      } catch {
        logger.warn('meta_lead_ads backfill progress job could not be failed')
      }
    }
    throw error
  }
  return { runId: run.id, progressJobId }
}

export async function importListedLeads(input: ImportListedLeadsInput): Promise<ImportListedLeadsResult> {
  const { em, page, form, leads, source } = input
  const result: ImportListedLeadsResult = { checked: 0, imported: 0, duplicates: 0 }
  for (const lead of leads) {
    result.checked += 1
    const submittedAtMs = Date.parse(lead.created_time)
    const inserted = await insertLeadEvent(em, {
      metaLeadId: lead.id,
      metaPageId: page.metaPageId,
      metaFormId: form.metaFormId,
      page,
      source,
      rawPayload: lead as Record<string, unknown>,
      submittedAt: Number.isNaN(submittedAtMs) ? null : new Date(submittedAtMs),
      adId: lead.ad_id ?? null,
      formId: form.id,
    })
    if (inserted.outcome === 'duplicate' || !inserted.leadEventId) {
      result.duplicates += 1
      continue
    }
    result.imported += 1
    await enqueueProcessLead({
      leadEventId: inserted.leadEventId,
      tenantId: page.tenantId,
      organizationId: page.organizationId,
    })
  }
  return result
}

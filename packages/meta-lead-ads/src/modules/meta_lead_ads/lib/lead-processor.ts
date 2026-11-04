import { UniqueConstraintViolationException } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { MetaConsent, MetaForm, MetaLeadEvent, MetaPage, type MetaFormQuestionRow } from '../data/entities'
import { graphLeadSchema, type GraphLead } from '../data/validators'
import {
  emitMetaLeadAdsEvent,
  META_LEAD_ADS_EVENTS,
  type LeadFailedPayload,
  type LeadReceivedPayload,
} from '../events'
import {
  EXTERNAL_ENTITY_TYPES,
  FIELD_MAPPING_MAX,
  INTEGRATION_ID,
  type MetaLeadErrorCode,
  type MetaLeadEventStatus,
  type MetaScope,
} from './constants'
import { writeLeadToCrm, type CrmWriteResult } from './crm-writer'
import {
  buildContactKeys,
  createDedupLookups,
  resolveDedupMatch,
  upsertPersonKeys,
  type DedupResult,
  type LeadContactKeys,
} from './dedup'
import { PermanentLeadError } from './errors'
import { MetaGraphError, toLeadError, type MetaGraphClient } from './graph-client'
import { CLAIMABLE_LEAD_EVENT_STATUSES, isLeadEventUniqueViolation } from './lead-events'
import {
  applyMapping,
  buildDefaultFieldMapping,
  computeQuestionsFingerprint,
  detectQuestionDrift,
  normalizePlatform,
  parseGraphTime,
} from './mapping'
import type { Resolver } from './notifier'
import { applyGraphErrorSideEffects } from './page-service'
import { normalizePhoneToE164 } from './phone'
import { graphOptionsFromCredentials, resolveAppCredentials } from './preset'
import { decryptionScope } from './scope'
import { getOrgSettings } from './settings'

const logger = createLogger('meta_lead_ads').child({ component: 'lead-processor' })

const MAX_ERROR_LENGTH = 500
const LAZY_QUESTION_TYPE = 'CUSTOM'
const AUDIT_COMMAND_ID = 'meta_lead_ads.lead.import'
const AUDIT_RESOURCE_KIND = 'meta_lead_ads.lead_event'

export type LeadProcessorDeps = {
  container: Resolver
  em: EntityManager
  graph: MetaGraphClient
  now?: () => Date
}

export type LeadProcessingResult = { status: MetaLeadEventStatus; errorCode?: MetaLeadErrorCode }

type ExternalIdMappingService = {
  storeExternalIdMapping(
    integrationId: string,
    entityType: string,
    localId: string,
    externalId: string,
    scope: { organizationId: string; tenantId: string },
  ): Promise<unknown>
}

type ActionLogService = {
  log(input: {
    tenantId: string
    organizationId: string
    actorUserId?: string | null
    commandId: string
    actionLabel?: string
    resourceKind?: string
    resourceId?: string
    context?: Record<string, unknown>
  }): Promise<unknown>
}

type LeadSourceFields = {
  adName: string | null
  adsetName: string | null
  campaignName: string | null
}

function tryResolve<T>(container: Resolver, name: string): T | null {
  try {
    return container.resolve<T>(name) ?? null
  } catch {
    return null
  }
}

function readOptionalString(lead: GraphLead, key: string): string | null {
  const value = (lead as Record<string, unknown>)[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function readSourceNames(lead: GraphLead): LeadSourceFields {
  return {
    adName: readOptionalString(lead, 'ad_name'),
    adsetName: readOptionalString(lead, 'adset_name'),
    campaignName: readOptionalString(lead, 'campaign_name'),
  }
}

function reportFailure(error: unknown, code: string, attributes: Record<string, string>): void {
  getTelemetryRuntime()?.reportError(error, { module: 'meta_lead_ads', code, attributes })
}

function loadScopedEvent(em: EntityManager, leadEventId: string, scope: MetaScope): Promise<MetaLeadEvent | null> {
  return findOneWithDecryption(
    em,
    MetaLeadEvent,
    { id: leadEventId, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    decryptionScope(scope),
  )
}

export async function claimLeadEventForProcessing(
  em: EntityManager,
  leadEventId: string,
  scope: MetaScope,
): Promise<MetaLeadEvent | null> {
  const affected = await em.nativeUpdate(
    MetaLeadEvent,
    {
      id: leadEventId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      status: { $in: [...CLAIMABLE_LEAD_EVENT_STATUSES] },
    },
    { status: 'processing', updatedAt: new Date() },
  )
  if (affected === 0) return null
  return loadScopedEvent(em.fork(), leadEventId, scope)
}

async function loadPage(em: EntityManager, scope: MetaScope, pageId: string | null | undefined): Promise<MetaPage> {
  const page = pageId
    ? await findOneWithDecryption(
        em,
        MetaPage,
        { id: pageId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
        undefined,
        decryptionScope(scope),
      )
    : null
  if (!page) throw new PermanentLeadError('page_unassigned', '[internal] lead page is not assigned')
  return page
}

async function fetchLead(
  deps: LeadProcessorDeps,
  scope: MetaScope,
  event: MetaLeadEvent,
  page: MetaPage,
): Promise<GraphLead> {
  if (event.rawPayload || event.source === 'test') return parseLead(event.rawPayload ?? null)
  const pageToken = page.pageAccessToken?.trim()
  if (!pageToken) throw new PermanentLeadError('token_invalid', '[internal] page access token is missing')
  const graphOptions = graphOptionsFromCredentials(await resolveAppCredentials(deps.container, scope))
  try {
    return await deps.graph.getLead(event.metaLeadId, pageToken, graphOptions)
  } catch (error) {
    if (!(error instanceof MetaGraphError)) throw error
    await applyGraphErrorSideEffects(
      { resolve: <T = unknown>(name: string) => deps.container.resolve<T>(name), em: deps.em },
      { page },
      error.classification,
    )
    throw toLeadError(error)
  }
}

function parseLead(value: unknown): GraphLead {
  const parsed = graphLeadSchema.safeParse(value)
  if (!parsed.success) throw new PermanentLeadError('validation', '[internal] lead payload is invalid')
  return parsed.data
}

function applyLeadFields(event: MetaLeadEvent, lead: GraphLead, names: LeadSourceFields): void {
  event.adId = lead.ad_id ?? event.adId ?? null
  event.adsetId = lead.adset_id ?? null
  event.campaignId = lead.campaign_id ?? null
  event.adName = names.adName
  event.adsetName = names.adsetName
  event.campaignName = names.campaignName
  event.platform = normalizePlatform(lead.platform)
  event.isOrganic = typeof lead.is_organic === 'boolean' ? lead.is_organic : null
  event.submittedAt = parseGraphTime(lead.created_time) ?? event.submittedAt ?? null
  if (!event.rawPayload) event.rawPayload = { ...lead }
}

function findForm(em: EntityManager, scope: MetaScope, pageId: string, metaFormId: string): Promise<MetaForm | null> {
  return findOneWithDecryption(
    em,
    MetaForm,
    { tenantId: scope.tenantId, organizationId: scope.organizationId, pageId, metaFormId, deletedAt: null },
    undefined,
    decryptionScope(scope),
  )
}

async function resolveForm(em: EntityManager, scope: MetaScope, page: MetaPage, lead: GraphLead): Promise<MetaForm> {
  const existing = await findForm(em, scope, page.id, lead.form_id)
  if (existing) return existing
  const questions: MetaFormQuestionRow[] = lead.field_data.map((answer) => ({
    key: answer.name,
    label: answer.name,
    type: LAZY_QUESTION_TYPE,
  }))
  const fork = em.fork()
  fork.persist(
    fork.create(MetaForm, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      pageId: page.id,
      metaFormId: lead.form_id,
      name: lead.form_id,
      isEnabled: true,
      questions,
      questionsFingerprint: computeQuestionsFingerprint(questions),
      fieldMapping: buildDefaultFieldMapping(questions),
    }),
  )
  try {
    await fork.flush()
  } catch (error) {
    if (!(error instanceof UniqueConstraintViolationException)) throw error
  }
  const created = await findForm(em, scope, page.id, lead.form_id)
  if (!created) throw new PermanentLeadError('form_missing', '[internal] lead form could not be resolved')
  return created
}

function flagQuestionDrift(form: MetaForm, lead: GraphLead): void {
  const drift = detectQuestionDrift(form, lead.field_data)
  if (drift.length === 0) return
  const questions = [...form.questions, ...drift]
  const mapping = [...form.fieldMapping]
  const mapped = new Set(mapping.map((row) => row.questionKey))
  for (const question of drift) {
    if (mapping.length >= FIELD_MAPPING_MAX) break
    if (mapped.has(question.key)) continue
    mapped.add(question.key)
    mapping.push({ questionKey: question.key, target: 'note' })
  }
  form.questions = questions
  form.questionsFingerprint = computeQuestionsFingerprint(questions)
  form.fieldMapping = mapping
  form.needsAttention = true
  form.attentionReason = 'questions_changed'
}

async function resolveMatch(
  em: EntityManager,
  scope: MetaScope,
  event: MetaLeadEvent,
  keys: LeadContactKeys,
  defaultCountry: string,
): Promise<DedupResult> {
  if (event.personId) {
    const matchType = event.matchType === 'email' || event.matchType === 'phone' ? event.matchType : 'none'
    return { personId: event.personId, matchType, conflictPersonId: null }
  }
  return resolveDedupMatch(createDedupLookups(em, scope, { defaultCountry }), keys)
}

async function saveConsents(
  em: EntityManager,
  scope: MetaScope,
  event: MetaLeadEvent,
  personId: string,
  consents: { consentKey: string; consentText: string; isChecked: boolean }[],
  givenAt: Date,
): Promise<void> {
  for (const consent of consents) {
    const fork = em.fork()
    fork.persist(
      fork.create(MetaConsent, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        personId,
        leadEventId: event.id,
        consentKey: consent.consentKey,
        consentText: consent.consentText,
        givenAt,
        isChecked: consent.isChecked,
      }),
    )
    try {
      await fork.flush()
    } catch (error) {
      if (!isLeadEventUniqueViolation(error)) throw error
    }
  }
}

async function storeExternalIds(
  container: Resolver,
  scope: MetaScope,
  event: MetaLeadEvent,
  result: CrmWriteResult,
): Promise<void> {
  const service = tryResolve<ExternalIdMappingService>(container, 'externalIdMappingService')
  if (!service) return
  const targets: { entityType: string; localId: string | null }[] = [
    { entityType: EXTERNAL_ENTITY_TYPES.person, localId: result.personId },
    { entityType: EXTERNAL_ENTITY_TYPES.company, localId: result.companyId },
    { entityType: EXTERNAL_ENTITY_TYPES.deal, localId: result.dealId },
  ]
  for (const target of targets) {
    if (!target.localId) continue
    try {
      await service.storeExternalIdMapping(INTEGRATION_ID, target.entityType, target.localId, event.metaLeadId, {
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
      })
    } catch (error) {
      logger.warn('external id mapping failed', { leadEventId: event.id, entityType: target.entityType })
      reportFailure(error, 'meta_lead_ads.external_id_mapping_failed', {
        leadEventId: event.id,
        entityType: target.entityType,
      })
    }
  }
}

async function writeAuditLog(
  container: Resolver,
  scope: MetaScope,
  event: MetaLeadEvent,
  result: CrmWriteResult,
): Promise<void> {
  const service = tryResolve<ActionLogService>(container, 'actionLogService')
  if (!service) return
  try {
    await service.log({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      actorUserId: null,
      commandId: AUDIT_COMMAND_ID,
      resourceKind: AUDIT_RESOURCE_KIND,
      resourceId: event.id,
      context: {
        source: event.source,
        formId: event.formId ?? null,
        pageId: event.pageId ?? null,
        personId: result.personId,
        companyId: result.companyId,
        interactionId: result.interactionId,
        dealId: result.dealId,
        matchType: result.matchType,
      },
    })
  } catch (error) {
    logger.warn('lead import audit log failed', { leadEventId: event.id })
    reportFailure(error, 'meta_lead_ads.audit_log_failed', { leadEventId: event.id })
  }
}

function buildFailedPayload(scope: MetaScope, event: MetaLeadEvent, errorCode: MetaLeadErrorCode): LeadFailedPayload {
  return {
    leadEventId: event.id,
    metaLeadId: event.metaLeadId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    formId: event.formId ?? null,
    pageId: event.pageId ?? null,
    errorCode,
    attemptCount: event.attemptCount,
    manualRetryCount: event.manualRetryCount,
  }
}

async function emitLeadFailed(scope: MetaScope, event: MetaLeadEvent, errorCode: MetaLeadErrorCode): Promise<void> {
  await emitMetaLeadAdsEvent(META_LEAD_ADS_EVENTS.leadFailed, buildFailedPayload(scope, event, errorCode), {
    persistent: true,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
}

async function markFailed(
  em: EntityManager,
  scope: MetaScope,
  event: MetaLeadEvent,
  error: PermanentLeadError,
  now: Date,
): Promise<LeadProcessingResult> {
  const errorCode = error.leadErrorCode
  event.status = 'failed'
  event.lastErrorCode = errorCode
  event.lastError = error.message.slice(0, MAX_ERROR_LENGTH)
  event.nextAttemptAt = null
  event.updatedAt = now
  await em.flush()
  logger.warn('lead event failed', { leadEventId: event.id, errorCode })
  await emitLeadFailed(scope, event, errorCode)
  return { status: 'failed', errorCode }
}

async function runPipeline(
  deps: LeadProcessorDeps,
  scope: MetaScope,
  event: MetaLeadEvent,
  now: () => Date,
): Promise<LeadProcessingResult> {
  const { em } = deps
  const page = await loadPage(em, scope, event.pageId)

  const lead = parseLead(await fetchLead(deps, scope, event, page))
  if (lead.id !== event.metaLeadId || lead.form_id !== event.metaFormId) {
    throw new PermanentLeadError('validation', '[internal] lead payload does not match the notification')
  }
  const names = readSourceNames(lead)
  applyLeadFields(event, lead, names)
  await em.flush()

  const form = await resolveForm(em, scope, page, lead)
  event.formId = form.id
  if (!form.isEnabled) {
    event.status = 'skipped'
    event.lastErrorCode = 'form_disabled'
    event.lastError = null
    event.nextAttemptAt = null
    await em.flush()
    return { status: 'skipped', errorCode: 'form_disabled' }
  }
  flagQuestionDrift(form, lead)
  await em.flush()

  const settings = await getOrgSettings(em, scope)
  const mapped = applyMapping(lead.field_data, form.fieldMapping, form.questions)
  const phoneRaw = mapped.person.primaryPhoneRaw
  const phone = phoneRaw ? normalizePhoneToE164(phoneRaw, settings.defaultCountry) : null
  const keys = buildContactKeys(mapped.person.primaryEmail ?? null, phone)
  const match = await resolveMatch(em, scope, event, keys, settings.defaultCountry)

  const { translate } = await resolveTranslations()
  const result = await writeLeadToCrm({
    container: deps.container as AwilixContainer,
    em,
    scope,
    event,
    form,
    mapped,
    phone,
    match,
    source: {
      campaignName: names.campaignName,
      adsetName: names.adsetName,
      adName: names.adName,
      formName: form.name,
      platform: event.platform ?? null,
      isOrganic: event.isOrganic ?? null,
      submittedAt: event.submittedAt ?? null,
    },
    translate,
    persist: async (patch) => {
      Object.assign(event, patch)
      await em.flush()
    },
  })

  await saveConsents(em, scope, event, result.personId, mapped.consents, event.submittedAt ?? now())
  await upsertPersonKeys(em, scope, result.personId, keys)
  event.emailHash = keys.emailHash
  event.phoneHash = keys.phoneHash

  await storeExternalIds(deps.container, scope, event, result)

  const processedAt = now()
  event.status = 'processed'
  event.processedAt = processedAt
  event.lastErrorCode = result.dealStepFailed ? 'deal_step_failed' : null
  event.lastError = null
  event.nextAttemptAt = null
  event.updatedAt = processedAt
  await em.flush()

  if (result.dealStepFailed) await emitLeadFailed(scope, event, 'deal_step_failed')

  await writeAuditLog(deps.container, scope, event, result)

  const payload: LeadReceivedPayload = {
    leadEventId: event.id,
    metaLeadId: event.metaLeadId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    personId: result.personId,
    companyId: result.companyId,
    interactionId: result.interactionId,
    dealId: result.dealId,
    formId: form.id,
    metaFormId: event.metaFormId,
    pageId: page.id,
    campaignId: event.campaignId ?? null,
    adId: event.adId ?? null,
    platform: event.platform ?? null,
    isOrganic: event.isOrganic ?? false,
    submittedAt: (event.submittedAt ?? processedAt).toISOString(),
    matchType: result.matchType,
    ownerUserId: result.ownerUserId,
  }
  await emitMetaLeadAdsEvent(META_LEAD_ADS_EVENTS.leadReceived, payload, {
    persistent: true,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })

  return result.dealStepFailed ? { status: 'processed', errorCode: 'deal_step_failed' } : { status: 'processed' }
}

export async function processLeadEvent(
  deps: LeadProcessorDeps,
  leadEventId: string,
  scope: MetaScope,
): Promise<LeadProcessingResult> {
  const now = deps.now ?? (() => new Date())
  const event = await loadScopedEvent(deps.em, leadEventId, scope)
  if (!event) throw new Error('[internal] lead event not found')
  if (!event.tenantId || !event.organizationId || event.status === 'unrouted') return { status: event.status }
  if (event.status !== 'processing') return { status: event.status }

  try {
    return await runPipeline(deps, scope, event, now)
  } catch (error) {
    if (error instanceof PermanentLeadError) return markFailed(deps.em, scope, event, error, now())
    throw error
  }
}

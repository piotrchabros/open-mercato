import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { MetaConnection, MetaForm, type MetaPage } from '../data/entities'
import { emitMetaLeadAdsEvent, META_LEAD_ADS_EVENTS } from '../events'
import {
  FIELD_MAPPING_MAX,
  type MetaConnectionStatus,
  type MetaPageSubscriptionStatus,
} from './constants'
import {
  MetaGraphError,
  type GraphCallOptions,
  type GraphErrorClassification,
  type GraphForm,
  type GraphTokenReason,
  type MetaGraphClient,
} from './graph-client'
import { buildDefaultFieldMapping, computeQuestionsFingerprint } from './mapping'
import { notifyConnectionTokenInvalid, notifyPageNoLeadsAccess, type Resolver } from './notifier'
import { decryptionScope, scopeOfPage } from './scope'

const MAX_FORM_PAGES_FOLLOWED = 50
const LEADGEN_FIELD = 'leadgen'
const LAZY_QUESTION_TYPE = 'CUSTOM'
const MISSING_PAGE_TOKEN_ERROR = 'Page access token is missing'
const NOT_SUBSCRIBED_ERROR = 'Page is not subscribed to leadgen webhooks'
const TOKEN_INVALID_STATUSES: ReadonlySet<MetaConnectionStatus> = new Set(['token_expired', 'invalid'])

export type PageServiceContext = Resolver & { em: EntityManager }

export type PageStatusUpdate = { status: MetaPageSubscriptionStatus; lastError: string | null }

export type ConnectionStatusUpdate = {
  status: MetaConnectionStatus
  lastError: string | null
  reason: GraphTokenReason | null
}

export type SyncPageFormsResult = { created: number; updated: number; flagged: number; total: number }

export function describeGraphError(classification: GraphErrorClassification): string {
  return `Graph API error (${classification.errorClass})`
}

export async function verifyPageSubscription(
  graph: MetaGraphClient,
  input: { metaPageId: string; pageAccessToken: string | null | undefined },
  options?: GraphCallOptions,
): Promise<PageStatusUpdate> {
  const pageToken = input.pageAccessToken?.trim()
  if (!pageToken) return { status: 'token_expired', lastError: MISSING_PAGE_TOKEN_ERROR }
  try {
    const subscription = await graph.getPageSubscription(input.metaPageId, pageToken, options)
    if (!subscription.subscribed || !subscription.fields.includes(LEADGEN_FIELD)) {
      return { status: 'unsubscribed', lastError: NOT_SUBSCRIBED_ERROR }
    }
    await graph.probeLeadsAccess(input.metaPageId, pageToken, options)
    return { status: 'active', lastError: null }
  } catch (error) {
    if (error instanceof MetaGraphError && error.classification.pageStatus) {
      return { status: error.classification.pageStatus, lastError: describeGraphError(error.classification) }
    }
    throw error
  }
}

export async function applyPageStatus(
  ctx: PageServiceContext,
  page: MetaPage,
  next: PageStatusUpdate,
): Promise<boolean> {
  const previousStatus = page.subscriptionStatus
  const checkedAt = new Date()
  const changed = previousStatus !== next.status
  page.subscriptionStatus = next.status
  page.lastError = next.lastError
  page.statusCheckedAt = checkedAt
  await ctx.em.flush()
  if (!changed) return false

  const scope = scopeOfPage(page)
  await emitMetaLeadAdsEvent(
    META_LEAD_ADS_EVENTS.pageStatusChanged,
    {
      pageId: page.id,
      metaPageId: page.metaPageId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      connectionId: page.connectionId,
      previousStatus,
      status: next.status,
      checkedAt: checkedAt.toISOString(),
    },
    { persistent: true, tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  if (next.status === 'no_leads_access') {
    await notifyPageNoLeadsAccess(ctx, { scope, pageId: page.id, pageName: page.name })
  }
  return true
}

export async function applyConnectionStatus(
  ctx: PageServiceContext,
  connection: MetaConnection,
  next: ConnectionStatusUpdate,
): Promise<boolean> {
  const previousStatus = connection.status
  if (previousStatus === 'disconnected' && next.status !== 'disconnected') return false
  const detectedAt = new Date()
  const changed = previousStatus !== next.status
  connection.status = next.status
  connection.lastError = next.lastError
  await ctx.em.flush()
  if (!changed || !TOKEN_INVALID_STATUSES.has(next.status)) return changed

  const scope = { tenantId: connection.tenantId, organizationId: connection.organizationId }
  const reason = next.reason ?? 'unknown'
  await emitMetaLeadAdsEvent(
    META_LEAD_ADS_EVENTS.connectionTokenInvalid,
    {
      connectionId: connection.id,
      metaUserId: connection.metaUserId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      previousStatus,
      status: next.status,
      reason,
      detectedAt: detectedAt.toISOString(),
    },
    { persistent: true, tenantId: scope.tenantId, organizationId: scope.organizationId },
  )
  await notifyConnectionTokenInvalid(ctx, {
    scope,
    connectionId: connection.id,
    metaUserName: connection.metaUserName ?? null,
    reason,
  })
  return true
}

export async function applyGraphErrorSideEffects(
  ctx: PageServiceContext,
  target: { page: MetaPage | null; connectionId?: string | null },
  classification: GraphErrorClassification,
): Promise<void> {
  const { page } = target
  if (!page) return
  const lastError = describeGraphError(classification)
  if (classification.pageStatus) {
    await applyPageStatus(ctx, page, { status: classification.pageStatus, lastError })
  }
  const connectionId = target.connectionId ?? page.connectionId
  if (!classification.connectionStatus || !connectionId) return
  const scope = scopeOfPage(page)
  const connection = await findOneWithDecryption(
    ctx.em,
    MetaConnection,
    { id: connectionId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    undefined,
    decryptionScope(scope),
  )
  if (!connection) return
  await applyConnectionStatus(ctx, connection, {
    status: classification.connectionStatus,
    lastError,
    reason: classification.tokenReason ?? null,
  })
}

async function listAllPageForms(
  graph: MetaGraphClient,
  input: { metaPageId: string; pageToken: string },
  options?: GraphCallOptions,
): Promise<GraphForm[]> {
  const forms: GraphForm[] = []
  let after: string | null = null
  for (let iteration = 0; iteration < MAX_FORM_PAGES_FOLLOWED; iteration += 1) {
    const result = await graph.listPageForms({ ...input, after }, options)
    forms.push(...result.forms)
    if (!result.paging.hasNext || !result.paging.after) break
    after = result.paging.after
  }
  return forms
}

function isLazilyCreated(form: MetaForm): boolean {
  return form.questions.length > 0 && form.questions.every((question) => question.type === LAZY_QUESTION_TYPE)
}

function haveSameQuestionKeys(form: MetaForm, graphForm: GraphForm): boolean {
  const storedKeys = new Set(form.questions.map((question) => question.key))
  const graphKeys = new Set(graphForm.questions.map((question) => question.key))
  if (storedKeys.size !== graphKeys.size) return false
  for (const key of graphKeys) {
    if (!storedKeys.has(key)) return false
  }
  return true
}

function appendNewQuestionKeys(form: MetaForm, graphForm: GraphForm): void {
  const mapped = new Set(form.fieldMapping.map((row) => row.questionKey))
  const mapping = [...form.fieldMapping]
  for (const question of graphForm.questions) {
    if (mapping.length >= FIELD_MAPPING_MAX) break
    if (mapped.has(question.key)) continue
    mapped.add(question.key)
    mapping.push({ questionKey: question.key, target: 'note' })
  }
  form.fieldMapping = mapping
}

export async function syncPageForms(
  deps: { em: EntityManager; graph: MetaGraphClient; graphOptions?: GraphCallOptions },
  page: MetaPage,
): Promise<SyncPageFormsResult> {
  const pageToken = page.pageAccessToken?.trim()
  if (!pageToken) throw new Error('[internal] page access token is missing')
  const { em } = deps
  const scope = scopeOfPage(page)
  const graphForms = await listAllPageForms(
    deps.graph,
    { metaPageId: page.metaPageId, pageToken },
    deps.graphOptions,
  )
  const existingForms = await findWithDecryption(
    em,
    MetaForm,
    { tenantId: scope.tenantId, organizationId: scope.organizationId, pageId: page.id, deletedAt: null },
    undefined,
    decryptionScope(scope),
  )
  const existingByMetaId = new Map(existingForms.map((form) => [form.metaFormId, form]))
  const seenMetaIds = new Set<string>()
  const result: SyncPageFormsResult = { created: 0, updated: 0, flagged: 0, total: 0 }

  for (const graphForm of graphForms) {
    if (seenMetaIds.has(graphForm.id)) continue
    seenMetaIds.add(graphForm.id)
    result.total += 1
    const fingerprint = computeQuestionsFingerprint(graphForm.questions)
    const existing = existingByMetaId.get(graphForm.id)
    if (!existing) {
      em.persist(
        em.create(MetaForm, {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          pageId: page.id,
          metaFormId: graphForm.id,
          name: graphForm.name,
          locale: graphForm.locale,
          isEnabled: true,
          questions: graphForm.questions,
          questionsFingerprint: fingerprint,
          fieldMapping: buildDefaultFieldMapping(graphForm.questions),
        }),
      )
      result.created += 1
      continue
    }
    result.updated += 1
    existing.name = graphForm.name
    existing.locale = graphForm.locale
    if (existing.questionsFingerprint === fingerprint) continue
    const adoptSilently = isLazilyCreated(existing) && haveSameQuestionKeys(existing, graphForm)
    existing.questions = graphForm.questions
    existing.questionsFingerprint = fingerprint
    if (adoptSilently) continue
    existing.needsAttention = true
    existing.attentionReason = 'questions_changed'
    appendNewQuestionKeys(existing, graphForm)
    result.flagged += 1
  }

  for (const form of existingForms) {
    if (seenMetaIds.has(form.metaFormId)) continue
    if (form.needsAttention && form.attentionReason === 'form_archived') continue
    form.needsAttention = true
    form.attentionReason = 'form_archived'
    result.flagged += 1
  }

  await em.flush()
  return result
}

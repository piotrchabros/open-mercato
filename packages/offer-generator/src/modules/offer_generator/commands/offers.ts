import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { registerCommand } from '@open-mercato/shared/lib/commands/registry'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import {
  buildChanges,
  emitCrudUndoSideEffects,
  normalizeAuthorUserId,
  requireId,
} from '@open-mercato/shared/lib/commands/helpers'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import { ensureOrganizationScope, ensureTenantScope } from '@open-mercato/shared/lib/commands/scope'
import { extractUndoPayload, type UndoPayload } from '@open-mercato/shared/lib/commands/undo'
import { CrudHttpError, conflict, isUniqueViolation, notFound } from '@open-mercato/shared/lib/crud/errors'
import {
  enforceCommandOptimisticLockWithGuards,
  enforceRecordGoneIsConflict,
} from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import type { CrudEventsConfig, CrudIndexerConfig } from '@open-mercato/shared/lib/crud/types'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { Offer, OfferRevision } from '../data/entities'
import {
  offerCreateSchema,
  offerRevisionSourceSchema,
  offerUpdateSchema,
  type OfferCreateInput,
  type OfferCustomerKind,
  type OfferLanguage,
  type OfferRevisionSource,
  type OfferStatus,
  type OfferUpdateInput,
} from '../data/validators'
import { ENTITY_IDS, MAX_OFFER_HTML_CHARS, MAX_REVISIONS_PER_OFFER } from '../lib/constants'
import { sanitizeOfferHtml } from '../lib/html-sanitize'
import { checkOfferHtmlComplete, type OfferHtmlIssue } from '../lib/html-validate'
import { getOfferGeneratorSettings } from '../lib/settings'
import { buildBaseSlug, ensureUniqueSlug, generateAccessToken } from '../lib/slug'

export const OFFER_RESOURCE_KIND = 'offer_generator.offer'

export const OFFER_COMMAND_IDS = {
  create: 'offer_generator.offers.create',
  update: 'offer_generator.offers.update',
  delete: 'offer_generator.offers.delete',
  updateHtml: 'offer_generator.offers.update_html',
} as const

const OFFER_SLUG_CONSTRAINT = 'offer_generator_offers_slug_uq'
const CREATE_SLUG_ATTEMPTS = 3

export const offerHtmlCommandSchema = z.object({
  id: z.string().uuid(),
  html: z.string().min(1).max(MAX_OFFER_HTML_CHARS),
  source: offerRevisionSourceSchema,
  feedback: z.string().max(10000).nullable().optional(),
  generationRunId: z.string().uuid().nullable().optional(),
  expectedUpdatedAt: z.union([z.string().min(1), z.date()]).nullable().optional(),
})
export type OfferHtmlCommandInput = z.infer<typeof offerHtmlCommandSchema>

export type OfferCommandResult = { offerId: string }

export type OfferHtmlCommandResult = {
  offerId: string
  revisionId: string | null
  htmlUpdatedAt: string
  updatedAt: string
}

type OfferDeleteInput = { id?: string; body?: Record<string, unknown>; query?: Record<string, unknown> }

type OfferSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  ownerUserId: string | null
  title: string
  clientName: string
  language: OfferLanguage
  status: OfferStatus
  customerEntityId: string | null
  customerKind: OfferCustomerKind | null
  dealId: string | null
  slug: string
  prompt: string | null
  notes: string | null
  valueAmount: string | null
  currencyCode: string | null
  validUntil: string | null
  sentAt: string | null
  respondedAt: string | null
  deletedAt: string | null
}

type OfferUndoPayload = UndoPayload<OfferSnapshot>

type OfferHtmlUndoPayload = {
  offerId: string
  tenantId: string
  organizationId: string
  previousRevisionId: string | null
  previousHtmlUpdatedAt: string | null
}

const offerCrudEvents: CrudEventsConfig<Offer> = {
  module: 'offer_generator',
  entity: 'offer',
  persistent: true,
  buildPayload: (ctx) => ({
    id: ctx.identifiers.id,
    organizationId: ctx.identifiers.organizationId,
    tenantId: ctx.identifiers.tenantId,
  }),
}

const offerCrudIndexer: CrudIndexerConfig<Offer> = {
  entityType: ENTITY_IDS.offer,
}

const offerIdSchema = z.string().uuid()

const incompleteHtmlFallbacks: Record<OfferHtmlIssue, string> = {
  'no-html-close': 'The offer HTML is incomplete: the closing </html> tag is missing.',
  'no-body': 'The offer HTML has no <body> element.',
  'empty-body': 'The offer HTML body has too little content.',
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

function fromIso(value: string | null): Date | null {
  return value ? new Date(value) : null
}

function toAmount(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed(2)
}

function toSnapshot(offer: Offer): OfferSnapshot {
  return {
    id: offer.id,
    tenantId: offer.tenantId,
    organizationId: offer.organizationId,
    ownerUserId: offer.ownerUserId ?? null,
    title: offer.title,
    clientName: offer.clientName,
    language: offer.language,
    status: offer.status,
    customerEntityId: offer.customerEntityId ?? null,
    customerKind: offer.customerKind ?? null,
    dealId: offer.dealId ?? null,
    slug: offer.slug,
    prompt: offer.prompt ?? null,
    notes: offer.notes ?? null,
    valueAmount: offer.valueAmount === null || offer.valueAmount === undefined ? null : String(offer.valueAmount),
    currencyCode: offer.currencyCode ?? null,
    validUntil: offer.validUntil ?? null,
    sentAt: toIso(offer.sentAt),
    respondedAt: toIso(offer.respondedAt),
    deletedAt: toIso(offer.deletedAt),
  }
}

function applySnapshot(offer: Offer, snapshot: OfferSnapshot): void {
  offer.ownerUserId = snapshot.ownerUserId
  offer.title = snapshot.title
  offer.clientName = snapshot.clientName
  offer.language = snapshot.language
  offer.status = snapshot.status
  offer.customerEntityId = snapshot.customerEntityId
  offer.customerKind = snapshot.customerKind
  offer.dealId = snapshot.dealId
  offer.prompt = snapshot.prompt
  offer.notes = snapshot.notes
  offer.valueAmount = snapshot.valueAmount
  offer.currencyCode = snapshot.currencyCode
  offer.validUntil = snapshot.validUntil
  offer.sentAt = fromIso(snapshot.sentAt)
  offer.respondedAt = fromIso(snapshot.respondedAt)
  offer.deletedAt = fromIso(snapshot.deletedAt)
}

function resolveDecryptionScope(ctx: CommandRuntimeContext): { tenantId: string | null; organizationId: string | null } {
  return {
    tenantId: ctx.auth?.tenantId ?? ctx.organizationScope?.tenantId ?? null,
    organizationId: ctx.selectedOrganizationId ?? ctx.auth?.orgId ?? null,
  }
}

async function findOffer(
  em: EntityManager,
  id: string,
  ctx: CommandRuntimeContext,
  options: { includeDeleted?: boolean } = {},
): Promise<Offer | null> {
  if (!offerIdSchema.safeParse(id).success) return null
  const organizationIds = Array.isArray(ctx.organizationIds) ? ctx.organizationIds : null
  if (organizationIds && organizationIds.length === 0) return null
  const scope = resolveDecryptionScope(ctx)
  const where = {
    id,
    ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
    ...(organizationIds ? { organizationId: { $in: organizationIds } } : {}),
    ...(options.includeDeleted ? {} : { deletedAt: null }),
  }
  const offer = await findOneWithDecryption(em, Offer, where, undefined, scope)
  if (!offer) return null
  ensureTenantScope(ctx, offer.tenantId)
  ensureOrganizationScope(ctx, offer.organizationId)
  return offer
}

async function requireOffer(
  em: EntityManager,
  id: string,
  ctx: CommandRuntimeContext,
  expected?: string | Date | null,
): Promise<Offer> {
  const offer = await findOffer(em, id, ctx)
  if (offer) return offer
  enforceRecordGoneIsConflict({
    resourceKind: OFFER_RESOURCE_KIND,
    resourceId: id,
    expected: expected ?? null,
    request: ctx.request ?? null,
  })
  const { translate } = await resolveTranslations()
  throw notFound(translate('offer_generator.errors.notFound', 'Offer not found'))
}

async function loadSnapshot(em: EntityManager, id: string, ctx: CommandRuntimeContext): Promise<OfferSnapshot | null> {
  const offer = await findOffer(em, id, ctx, { includeDeleted: true })
  return offer ? toSnapshot(offer) : null
}

async function emitOfferUndoSideEffects(
  ctx: CommandRuntimeContext,
  action: 'created' | 'updated' | 'deleted',
  offer: Offer,
): Promise<void> {
  const dataEngine = ctx.container.resolve('dataEngine') as DataEngine
  await emitCrudUndoSideEffects({
    dataEngine,
    action,
    entity: offer,
    identifiers: { id: offer.id, organizationId: offer.organizationId, tenantId: offer.tenantId },
    events: offerCrudEvents,
    indexer: offerCrudIndexer,
  })
}

function offerSideEffect(offer: Offer) {
  return {
    entity: offer,
    identifiers: { id: offer.id, organizationId: offer.organizationId, tenantId: offer.tenantId },
  }
}

function applyStatusTimestamps(offer: Offer, status: OfferStatus, now: Date): void {
  if (status === 'sent' && !offer.sentAt) offer.sentAt = now
  if ((status === 'accepted' || status === 'rejected') && !offer.respondedAt) offer.respondedAt = now
}

const createOfferCommand: CommandHandler<OfferCreateInput, OfferCommandResult> = {
  id: OFFER_COMMAND_IDS.create,
  async execute(rawInput, ctx) {
    const parsed = offerCreateSchema.parse(rawInput)
    ensureTenantScope(ctx, parsed.tenantId)
    ensureOrganizationScope(ctx, parsed.organizationId)
    const scope = { tenantId: parsed.tenantId, organizationId: parsed.organizationId }
    const baseEm = (ctx.container.resolve('em') as EntityManager).fork()
    const settings = await getOfferGeneratorSettings(baseEm, scope)
    const ownerUserId = normalizeAuthorUserId(null, ctx.auth)
    const baseSlug = buildBaseSlug(parsed.clientName)

    for (let attempt = 1; attempt <= CREATE_SLUG_ATTEMPTS; attempt += 1) {
      const em = (ctx.container.resolve('em') as EntityManager).fork()
      const slug = await ensureUniqueSlug(em, baseSlug)
      const now = new Date()
      const offer = em.create(Offer, {
        tenantId: parsed.tenantId,
        organizationId: parsed.organizationId,
        ownerUserId,
        title: parsed.title,
        clientName: parsed.clientName,
        language: parsed.language,
        status: parsed.status ?? 'draft',
        customerEntityId: parsed.customerEntityId ?? null,
        customerKind: parsed.customerKind ?? null,
        dealId: parsed.dealId ?? null,
        slug,
        accessToken: generateAccessToken(),
        prompt: parsed.prompt ?? null,
        notes: parsed.notes ?? null,
        valueAmount: toAmount(parsed.valueAmount),
        currencyCode: parsed.currencyCode ?? settings.defaultCurrency,
        validUntil: parsed.validUntil ?? null,
      })
      applyStatusTimestamps(offer, offer.status, now)
      try {
        await runCrudCommandWrite({
          ctx,
          em,
          entityId: ENTITY_IDS.offer,
          action: 'created',
          scope,
          events: offerCrudEvents,
          indexer: offerCrudIndexer,
          sideEffect: () => offerSideEffect(offer),
          phases: [({ em: writeEm }) => { writeEm.persist(offer) }],
        })
        return { offerId: offer.id }
      } catch (error) {
        if (attempt < CREATE_SLUG_ATTEMPTS && isUniqueViolation(error, OFFER_SLUG_CONSTRAINT)) continue
        throw error
      }
    }
    throw new Error('[internal] offer_generator could not allocate a unique offer slug')
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return loadSnapshot(em, result.offerId, ctx)
  },
  buildLog: async ({ snapshots }) => {
    const after = snapshots.after as OfferSnapshot | undefined
    if (!after) return null
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('offer_generator.audit.offers.create', 'Create offer'),
      resourceKind: OFFER_RESOURCE_KIND,
      resourceId: after.id,
      tenantId: after.tenantId,
      organizationId: after.organizationId,
      snapshotAfter: after,
      payload: { undo: { after } satisfies OfferUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const after = extractUndoPayload<OfferUndoPayload>(logEntry)?.after ?? null
    if (!after) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const offer = await findOffer(em, after.id, ctx)
    if (!offer) return
    offer.deletedAt = new Date()
    await em.flush()
    await emitOfferUndoSideEffects(ctx, 'deleted', offer)
  },
  redo: async ({ logEntry, ctx }) => {
    const after = extractUndoPayload<OfferUndoPayload>(logEntry)?.after ?? null
    if (!after) throw new CrudHttpError(400, { error: '[internal] redo snapshot unavailable for offer create' })
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const offer = await findOffer(em, after.id, ctx, { includeDeleted: true })
    if (!offer) throw new CrudHttpError(400, { error: '[internal] offer missing for redo' })
    offer.deletedAt = null
    await em.flush()
    await emitOfferUndoSideEffects(ctx, 'created', offer)
    return { offerId: offer.id }
  },
}

const updateOfferCommand: CommandHandler<OfferUpdateInput, OfferCommandResult> = {
  id: OFFER_COMMAND_IDS.update,
  async prepare(rawInput, ctx) {
    const id = requireId(rawInput?.id, '[internal] Offer id is required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const before = await loadSnapshot(em, id, ctx)
    return before ? { before } : {}
  },
  async execute(rawInput, ctx) {
    const parsed = offerUpdateSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const offer = await requireOffer(em, parsed.id, ctx)
    const now = new Date()

    await runCrudCommandWrite({
      ctx,
      em,
      entityId: ENTITY_IDS.offer,
      action: 'updated',
      scope: { tenantId: offer.tenantId, organizationId: offer.organizationId },
      events: offerCrudEvents,
      indexer: offerCrudIndexer,
      sideEffect: () => offerSideEffect(offer),
      phases: [
        () => {
          if (parsed.title !== undefined) offer.title = parsed.title
          if (parsed.clientName !== undefined) offer.clientName = parsed.clientName
          if (parsed.language !== undefined) offer.language = parsed.language
          if (parsed.customerEntityId !== undefined) offer.customerEntityId = parsed.customerEntityId
          if (parsed.customerKind !== undefined) offer.customerKind = parsed.customerKind
          if (parsed.dealId !== undefined) offer.dealId = parsed.dealId
          if (parsed.prompt !== undefined) offer.prompt = parsed.prompt
          if (parsed.notes !== undefined) offer.notes = parsed.notes
          if (parsed.valueAmount !== undefined) offer.valueAmount = toAmount(parsed.valueAmount)
          if (parsed.currencyCode !== undefined) offer.currencyCode = parsed.currencyCode
          if (parsed.validUntil !== undefined) offer.validUntil = parsed.validUntil
          if (parsed.sentAt !== undefined) offer.sentAt = parsed.sentAt
          if (parsed.respondedAt !== undefined) offer.respondedAt = parsed.respondedAt
          if (parsed.status !== undefined && parsed.status !== offer.status) {
            offer.status = parsed.status
            applyStatusTimestamps(offer, parsed.status, now)
          }
          offer.updatedAt = now
        },
      ],
    })

    return { offerId: offer.id }
  },
  captureAfter: async (_input, result, ctx) => {
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    return loadSnapshot(em, result.offerId, ctx)
  },
  buildLog: async ({ snapshots }) => {
    const before = snapshots.before as OfferSnapshot | undefined
    const after = snapshots.after as OfferSnapshot | undefined
    if (!after) return null
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('offer_generator.audit.offers.update', 'Update offer'),
      resourceKind: OFFER_RESOURCE_KIND,
      resourceId: after.id,
      tenantId: after.tenantId,
      organizationId: after.organizationId,
      snapshotBefore: before ?? undefined,
      snapshotAfter: after,
      changes: before
        ? buildChanges(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>, [
            'title',
            'clientName',
            'language',
            'status',
            'customerEntityId',
            'customerKind',
            'dealId',
            'valueAmount',
            'currencyCode',
            'validUntil',
            'sentAt',
            'respondedAt',
          ])
        : {},
      payload: { undo: { before: before ?? null, after } satisfies OfferUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const before = extractUndoPayload<OfferUndoPayload>(logEntry)?.before ?? null
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const offer = await findOffer(em, before.id, ctx, { includeDeleted: true })
    if (!offer) return
    applySnapshot(offer, before)
    offer.updatedAt = new Date()
    await em.flush()
    await emitOfferUndoSideEffects(ctx, 'updated', offer)
  },
}

const deleteOfferCommand: CommandHandler<OfferDeleteInput, OfferCommandResult> = {
  id: OFFER_COMMAND_IDS.delete,
  async prepare(input, ctx) {
    const id = requireId(input, '[internal] Offer id is required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const before = await loadSnapshot(em, id, ctx)
    return before ? { before } : {}
  },
  async execute(input, ctx) {
    const id = requireId(input, '[internal] Offer id is required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const offer = await requireOffer(em, id, ctx)

    await runCrudCommandWrite({
      ctx,
      em,
      entityId: ENTITY_IDS.offer,
      action: 'deleted',
      scope: { tenantId: offer.tenantId, organizationId: offer.organizationId },
      events: offerCrudEvents,
      indexer: offerCrudIndexer,
      sideEffect: () => offerSideEffect(offer),
      phases: [
        () => {
          offer.deletedAt = new Date()
        },
      ],
    })

    return { offerId: offer.id }
  },
  buildLog: async ({ snapshots }) => {
    const before = snapshots.before as OfferSnapshot | undefined
    if (!before) return null
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('offer_generator.audit.offers.delete', 'Delete offer'),
      resourceKind: OFFER_RESOURCE_KIND,
      resourceId: before.id,
      tenantId: before.tenantId,
      organizationId: before.organizationId,
      snapshotBefore: before,
      payload: { undo: { before } satisfies OfferUndoPayload },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const before = extractUndoPayload<OfferUndoPayload>(logEntry)?.before ?? null
    if (!before) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const offer = await findOffer(em, before.id, ctx, { includeDeleted: true })
    if (!offer) return
    offer.deletedAt = null
    await em.flush()
    await emitOfferUndoSideEffects(ctx, 'created', offer)
  },
}

async function pruneRevisions(em: EntityManager, offer: Offer, keep: number): Promise<void> {
  await em
    .getConnection()
    .execute(
      'delete from offer_generator_offer_revisions where id in (select id from offer_generator_offer_revisions where offer_id = ? and tenant_id = ? and organization_id = ? order by created_at desc, id desc offset ?)',
      [offer.id, offer.tenantId, offer.organizationId, keep],
    )
}

async function throwIncompleteHtml(issue: OfferHtmlIssue): Promise<never> {
  const { translate } = await resolveTranslations()
  throw new CrudHttpError(400, {
    error: translate(`offer_generator.errors.incompleteHtml.${issue}`, incompleteHtmlFallbacks[issue]),
    code: 'incomplete_html',
    issue,
  })
}

const updateOfferHtmlCommand: CommandHandler<OfferHtmlCommandInput, OfferHtmlCommandResult> = {
  id: OFFER_COMMAND_IDS.updateHtml,
  async execute(rawInput, ctx) {
    const parsed = offerHtmlCommandSchema.parse(rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const offer = await requireOffer(em, parsed.id, ctx, parsed.expectedUpdatedAt ?? null)

    if (parsed.expectedUpdatedAt !== undefined && parsed.expectedUpdatedAt !== null) {
      await enforceCommandOptimisticLockWithGuards(ctx.container, {
        resourceKind: OFFER_RESOURCE_KIND,
        resourceId: offer.id,
        current: offer.updatedAt,
        expected: parsed.expectedUpdatedAt,
        request: ctx.request ?? null,
      })
    }

    const rawCheck = checkOfferHtmlComplete(parsed.html)
    if (!rawCheck.ok) await throwIncompleteHtml(rawCheck.issue)
    const sanitized = sanitizeOfferHtml(parsed.html)
    const check = checkOfferHtmlComplete(sanitized)
    if (!check.ok) await throwIncompleteHtml(check.issue)

    const previousHtml = offer.html ?? null
    const now = new Date()
    let revision: OfferRevision | null = null

    await runCrudCommandWrite({
      ctx,
      em,
      entityId: ENTITY_IDS.offer,
      action: 'updated',
      scope: { tenantId: offer.tenantId, organizationId: offer.organizationId },
      events: offerCrudEvents,
      indexer: offerCrudIndexer,
      sideEffect: () => offerSideEffect(offer),
      phases: [
        async ({ em: writeEm }) => {
          if (!previousHtml) return
          await pruneRevisions(writeEm, offer, MAX_REVISIONS_PER_OFFER - 1)
          revision = writeEm.create(OfferRevision, {
            tenantId: offer.tenantId,
            organizationId: offer.organizationId,
            offerId: offer.id,
            html: previousHtml,
            source: parsed.source,
            feedback: parsed.feedback ?? null,
            generationRunId: parsed.generationRunId ?? null,
            createdByUserId: normalizeAuthorUserId(null, ctx.auth),
            createdAt: now,
          })
          writeEm.persist(revision)
        },
        () => {
          offer.html = sanitized
          offer.htmlUpdatedAt = now
          offer.updatedAt = now
        },
      ],
    })

    const createdRevision = revision as OfferRevision | null
    return {
      offerId: offer.id,
      revisionId: createdRevision ? createdRevision.id : null,
      htmlUpdatedAt: now.toISOString(),
      updatedAt: offer.updatedAt.toISOString(),
    }
  },
  prepare: async (rawInput, ctx) => {
    const id = requireId(rawInput?.id, '[internal] Offer id is required')
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const offer = await findOffer(em, id, ctx)
    return offer ? { before: { htmlUpdatedAt: toIso(offer.htmlUpdatedAt) } } : {}
  },
  buildLog: async ({ input, result, snapshots, ctx }) => {
    const { translate } = await resolveTranslations()
    const before = snapshots.before as { htmlUpdatedAt: string | null } | undefined
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const offer = await findOffer(em, result.offerId, ctx)
    if (!offer) return null
    const source: OfferRevisionSource = input.source
    return {
      actionLabel: translate('offer_generator.audit.offers.updateHtml', 'Update offer content'),
      resourceKind: OFFER_RESOURCE_KIND,
      resourceId: offer.id,
      tenantId: offer.tenantId,
      organizationId: offer.organizationId,
      context: { source, revisionId: result.revisionId },
      payload: {
        undo: {
          offerId: offer.id,
          tenantId: offer.tenantId,
          organizationId: offer.organizationId,
          previousRevisionId: result.revisionId,
          previousHtmlUpdatedAt: before?.htmlUpdatedAt ?? null,
        } satisfies OfferHtmlUndoPayload,
      },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<OfferHtmlUndoPayload>(logEntry)
    if (!payload) return
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const offer = await findOffer(em, payload.offerId, ctx)
    if (!offer) return
    const scope = { tenantId: offer.tenantId, organizationId: offer.organizationId }
    if (payload.previousRevisionId) {
      const revision = await findOneWithDecryption(
        em,
        OfferRevision,
        { id: payload.previousRevisionId, offerId: offer.id, ...scope },
        undefined,
        scope,
      )
      if (!revision) {
        const { translate } = await resolveTranslations()
        throw conflict(
          translate('offer_generator.errors.revisionUnavailable', 'The previous version of this offer is no longer available'),
        )
      }
      offer.html = revision.html
      offer.htmlUpdatedAt = fromIso(payload.previousHtmlUpdatedAt) ?? new Date()
      em.remove(revision)
    } else {
      offer.html = null
      offer.htmlUpdatedAt = null
    }
    offer.updatedAt = new Date()
    await em.flush()
    await emitOfferUndoSideEffects(ctx, 'updated', offer)
  },
}

registerCommand(createOfferCommand)
registerCommand(updateOfferCommand)
registerCommand(deleteOfferCommand)
registerCommand(updateOfferHtmlCommand)

export { createOfferCommand, updateOfferCommand, deleteOfferCommand, updateOfferHtmlCommand }

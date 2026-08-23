import { randomUUID } from 'crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { RequiredEntityData } from '@mikro-orm/core'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { emitCrudUndoSideEffects, requireId } from '@open-mercato/shared/lib/commands/helpers'
import { extractUndoPayload } from '@open-mercato/shared/lib/commands/undo'
import { runCrudCommandWrite } from '@open-mercato/shared/lib/commands/runCrudCommandWrite'
import { ensureOrganizationScope, ensureTenantScope } from '@open-mercato/shared/lib/commands/scope'
import { assertOptimisticLock } from '@open-mercato/shared/lib/crud/optimistic-lock-command'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import type { CrudEventsConfig, CrudIndexerConfig } from '@open-mercato/shared/lib/crud/types'
import { CostInput, CostInputRevisionSecret } from '../data/entities'
import type { CostInputSource, CostInputType } from '../data/entities'
import { costInputCreateSchema, costInputUpdateSchema } from '../data/validators'
import type { CostInputCurrencyResolver } from '../lib/cost-input-currency'
import {
  COST_INPUT_ENTITY_ID,
  COST_INPUT_RESOURCE_KIND,
  costInputHttpError,
} from './cost-input-errors'

type ScopedCommandInput = { tenantId: string; organizationId: string }

/**
 * Audit snapshot.
 *
 * Deliberately description-free. The audit trail records that a description
 * changed and where its ciphertext lives (`revisionSecretId`), never the text —
 * an audit log has a different retention and a wider readership than the row it
 * describes, and cost descriptions routinely carry account numbers.
 */
type CostInputSnapshot = {
  id: string
  tenantId: string
  organizationId: string
  periodStart: string
  periodEnd: string
  costType: CostInputType
  userId: string | null
  channelId: string | null
  amountMinor: string
  currencyCode: string
  source: CostInputSource
  providerInvoiceRef: string | null
  providerLineRef: string | null
  createdByUserId: string | null
  updatedByUserId: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

type CostInputUndoPayload = {
  before?: CostInputSnapshot | null
  after?: CostInputSnapshot | null
  descriptionChanged: boolean
  revisionSecretId: string | null
}

type CostInputCommandResult = {
  entityId: string
  updatedAt?: Date
  /** Where the encrypted before/after description for this mutation lives. */
  revisionSecretId?: string | null
  descriptionChanged?: boolean
}

const costInputCrudIndexer: CrudIndexerConfig<CostInput> = {
  entityType: COST_INPUT_ENTITY_ID,
}

const costInputCrudEvents: CrudEventsConfig<CostInput> = {
  module: 'connect_analytics',
  entity: 'cost_input',
  persistent: true,
  /**
   * Identifiers, scope and version only. An amount or a provider reference here
   * would republish commercially sensitive data into persistent event storage.
   */
  buildPayload: (emitContext) => ({
    id: emitContext.identifiers.id,
    tenantId: emitContext.identifiers.tenantId,
    organizationId: emitContext.identifiers.organizationId,
    updatedAt: emitContext.entity?.updatedAt instanceof Date
      ? emitContext.entity.updatedAt.toISOString()
      : null,
  }),
}

function toIso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null
}

function snapshotOf(record: CostInput): CostInputSnapshot {
  return {
    id: record.id,
    tenantId: record.tenantId,
    organizationId: record.organizationId,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    costType: record.costType,
    userId: record.userId,
    channelId: record.channelId,
    amountMinor: String(record.amountMinor),
    currencyCode: record.currencyCode,
    source: record.source,
    providerInvoiceRef: record.providerInvoiceRef,
    providerLineRef: record.providerLineRef,
    createdByUserId: record.createdByUserId,
    updatedByUserId: record.updatedByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    deletedAt: toIso(record.deletedAt),
  }
}

function seedFromSnapshot(snapshot: CostInputSnapshot): RequiredEntityData<CostInput> {
  return {
    id: snapshot.id,
    tenantId: snapshot.tenantId,
    organizationId: snapshot.organizationId,
    periodStart: new Date(snapshot.periodStart),
    periodEnd: new Date(snapshot.periodEnd),
    costType: snapshot.costType,
    userId: snapshot.userId,
    channelId: snapshot.channelId,
    amountMinor: snapshot.amountMinor,
    currencyCode: snapshot.currencyCode,
    source: snapshot.source,
    providerInvoiceRef: snapshot.providerInvoiceRef,
    providerLineRef: snapshot.providerLineRef,
    description: null,
    createdByUserId: snapshot.createdByUserId,
    updatedByUserId: snapshot.updatedByUserId,
    createdAt: new Date(snapshot.createdAt),
    updatedAt: new Date(snapshot.updatedAt),
    deletedAt: snapshot.deletedAt ? new Date(snapshot.deletedAt) : null,
  }
}

function restoreFromSnapshot(record: CostInput, snapshot: CostInputSnapshot): void {
  record.tenantId = snapshot.tenantId
  record.organizationId = snapshot.organizationId
  record.periodStart = new Date(snapshot.periodStart)
  record.periodEnd = new Date(snapshot.periodEnd)
  record.costType = snapshot.costType
  record.userId = snapshot.userId
  record.channelId = snapshot.channelId
  record.amountMinor = snapshot.amountMinor
  record.currencyCode = snapshot.currencyCode
  record.source = snapshot.source
  record.providerInvoiceRef = snapshot.providerInvoiceRef
  record.providerLineRef = snapshot.providerLineRef
  record.createdByUserId = snapshot.createdByUserId
  record.updatedByUserId = snapshot.updatedByUserId
  record.createdAt = new Date(snapshot.createdAt)
  record.updatedAt = new Date(snapshot.updatedAt)
  record.deletedAt = snapshot.deletedAt ? new Date(snapshot.deletedAt) : null
}

function resolveActorUserId(ctx: { auth: { sub?: string } | null }): string | null {
  const sub = ctx.auth?.sub
  return typeof sub === 'string' && sub.length > 0 ? sub : null
}

/**
 * Fails closed on every dependency outcome that is not an exact base-currency
 * match. Storing `amount_minor` against an unverified code would make the
 * number meaningless in exactly the reports this table exists to feed.
 */
async function assertScopeBaseCurrency(
  container: { resolve: (name: string) => unknown },
  scope: ScopedCommandInput,
  submittedCode: string,
): Promise<void> {
  const { translate } = await resolveTranslations()

  let resolver: CostInputCurrencyResolver
  try {
    resolver = container.resolve('costInputCurrencyResolver') as CostInputCurrencyResolver
  } catch {
    throw costInputHttpError(422, 'currency_validation_unavailable', translate)
  }
  if (!resolver || typeof resolver.resolve !== 'function') {
    throw costInputHttpError(422, 'currency_validation_unavailable', translate)
  }

  const resolution = await resolver.resolve(scope)
  if (resolution.status !== 'resolved') {
    throw costInputHttpError(422, 'currency_validation_unavailable', translate)
  }
  if (resolution.code !== submittedCode) {
    throw costInputHttpError(422, 'currency_invalid', translate)
  }
}

/**
 * Re-checks the scoped partial-unique provider identity before writing.
 *
 * The database constraint is the real arbiter, but a pre-check turns the common
 * case into a localized 409 instead of a driver error, and it is what stops an
 * update from silently targeting a *different* row than the caller edited.
 */
async function assertProviderIdentityFree(
  em: EntityManager,
  scope: ScopedCommandInput,
  identity: { providerInvoiceRef: string | null; providerLineRef: string | null; source: CostInputSource },
  excludeId: string | null,
): Promise<void> {
  if (identity.source !== 'provider_invoice') return
  if (!identity.providerInvoiceRef || !identity.providerLineRef) return

  const clash = await em.findOne(CostInput, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    source: 'provider_invoice',
    providerInvoiceRef: identity.providerInvoiceRef,
    providerLineRef: identity.providerLineRef,
    deletedAt: null,
    ...(excludeId ? { id: { $ne: excludeId } } : {}),
  })
  if (!clash) return

  const { translate } = await resolveTranslations()
  throw costInputHttpError(409, 'provider_line_conflict', translate)
}

async function findCostInput(
  em: EntityManager,
  id: string,
  scope: ScopedCommandInput,
  includeDeleted: boolean,
): Promise<CostInput | null> {
  return findOneWithDecryption(
    em,
    CostInput,
    {
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      ...(includeDeleted ? {} : { deletedAt: null }),
    },
    undefined,
    scope,
  )
}

function createRevisionSecret(
  em: EntityManager,
  scope: ScopedCommandInput,
  input: {
    id: string
    costInputId: string
    operation: 'create' | 'update' | 'delete'
    descriptionBefore: string | null
    descriptionAfter: string | null
  },
): void {
  const secret = em.create(CostInputRevisionSecret, {
    id: input.id,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    costInputId: input.costInputId,
    operation: input.operation,
    descriptionBefore: input.descriptionBefore,
    descriptionAfter: input.descriptionAfter,
  })
  em.persist(secret)
}

async function loadRevisionSecret(
  em: EntityManager,
  scope: ScopedCommandInput,
  revisionSecretId: string,
  costInputId: string,
): Promise<CostInputRevisionSecret | null> {
  return findOneWithDecryption(
    em,
    CostInputRevisionSecret,
    {
      id: revisionSecretId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      costInputId,
    },
    undefined,
    scope,
  )
}

function requireScope(ctx: { auth: { tenantId?: string | null } | null; selectedOrganizationId: string | null }, raw: unknown): ScopedCommandInput {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const tenantId = typeof record.tenantId === 'string' ? record.tenantId : ctx.auth?.tenantId ?? null
  const organizationId = typeof record.organizationId === 'string'
    ? record.organizationId
    : ctx.selectedOrganizationId ?? null
  if (!tenantId || !organizationId) {
    throw new CrudHttpError(400, { error: 'organization_scope_required', code: 'organization_scope_required' })
  }
  return { tenantId, organizationId }
}

function withoutCommandScope(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const input = { ...raw } as Record<string, unknown>
  delete input.tenantId
  delete input.organizationId
  return input
}

// ── create ────────────────────────────────────────────────────

const createCostInputCommand: CommandHandler<Record<string, unknown>, CostInputCommandResult> = {
  id: 'connect_analytics.cost_input.create',
  async execute(rawInput, ctx) {
    const parsed = costInputCreateSchema.parse(withoutCommandScope(rawInput))
    const scope = requireScope(ctx, rawInput)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)
    await assertScopeBaseCurrency(ctx.container, scope, parsed.currencyCode)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    await assertProviderIdentityFree(em, scope, {
      source: parsed.source,
      providerInvoiceRef: parsed.providerInvoiceRef ?? null,
      providerLineRef: parsed.providerLineRef ?? null,
    }, null)

    const actorUserId = resolveActorUserId(ctx)
    const recordId = randomUUID()
    const revisionSecretId = randomUUID()
    let record!: CostInput

    await runCrudCommandWrite({
      ctx,
      em,
      entityId: COST_INPUT_ENTITY_ID,
      action: 'created',
      scope,
      events: costInputCrudEvents,
      indexer: costInputCrudIndexer,
      sideEffect: () => ({
        entity: record,
        identifiers: { id: record.id, tenantId: record.tenantId, organizationId: record.organizationId },
      }),
      phases: [
        () => {
          record = em.create(CostInput, {
            id: recordId,
            tenantId: scope.tenantId,
            organizationId: scope.organizationId,
            periodStart: parsed.periodStart,
            periodEnd: parsed.periodEnd,
            costType: parsed.costType,
            userId: parsed.userId ?? null,
            channelId: parsed.channelId ?? null,
            amountMinor: parsed.amountMinor,
            currencyCode: parsed.currencyCode,
            source: parsed.source,
            providerInvoiceRef: parsed.providerInvoiceRef ?? null,
            providerLineRef: parsed.providerLineRef ?? null,
            description: parsed.description ?? null,
            createdByUserId: actorUserId,
            updatedByUserId: actorUserId,
          })
          em.persist(record)
          // Same transaction as the cost row: a revision the mutation rolled
          // back would describe a change that never happened.
          createRevisionSecret(em, scope, {
            id: revisionSecretId,
            costInputId: recordId,
            operation: 'create',
            descriptionBefore: null,
            descriptionAfter: parsed.description ?? null,
          })
        },
      ],
    })

    return {
      entityId: record.id,
      updatedAt: record.updatedAt,
      revisionSecretId,
      descriptionChanged: (parsed.description ?? null) !== null,
    }
  },
  captureAfter: async (rawInput, result, ctx) => {
    const scope = requireScope(ctx, rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const record = await findCostInput(em, result.entityId, scope, true)
    return record ? snapshotOf(record) : null
  },
  buildLog: async ({ snapshots, result }) => {
    const after = snapshots.after as CostInputSnapshot | undefined
    if (!after) return null
    const typedResult = result as CostInputCommandResult
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('connect_analytics.audit.costInput.create', 'Record Connect cost input'),
      resourceKind: COST_INPUT_RESOURCE_KIND,
      resourceId: after.id,
      tenantId: after.tenantId,
      organizationId: after.organizationId,
      snapshotAfter: after,
      payload: {
        undo: {
          after,
          descriptionChanged: typedResult?.descriptionChanged === true,
          revisionSecretId: typedResult?.revisionSecretId ?? null,
        } satisfies CostInputUndoPayload,
      },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<CostInputUndoPayload>(logEntry)
    const after = payload?.after
    if (!after) return
    const scope = { tenantId: after.tenantId, organizationId: after.organizationId }
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const record = await findCostInput(em, after.id, scope, true)
    if (!record) return
    // Undoing a create means deleting a financial row: refuse if somebody has
    // corrected it since, rather than discarding their correction.
    assertOptimisticLock({
      resourceKind: COST_INPUT_RESOURCE_KIND,
      resourceId: record.id,
      expected: after.updatedAt,
      current: record.updatedAt,
    })
    if (record.deletedAt) return

    record.deletedAt = new Date()
    record.updatedByUserId = resolveActorUserId(ctx)
    await em.flush()

    await emitCrudUndoSideEffects({
      dataEngine: ctx.container.resolve('dataEngine') as DataEngine,
      action: 'deleted',
      entity: record,
      identifiers: { id: record.id, tenantId: record.tenantId, organizationId: record.organizationId },
      indexer: costInputCrudIndexer,
      events: costInputCrudEvents,
    })
  },
}

// ── update ────────────────────────────────────────────────────

const updateCostInputCommand: CommandHandler<Record<string, unknown>, CostInputCommandResult> = {
  id: 'connect_analytics.cost_input.update',
  async prepare(rawInput, ctx) {
    const parsed = costInputUpdateSchema.parse(withoutCommandScope(rawInput))
    const scope = requireScope(ctx, rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const record = await findCostInput(em, parsed.id, scope, false)
    if (!record) return {}
    ensureTenantScope(ctx, record.tenantId)
    ensureOrganizationScope(ctx, record.organizationId)
    return { before: snapshotOf(record) }
  },
  async execute(rawInput, ctx) {
    const parsed = costInputUpdateSchema.parse(withoutCommandScope(rawInput))
    const scope = requireScope(ctx, rawInput)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)
    await assertScopeBaseCurrency(ctx.container, scope, parsed.currencyCode)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const record = await findCostInput(em, parsed.id, scope, false)
    if (!record) {
      const { translate } = await resolveTranslations()
      throw costInputHttpError(404, 'cost_input_not_found', translate)
    }

    await assertProviderIdentityFree(em, scope, {
      source: parsed.source,
      providerInvoiceRef: parsed.providerInvoiceRef ?? null,
      providerLineRef: parsed.providerLineRef ?? null,
    }, record.id)

    const descriptionBefore = record.description ?? null
    const descriptionAfter = parsed.description ?? null
    const revisionSecretId = randomUUID()
    const actorUserId = resolveActorUserId(ctx)

    await runCrudCommandWrite({
      ctx,
      em,
      entityId: COST_INPUT_ENTITY_ID,
      action: 'updated',
      scope,
      events: costInputCrudEvents,
      indexer: costInputCrudIndexer,
      sideEffect: () => ({
        entity: record,
        identifiers: { id: record.id, tenantId: record.tenantId, organizationId: record.organizationId },
      }),
      phases: [
        () => {
          record.periodStart = parsed.periodStart
          record.periodEnd = parsed.periodEnd
          record.costType = parsed.costType
          record.userId = parsed.userId ?? null
          record.channelId = parsed.channelId ?? null
          record.amountMinor = parsed.amountMinor
          record.currencyCode = parsed.currencyCode
          record.source = parsed.source
          record.providerInvoiceRef = parsed.providerInvoiceRef ?? null
          record.providerLineRef = parsed.providerLineRef ?? null
          record.description = descriptionAfter
          record.updatedByUserId = actorUserId
          createRevisionSecret(em, scope, {
            id: revisionSecretId,
            costInputId: record.id,
            operation: 'update',
            descriptionBefore,
            descriptionAfter,
          })
        },
      ],
    })

    return {
      entityId: record.id,
      updatedAt: record.updatedAt,
      revisionSecretId,
      descriptionChanged: descriptionBefore !== descriptionAfter,
    }
  },
  captureAfter: async (rawInput, result, ctx) => {
    const scope = requireScope(ctx, rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const record = await findCostInput(em, result.entityId, scope, true)
    return record ? snapshotOf(record) : null
  },
  buildLog: async ({ snapshots, result }) => {
    const before = snapshots.before as CostInputSnapshot | undefined
    const after = snapshots.after as CostInputSnapshot | undefined
    if (!before) return null
    const typedResult = result as CostInputCommandResult
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('connect_analytics.audit.costInput.update', 'Correct Connect cost input'),
      resourceKind: COST_INPUT_RESOURCE_KIND,
      resourceId: before.id,
      tenantId: before.tenantId,
      organizationId: before.organizationId,
      snapshotBefore: before,
      snapshotAfter: after ?? null,
      payload: {
        undo: {
          before,
          after: after ?? null,
          descriptionChanged: typedResult?.descriptionChanged === true,
          revisionSecretId: typedResult?.revisionSecretId ?? null,
        } satisfies CostInputUndoPayload,
      },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<CostInputUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const scope = { tenantId: before.tenantId, organizationId: before.organizationId }
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const record = await findCostInput(em, before.id, scope, true)
    if (!record) return
    if (payload?.after) {
      assertOptimisticLock({
        resourceKind: COST_INPUT_RESOURCE_KIND,
        resourceId: record.id,
        expected: payload.after.updatedAt,
        current: record.updatedAt,
      })
    }
    await assertProviderIdentityFree(em, scope, {
      source: before.source,
      providerInvoiceRef: before.providerInvoiceRef,
      providerLineRef: before.providerLineRef,
    }, record.id)

    restoreFromSnapshot(record, before)
    // The prior description lives only in the revision secret; restoring it
    // goes back through the ordinary encrypted write path.
    if (payload?.descriptionChanged && payload.revisionSecretId) {
      const secret = await loadRevisionSecret(em, scope, payload.revisionSecretId, record.id)
      if (secret) record.description = secret.descriptionBefore ?? null
    }
    record.updatedAt = new Date()
    record.updatedByUserId = resolveActorUserId(ctx)
    await em.flush()

    await emitCrudUndoSideEffects({
      dataEngine: ctx.container.resolve('dataEngine') as DataEngine,
      action: 'updated',
      entity: record,
      identifiers: { id: record.id, tenantId: record.tenantId, organizationId: record.organizationId },
      indexer: costInputCrudIndexer,
      events: costInputCrudEvents,
    })
  },
}

// ── delete ────────────────────────────────────────────────────

const deleteCostInputCommand: CommandHandler<Record<string, unknown>, CostInputCommandResult> = {
  id: 'connect_analytics.cost_input.delete',
  async prepare(rawInput, ctx) {
    const id = requireId(rawInput, 'connect_analytics.errors.costInputIdRequired')
    const scope = requireScope(ctx, rawInput)
    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const record = await findCostInput(em, id, scope, false)
    if (!record) return {}
    ensureTenantScope(ctx, record.tenantId)
    ensureOrganizationScope(ctx, record.organizationId)
    return { before: snapshotOf(record) }
  },
  async execute(rawInput, ctx) {
    const id = requireId(rawInput, 'connect_analytics.errors.costInputIdRequired')
    const scope = requireScope(ctx, rawInput)
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    const record = await findCostInput(em, id, scope, false)
    if (!record) {
      const { translate } = await resolveTranslations()
      throw costInputHttpError(404, 'cost_input_not_found', translate)
    }

    const descriptionBefore = record.description ?? null
    const revisionSecretId = randomUUID()
    const actorUserId = resolveActorUserId(ctx)

    await runCrudCommandWrite({
      ctx,
      em,
      entityId: COST_INPUT_ENTITY_ID,
      action: 'deleted',
      scope,
      events: costInputCrudEvents,
      indexer: costInputCrudIndexer,
      sideEffect: () => ({
        entity: record,
        identifiers: { id: record.id, tenantId: record.tenantId, organizationId: record.organizationId },
      }),
      phases: [
        () => {
          record.deletedAt = new Date()
          record.updatedByUserId = actorUserId
          createRevisionSecret(em, scope, {
            id: revisionSecretId,
            costInputId: record.id,
            operation: 'delete',
            descriptionBefore,
            descriptionAfter: null,
          })
        },
      ],
    })

    return {
      entityId: record.id,
      updatedAt: record.updatedAt,
      revisionSecretId,
      descriptionChanged: descriptionBefore !== null,
    }
  },
  buildLog: async ({ snapshots, result }) => {
    const before = snapshots.before as CostInputSnapshot | undefined
    if (!before) return null
    const typedResult = result as CostInputCommandResult
    const { translate } = await resolveTranslations()
    return {
      actionLabel: translate('connect_analytics.audit.costInput.delete', 'Delete Connect cost input'),
      resourceKind: COST_INPUT_RESOURCE_KIND,
      resourceId: before.id,
      tenantId: before.tenantId,
      organizationId: before.organizationId,
      snapshotBefore: before,
      payload: {
        undo: {
          before,
          descriptionChanged: typedResult?.descriptionChanged === true,
          revisionSecretId: typedResult?.revisionSecretId ?? null,
        } satisfies CostInputUndoPayload,
      },
    }
  },
  undo: async ({ logEntry, ctx }) => {
    const payload = extractUndoPayload<CostInputUndoPayload>(logEntry)
    const before = payload?.before
    if (!before) return
    const scope = { tenantId: before.tenantId, organizationId: before.organizationId }
    ensureTenantScope(ctx, scope.tenantId)
    ensureOrganizationScope(ctx, scope.organizationId)

    const em = (ctx.container.resolve('em') as EntityManager).fork()
    let record = await findCostInput(em, before.id, scope, true)
    // Restoring a provider row whose identity has since been re-imported would
    // recreate the duplicate the partial unique index exists to prevent.
    await assertProviderIdentityFree(em, scope, {
      source: before.source,
      providerInvoiceRef: before.providerInvoiceRef,
      providerLineRef: before.providerLineRef,
    }, before.id)

    if (!record) {
      record = em.create(CostInput, seedFromSnapshot(before))
      em.persist(record)
    } else {
      restoreFromSnapshot(record, before)
    }
    record.deletedAt = null
    if (payload?.descriptionChanged && payload.revisionSecretId) {
      const secret = await loadRevisionSecret(em, scope, payload.revisionSecretId, record.id)
      if (secret) record.description = secret.descriptionBefore ?? null
    }
    record.updatedAt = new Date()
    record.updatedByUserId = resolveActorUserId(ctx)
    await em.flush()

    await emitCrudUndoSideEffects({
      dataEngine: ctx.container.resolve('dataEngine') as DataEngine,
      action: 'created',
      entity: record,
      identifiers: { id: record.id, tenantId: record.tenantId, organizationId: record.organizationId },
      indexer: costInputCrudIndexer,
      events: costInputCrudEvents,
    })
  },
}

registerCommand(createCostInputCommand)
registerCommand(updateCostInputCommand)
registerCommand(deleteCostInputCommand)

export {
  createCostInputCommand,
  updateCostInputCommand,
  deleteCostInputCommand,
}

import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import type { CrudCtx } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { resolveActiveOrganizationId } from '@open-mercato/shared/lib/auth/organizationScope'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { findOneWithDecryption, findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { CostInput } from '../../data/entities'
import {
  costInputCreateSchema,
  costInputListQuerySchema,
  costInputUpdateSchema,
  type CostInputListQuery,
} from '../../data/validators'
import {
  COST_INPUT_ENTITY_ID,
  costInputCodeFromIssueMessage,
  costInputErrorBody,
  costInputHttpError,
} from '../../commands/cost-input-errors'
import {
  costInputCreateResponseSchema,
  costInputErrorSchema,
  costInputItemSchema,
  costInputOpenApiCreateSchema,
  costInputOpenApiQuerySchema,
  costInputOpenApiUpdateSchema,
  costInputUpdateResponseSchema,
  createConnectAnalyticsCrudOpenApi,
  createPagedListResponseSchema,
  defaultOkResponseSchema,
} from '../openapi'

type TranslateFn = (key: string, fallback?: string) => string

const rawBodySchema = z.object({}).passthrough()

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['connect_analytics.cost_inputs.view'] },
  POST: { requireAuth: true, requireFeatures: ['connect_analytics.cost_inputs.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['connect_analytics.cost_inputs.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['connect_analytics.cost_inputs.manage'] },
}

export const metadata = routeMetadata

/**
 * Server-derived dual scope. A client-supplied `tenantId` / `organizationId` is
 * never read — it is the one input that, if trusted, turns every other check in
 * this route into decoration.
 */
function requireScope(ctx: CrudCtx, translate: TranslateFn): { tenantId: string; organizationId: string } {
  const tenantId = ctx.auth?.tenantId ?? null
  const organizationId = ctx.selectedOrganizationId ?? resolveActiveOrganizationId(ctx.auth)
  if (!tenantId || !organizationId) {
    throw new CrudHttpError(400, costInputErrorBody('organization_scope_required', translate))
  }
  return { tenantId, organizationId }
}

function stripFactoryScope(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const input = { ...raw } as Record<string, unknown>
  delete input.tenantId
  delete input.organizationId
  return input
}

/**
 * Re-throws a Zod failure as the published 422 vocabulary so a client can branch
 * on `code` instead of parsing issue paths.
 */
function rethrowAsCostInputError(err: unknown, translate: TranslateFn): never {
  if (err instanceof z.ZodError) {
    for (const issue of err.issues) {
      const code = costInputCodeFromIssueMessage(issue.message)
      if (code) throw costInputHttpError(422, code, translate)
    }
    throw new CrudHttpError(422, {
      error: translate('connect_analytics.errors.invalidCostInput', 'The cost input could not be validated.'),
      code: 'invalid_cost_input',
      details: err.issues,
    })
  }
  throw err
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'string' || value.length === 0) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Never `Number(...)`: a 64-bit minor-unit amount does not survive IEEE-754. */
function toAmountString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value.toString()
  return String(value)
}

function buildFilters(query: CostInputListQuery): Record<string, unknown> {
  const filters: Record<string, unknown> = {}
  if (query.id) filters.id = { $eq: query.id }
  if (query.costType) filters.cost_type = { $eq: query.costType }
  if (query.currencyCode) filters.currency_code = { $eq: query.currencyCode }
  if (query.source) filters.source = { $eq: query.source }
  if (query.userId) filters.user_id = { $eq: query.userId }
  if (query.channelId) filters.channel_id = { $eq: query.channelId }
  if (query.periodStart && query.periodEnd) {
    // Half-open overlap, matching the sanitized reader exactly: a row that only
    // abuts the requested window is not in it.
    filters.period_start = { $lt: new Date(query.periodEnd) }
    filters.period_end = { $gt: new Date(query.periodStart) }
  }
  return filters
}

function transformCostInputItem(item: unknown) {
  if (!item || typeof item !== 'object') return item
  const record = item as Record<string, unknown>
  return {
    id: record.id,
    periodStart: toIsoString(record.period_start),
    periodEnd: toIsoString(record.period_end),
    costType: record.cost_type ?? null,
    userId: record.user_id ?? null,
    channelId: record.channel_id ?? null,
    amountMinor: toAmountString(record.amount_minor),
    currencyCode: record.currency_code ?? null,
    source: record.source ?? null,
    providerInvoiceRef: record.provider_invoice_ref ?? null,
    providerLineRef: record.provider_line_ref ?? null,
    createdByUserId: record.created_by_user_id ?? null,
    updatedByUserId: record.updated_by_user_id ?? null,
    createdAt: toIsoString(record.created_at),
    updatedAt: toIsoString(record.updated_at),
  }
}

/**
 * `description` is deliberately absent: it is encrypted sensitive free text, so
 * the grid never selects (and never decrypts) it per row. The detail read adds
 * it back in `afterList` once the caller has proven scope and feature.
 */
const listFields = [
  'id',
  'period_start',
  'period_end',
  'cost_type',
  'user_id',
  'channel_id',
  'amount_minor',
  'currency_code',
  'source',
  'provider_invoice_ref',
  'provider_line_ref',
  'created_by_user_id',
  'updated_by_user_id',
  'created_at',
  'updated_at',
]

type ProviderIdentity = {
  providerInvoiceRef: string
  providerLineRef: string
}

/**
 * Exact-payload provider replay.
 *
 * An invoice importer that retries after a lost response must not create a
 * second row for the same charge, and must not silently accept a *different*
 * charge under an identity that is already taken. So an identical retry returns
 * the original result and writes nothing, and any difference is a 409.
 *
 * Manual rows deliberately have no replay: there is no external identity to
 * deduplicate on, and inferring one from the payload would silently swallow a
 * legitimate second charge of the same amount.
 */
async function detectProviderReplay(
  ctx: CrudCtx,
  scope: { tenantId: string; organizationId: string },
  identity: ProviderIdentity,
  candidate: z.infer<typeof costInputCreateSchema>,
  translate: TranslateFn,
): Promise<void> {
  const em = (ctx.container.resolve('em') as EntityManager).fork()
  const existing = await findOneWithDecryption(
    em,
    CostInput,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      source: 'provider_invoice',
      providerInvoiceRef: identity.providerInvoiceRef,
      providerLineRef: identity.providerLineRef,
      deletedAt: null,
    },
    undefined,
    scope,
  )
  if (!existing) return

  const identical = existing.periodStart.getTime() === candidate.periodStart.getTime()
    && existing.periodEnd.getTime() === candidate.periodEnd.getTime()
    && existing.costType === candidate.costType
    && (existing.userId ?? null) === (candidate.userId ?? null)
    && (existing.channelId ?? null) === (candidate.channelId ?? null)
    && String(existing.amountMinor) === candidate.amountMinor
    && existing.currencyCode === candidate.currencyCode
    && (existing.description ?? null) === (candidate.description ?? null)

  if (!identical) throw costInputHttpError(409, 'provider_line_conflict', translate)

  // The CRUD factory has no dynamic status hook, and a replay must answer 200
  // rather than 201 because nothing was created. Signalling it as a
  // `CrudHttpError` is what lets this short-circuit before any command runs, so
  // no duplicate event or audit entry is emitted.
  throw new CrudHttpError(200, {
    id: existing.id,
    updatedAt: existing.updatedAt.toISOString(),
    replayed: true,
  })
}

async function mapCreateInput({ raw, ctx }: { raw: unknown; ctx: CrudCtx }) {
  const { translate } = await resolveTranslations()
  const scope = requireScope(ctx, translate)
  let parsed: z.infer<typeof costInputCreateSchema>
  try {
    parsed = costInputCreateSchema.parse(stripFactoryScope(raw) ?? {})
  } catch (err) {
    rethrowAsCostInputError(err, translate)
  }
  if (parsed.source === 'provider_invoice' && parsed.providerInvoiceRef && parsed.providerLineRef) {
    await detectProviderReplay(
      ctx,
      scope,
      { providerInvoiceRef: parsed.providerInvoiceRef, providerLineRef: parsed.providerLineRef },
      parsed,
      translate,
    )
  }
  return { ...parsed, tenantId: scope.tenantId, organizationId: scope.organizationId }
}

async function mapUpdateInput({ raw, ctx }: { raw: unknown; ctx: CrudCtx }) {
  const { translate } = await resolveTranslations()
  const scope = requireScope(ctx, translate)
  let parsed: z.infer<typeof costInputUpdateSchema>
  try {
    parsed = costInputUpdateSchema.parse(stripFactoryScope(raw) ?? {})
  } catch (err) {
    rethrowAsCostInputError(err, translate)
  }
  return { ...parsed, tenantId: scope.tenantId, organizationId: scope.organizationId }
}

async function mapDeleteInput({ ctx }: { ctx: CrudCtx }) {
  const { translate } = await resolveTranslations()
  const scope = requireScope(ctx, translate)
  const rawId = ctx.request ? new URL(ctx.request.url).searchParams.get('id') : null
  const parsedId = z.string().uuid().safeParse(rawId ?? '')
  if (!parsedId.success) {
    throw new CrudHttpError(400, costInputErrorBody('cost_input_not_found', translate))
  }
  return { id: parsedId.data, tenantId: scope.tenantId, organizationId: scope.organizationId }
}

const crud = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: CostInput,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  indexer: { entityType: COST_INPUT_ENTITY_ID },
  list: {
    schema: costInputListQuerySchema,
    entityId: COST_INPUT_ENTITY_ID,
    fields: listFields,
    sortFieldMap: {
      periodStart: 'period_start',
      periodEnd: 'period_end',
      costType: 'cost_type',
      amountMinor: 'amount_minor',
      currencyCode: 'currency_code',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    tiebreakSortField: 'id',
    buildFilters,
    transformItem: transformCostInputItem,
  },
  actions: {
    create: {
      commandId: 'connect_analytics.cost_input.create',
      schema: rawBodySchema,
      mapInput: mapCreateInput,
      response: ({ result }) => ({
        id: result?.entityId ?? result?.id ?? null,
        updatedAt: result?.updatedAt instanceof Date ? result.updatedAt.toISOString() : null,
        replayed: false,
      }),
      status: 201,
    },
    update: {
      commandId: 'connect_analytics.cost_input.update',
      schema: rawBodySchema,
      mapInput: mapUpdateInput,
      response: ({ result }) => ({
        id: result?.entityId ?? result?.id ?? null,
        updatedAt: result?.updatedAt instanceof Date ? result.updatedAt.toISOString() : null,
      }),
    },
    delete: {
      commandId: 'connect_analytics.cost_input.delete',
      schema: rawBodySchema,
      mapInput: mapDeleteInput,
      response: () => ({ ok: true }),
    },
  },
  hooks: {
    /**
     * Detail-read only. Decrypting a description per row on a 100-row grid would
     * both cost a KMS round trip per row and put sensitive text into a response
     * no column renders.
     */
    afterList: async (payload, ctx) => {
      const detailId = typeof ctx.query.id === 'string' ? ctx.query.id : null
      if (!detailId) return
      const items: unknown[] = Array.isArray(payload?.items) ? payload.items : []
      if (!items.length) return
      const tenantId = ctx.auth?.tenantId ?? null
      const organizationId = ctx.selectedOrganizationId ?? resolveActiveOrganizationId(ctx.auth)
      if (!tenantId || !organizationId) return

      const ids = items
        .map((item) => (item && typeof item === 'object' ? asStringOrNull((item as Record<string, unknown>).id) : null))
        .filter((id): id is string => id !== null)
      if (!ids.length) return

      const em = ctx.container.resolve('em') as EntityManager
      const where: FilterQuery<CostInput> = {
        id: { $in: ids },
        tenantId,
        organizationId,
        deletedAt: null,
      }
      const decrypted = await findWithDecryption(em, CostInput, where, {}, { tenantId, organizationId })
      const byId = new Map(decrypted.map((row) => [row.id, row]))
      for (const item of items) {
        if (!item || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const id = asStringOrNull(record.id)
        const found = id ? byId.get(id) : null
        record.description = found?.description ?? null
      }
    },
  },
})

export const GET = crud.GET
export const POST = crud.POST
export const PUT = crud.PUT
export const DELETE = crud.DELETE

export const openApi = createConnectAnalyticsCrudOpenApi({
  resourceName: 'Cost input',
  querySchema: costInputOpenApiQuerySchema,
  listResponseSchema: createPagedListResponseSchema(costInputItemSchema),
  create: {
    schema: costInputOpenApiCreateSchema,
    responseSchema: costInputCreateResponseSchema,
    description:
      'Records a cost input for the scoped organization. An exact provider invoice-line retry returns the original row with `replayed: true` and HTTP 200; a changed payload for a taken identity returns 409.',
  },
  update: {
    schema: costInputOpenApiUpdateSchema,
    responseSchema: costInputUpdateResponseSchema,
    description:
      'Corrects a cost input. Requires the `x-om-ext-optimistic-lock-expected-updated-at` header; a stale version returns the unified 409 conflict body.',
  },
  del: {
    schema: z.object({ id: z.string().uuid() }),
    responseSchema: defaultOkResponseSchema,
    description: 'Soft-deletes a cost input by id from the query string. Requires the optimistic-lock header.',
    errors: [
      { status: 404, description: 'Unknown, already deleted, or out-of-scope identifier.', schema: costInputErrorSchema },
    ],
  },
})

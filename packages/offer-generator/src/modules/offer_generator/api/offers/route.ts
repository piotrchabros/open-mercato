import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { createScopedApiHelpers } from '@open-mercato/shared/lib/api/scoped'
import { escapeLikePattern } from '@open-mercato/shared/lib/db/escapeLikePattern'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createPagedListResponseSchema, defaultOkResponseSchema } from '@open-mercato/shared/lib/openapi/crud'
import { OFFER_COMMAND_IDS, type OfferCommandResult } from '../../commands/offers'
import { Offer } from '../../data/entities'
import {
  offerCreateSchema,
  offerCustomerKindSchema,
  offerGenerationStatusSchema,
  offerLanguageSchema,
  offerStatusSchema,
  offerUpdateSchema,
} from '../../data/validators'
import { ENTITY_IDS } from '../../lib/constants'
import { serializeOffer, type OfferDto } from '../../lib/serializers'
import { buildOfferGeneratorCrudOpenApi, offerDtoSchema } from '../openapi'

const { withScopedPayload } = createScopedApiHelpers({
  messages: {
    tenantRequired: { key: 'offer_generator.errors.tenantRequired', fallback: 'Tenant context is required' },
    organizationRequired: {
      key: 'offer_generator.errors.organizationRequired',
      fallback: 'Organization context is required',
    },
  },
})

const rawBodySchema = z.object({}).passthrough()

const listSchema = z
  .object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(50),
    id: z.string().uuid().optional(),
    search: z.string().max(200).optional(),
    status: offerStatusSchema.optional(),
    customerEntityId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    sortField: z.string().optional(),
    sortDir: z.enum(['asc', 'desc']).optional(),
  })
  .passthrough()

type OfferListQuery = z.infer<typeof listSchema>

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['offer_generator.view'] },
  POST: { requireAuth: true, requireFeatures: ['offer_generator.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['offer_generator.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['offer_generator.manage'] },
}

export const metadata = routeMetadata

const listFields = [
  'id',
  'tenant_id',
  'organization_id',
  'owner_user_id',
  'title',
  'client_name',
  'language',
  'status',
  'customer_entity_id',
  'customer_kind',
  'deal_id',
  'slug',
  'access_token',
  'html_updated_at',
  'value_amount',
  'currency_code',
  'valid_until',
  'sent_at',
  'viewed_at',
  'responded_at',
  'view_count',
  'last_viewed_at',
  'generation_status',
  'last_generation_run_id',
  'created_at',
  'updated_at',
]

const detailFields = [...listFields, 'prompt', 'notes']

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readDateLike(value: unknown): Date | string | null {
  if (value instanceof Date) return value
  return readString(value)
}

function readAmount(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return readString(value)
}

function readCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export function toOfferDto(item: Record<string, unknown>): OfferDto {
  const detail = 'prompt' in item || 'notes' in item
  return serializeOffer(
    {
      id: String(item.id),
      title: readString(item.title) ?? '',
      clientName: readString(item.client_name) ?? '',
      language: offerLanguageSchema.catch('pl').parse(item.language),
      status: offerStatusSchema.catch('draft').parse(item.status),
      slug: readString(item.slug) ?? '',
      accessToken: readString(item.access_token) ?? '',
      viewCount: readCount(item.view_count),
      generationStatus: offerGenerationStatusSchema.catch('idle').parse(item.generation_status),
      customerEntityId: readString(item.customer_entity_id),
      customerKind: offerCustomerKindSchema.nullable().catch(null).parse(item.customer_kind ?? null),
      dealId: readString(item.deal_id),
      ownerUserId: readString(item.owner_user_id),
      currencyCode: readString(item.currency_code),
      lastGenerationRunId: readString(item.last_generation_run_id),
      prompt: detail ? readString(item.prompt) : undefined,
      notes: detail ? readString(item.notes) : undefined,
      valueAmount: readAmount(item.value_amount),
      validUntil: readDateLike(item.valid_until),
      htmlUpdatedAt: readDateLike(item.html_updated_at),
      sentAt: readDateLike(item.sent_at),
      viewedAt: readDateLike(item.viewed_at),
      respondedAt: readDateLike(item.responded_at),
      lastViewedAt: readDateLike(item.last_viewed_at),
      createdAt: readDateLike(item.created_at),
      updatedAt: readDateLike(item.updated_at),
    },
    { detail },
  )
}

export function buildOfferListFilters(query: Partial<OfferListQuery>): Record<string, unknown> {
  const filters: Record<string, unknown> = {}
  if (query.id) filters.id = { $eq: query.id }
  if (query.status) filters.status = { $eq: query.status }
  if (query.customerEntityId) filters.customer_entity_id = { $eq: query.customerEntityId }
  if (query.dealId) filters.deal_id = { $eq: query.dealId }
  const term = typeof query.search === 'string' ? query.search.trim() : ''
  if (term) {
    const pattern = `%${escapeLikePattern(term)}%`
    filters.$or = [{ title: { $ilike: pattern } }, { client_name: { $ilike: pattern } }]
  }
  return filters
}

export function resolveOfferListFields(query: Partial<OfferListQuery>): string[] {
  return typeof query.id === 'string' && query.id.length > 0 ? detailFields : listFields
}

const crud = makeCrudRoute<Record<string, unknown>, Record<string, unknown>, OfferListQuery>({
  metadata: routeMetadata,
  orm: {
    entity: Offer,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  indexer: { entityType: ENTITY_IDS.offer },
  list: {
    schema: listSchema,
    entityId: ENTITY_IDS.offer,
    fields: (query) => resolveOfferListFields(query),
    sortFieldMap: {
      title: 'title',
      clientName: 'client_name',
      status: 'status',
      valueAmount: 'value_amount',
      validUntil: 'valid_until',
      viewCount: 'view_count',
      lastViewedAt: 'last_viewed_at',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    defaultSort: { field: 'updatedAt', dir: 'desc' },
    tiebreakSortField: 'id',
    buildFilters: (query) => buildOfferListFilters(query),
    transformItem: (item: Record<string, unknown>) => toOfferDto(item),
  },
  actions: {
    create: {
      commandId: OFFER_COMMAND_IDS.create,
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        return offerCreateSchema.parse(withScopedPayload(raw ?? {}, ctx, translate))
      },
      response: ({ result }: { result: OfferCommandResult | null }) => ({ id: result?.offerId ?? null }),
      status: 201,
    },
    update: {
      commandId: OFFER_COMMAND_IDS.update,
      schema: rawBodySchema,
      mapInput: async ({ raw, ctx }) => {
        const { translate } = await resolveTranslations()
        return offerUpdateSchema.parse(withScopedPayload(raw ?? {}, ctx, translate))
      },
      response: () => ({ ok: true }),
    },
    delete: {
      commandId: OFFER_COMMAND_IDS.delete,
      schema: rawBodySchema,
      mapInput: async ({ parsed, ctx }) => {
        const { translate } = await resolveTranslations()
        const id =
          parsed?.body?.id ??
          parsed?.id ??
          parsed?.query?.id ??
          (ctx.request ? new URL(ctx.request.url).searchParams.get('id') : null)
        if (!id) {
          throw new CrudHttpError(400, { error: translate('offer_generator.errors.idRequired', 'Offer id is required') })
        }
        return { id }
      },
      response: () => ({ ok: true }),
    },
  },
})

export const { GET, POST, PUT, DELETE } = crud

const offerCreateRequestSchema = offerCreateSchema.omit({ tenantId: true, organizationId: true })
const offerUpdateRequestSchema = offerUpdateSchema.omit({ tenantId: true, organizationId: true })

export const openApi = buildOfferGeneratorCrudOpenApi({
  resourceName: 'Offer',
  description:
    'Returns a paginated collection of offers scoped to the authenticated organization. The offer HTML is never part of this response; prompt and notes are only returned when a single offer is requested with `?id=`.',
  querySchema: listSchema,
  listResponseSchema: createPagedListResponseSchema(offerDtoSchema),
  create: {
    schema: offerCreateRequestSchema,
    responseSchema: z.object({ id: z.string().uuid().nullable() }),
    description:
      'Creates an offer in the active organization. The public slug and access token are generated server-side; the currency defaults to the organization settings.',
  },
  update: {
    schema: offerUpdateRequestSchema,
    responseSchema: defaultOkResponseSchema,
    description:
      'Updates offer metadata (not the HTML). Honors the optimistic-lock header and answers 409 when the offer changed meanwhile.',
  },
  del: {
    schema: z.object({ id: z.string().uuid() }),
    responseSchema: defaultOkResponseSchema,
    description: 'Soft-deletes an offer identified by `id` (body or query string). Its public link stops working.',
  },
})

import { z, type ZodTypeAny } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  createCrudOpenApiFactory,
  createPagedListResponseSchema as createSharedPagedListResponseSchema,
  defaultOkResponseSchema as sharedDefaultOkResponseSchema,
  type CrudOpenApiOptions,
} from '@open-mercato/shared/lib/openapi/crud'
import {
  COST_INPUT_SORT_FIELDS,
  COST_INPUT_SOURCES,
  COST_INPUT_TYPES,
} from '../data/validators'

export const defaultOkResponseSchema = sharedDefaultOkResponseSchema

export function createPagedListResponseSchema(itemSchema: ZodTypeAny) {
  return createSharedPagedListResponseSchema(itemSchema, { paginationMetaOptional: true })
}

const buildConnectAnalyticsCrudOpenApi = createCrudOpenApiFactory({
  defaultTag: 'Connect Analytics',
  defaultOkResponseSchema,
  makeListDescription: ({ pluralLower }) =>
    `Returns a paginated collection of ${pluralLower} scoped to the authenticated organization.`,
})

export function createConnectAnalyticsCrudOpenApi(options: CrudOpenApiOptions): OpenApiRouteDoc {
  return buildConnectAnalyticsCrudOpenApi(options)
}

/**
 * `amount_minor` is published as a bounded decimal STRING, never a JSON number.
 * A 64-bit minor-unit amount does not survive IEEE-754, so the OpenAPI contract
 * has to say string as loudly as the runtime schema does.
 */
export const amountMinorOpenApiSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .describe('Amount in minor units as a canonical decimal string; maximum 9223372036854775807.')

export const costInputItemSchema = z.object({
  id: z.string().uuid(),
  periodStart: z.string(),
  periodEnd: z.string(),
  costType: z.enum(COST_INPUT_TYPES),
  userId: z.string().uuid().nullable(),
  channelId: z.string().uuid().nullable(),
  amountMinor: amountMinorOpenApiSchema,
  currencyCode: z.string(),
  source: z.enum(COST_INPUT_SOURCES),
  providerInvoiceRef: z.string().nullable(),
  providerLineRef: z.string().nullable(),
  /** Present only on a `?id=` detail read, after scope and feature checks. */
  description: z.string().nullable().optional(),
  createdByUserId: z.string().uuid().nullable(),
  updatedByUserId: z.string().uuid().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
})

export const costInputCreateResponseSchema = z.object({
  id: z.string().uuid(),
  updatedAt: z.string().nullable(),
  /**
   * True when an exact provider-invoice-line retry matched an existing row: the
   * original result is returned and no second row, event or audit entry exists.
   */
  replayed: z.boolean(),
})

export const costInputUpdateResponseSchema = z.object({
  id: z.string().uuid(),
  updatedAt: z.string().nullable(),
})

export const costInputOpenApiQuerySchema = z.object({
  id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  sortField: z.enum(COST_INPUT_SORT_FIELDS).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  costType: z.enum(COST_INPUT_TYPES).optional(),
  currencyCode: z.string().optional(),
  source: z.enum(COST_INPUT_SOURCES).optional(),
  userId: z.string().uuid().optional(),
  channelId: z.string().uuid().optional(),
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
})

export const costInputOpenApiCreateSchema = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  costType: z.enum(COST_INPUT_TYPES),
  userId: z.string().uuid().nullable().optional(),
  channelId: z.string().uuid().nullable().optional(),
  amountMinor: amountMinorOpenApiSchema,
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  source: z.enum(COST_INPUT_SOURCES),
  providerInvoiceRef: z.string().max(255).nullable().optional(),
  providerLineRef: z.string().max(255).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
})

export const costInputOpenApiUpdateSchema = costInputOpenApiCreateSchema.extend({
  id: z.string().uuid(),
})

export const costInputErrorSchema = z.object({
  error: z.string(),
  code: z.string(),
})

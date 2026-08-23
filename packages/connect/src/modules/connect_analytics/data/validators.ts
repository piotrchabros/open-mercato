import { z } from 'zod'

/**
 * Postgres `bigint` upper bound, and therefore the money ceiling.
 *
 * Declared here rather than next to the entity on purpose: this module must
 * stay importable from a Playwright spec, and pulling in `./entities` would
 * load MikroORM's legacy decorators into a TC39-decorator transform and abort
 * test collection for the whole suite.
 */
export const COST_INPUT_AMOUNT_MINOR_MAX = 9223372036854775807n

export const COST_INPUT_TYPES = ['agent', 'channel', 'ai'] as const
export const COST_INPUT_SOURCES = ['manual', 'provider_invoice'] as const

export const COST_INPUT_DESCRIPTION_MAX_LENGTH = 500
export const COST_INPUT_PROVIDER_REF_MAX_LENGTH = 255
/** Matches the reader bound: a request may never span more than one leap year. */
export const COST_INPUT_MAX_PERIOD_DAYS = 366

/**
 * Canonical money grammar.
 *
 * Only an unsigned decimal string with no leading zero is accepted. JSON
 * numbers, `+`/`-`, decimal points, exponents and whitespace are all rejected
 * rather than coerced, because every one of those forms has a lossy reading
 * once it reaches a 64-bit integer column.
 */
export const AMOUNT_MINOR_PATTERN = /^(0|[1-9][0-9]{0,18})$/

/**
 * Grammar and bound are checked together, in that order, inside one refinement.
 * Zod runs every check on a value even after an earlier one fails, so a
 * `.regex(...).refine(BigInt(value) <= max)` chain would hand `BigInt` a string
 * like `12.50` and throw a raw `SyntaxError` — a 500 where the contract
 * promises a 422.
 */
export const amountMinorSchema = z.string({ error: 'amount_minor_invalid' }).superRefine((value, ctx) => {
  if (!AMOUNT_MINOR_PATTERN.test(value) || BigInt(value) > COST_INPUT_AMOUNT_MINOR_MAX) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'amount_minor_invalid' })
  }
})

export const currencyCodeSchema = z.string({ error: 'currency_invalid' }).regex(/^[A-Z]{3}$/, 'currency_invalid')

/**
 * C0/C1 control characters excluding the five that also count as whitespace —
 * those are collapsed by `normalizeProviderReference` instead of rejected, so
 * a reference pasted out of a spreadsheet cell still normalizes cleanly.
 */
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/
const UNICODE_WHITESPACE_RUN_PATTERN = /\s+/gu

export class ProviderReferenceError extends Error {
  constructor(readonly reason: 'provider_ref_invalid' | 'provider_ref_length') {
    super(`[internal] provider reference rejected: ${reason}`)
    this.name = 'ProviderReferenceError'
  }
}

/**
 * Canonicalizes an invoice or invoice-line identity so a retry of the same
 * import collides with the row it already wrote. Provider portals vary in
 * casing and padding for what they consider one identifier, so uniqueness has
 * to be declared over the normalized form rather than the typed one.
 */
export function normalizeProviderReference(raw: string): string {
  const composed = raw.normalize('NFC')
  if (CONTROL_CHARACTER_PATTERN.test(composed)) throw new ProviderReferenceError('provider_ref_invalid')
  const collapsed = composed.replace(UNICODE_WHITESPACE_RUN_PATTERN, ' ').trim()
  const normalized = collapsed.toLowerCase()
  if (normalized.length < 1 || normalized.length > COST_INPUT_PROVIDER_REF_MAX_LENGTH) {
    throw new ProviderReferenceError('provider_ref_length')
  }
  return normalized
}

const providerReferenceSchema = z
  .string()
  .min(1, 'provider_ref_length')
  .transform((value, ctx) => {
    try {
      return normalizeProviderReference(value)
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof ProviderReferenceError ? err.reason : 'provider_ref_invalid',
      })
      return z.NEVER
    }
  })

const isoDateTimeSchema = z
  .union([z.string(), z.date()])
  .transform((value, ctx) => {
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'period_invalid' })
      return z.NEVER
    }
    return date
  })

const descriptionSchema = z
  .string()
  .max(COST_INPUT_DESCRIPTION_MAX_LENGTH, 'description_too_long')
  .transform((value) => {
    const trimmed = value.trim()
    return trimmed.length ? trimmed : null
  })

const costInputFieldsSchema = z.object({
  periodStart: isoDateTimeSchema,
  periodEnd: isoDateTimeSchema,
  costType: z.enum(COST_INPUT_TYPES),
  userId: z.string().uuid('dimension_invalid').nullish(),
  channelId: z.string().uuid('dimension_invalid').nullish(),
  amountMinor: amountMinorSchema,
  currencyCode: currencyCodeSchema,
  source: z.enum(COST_INPUT_SOURCES),
  providerInvoiceRef: providerReferenceSchema.nullish(),
  providerLineRef: providerReferenceSchema.nullish(),
  description: descriptionSchema.nullish(),
})

export function daysBetween(periodStart: Date, periodEnd: Date): number {
  return (periodEnd.getTime() - periodStart.getTime()) / 86_400_000
}

type CostInputFields = z.infer<typeof costInputFieldsSchema>

function refineCostInput(value: CostInputFields, ctx: z.RefinementCtx): void {
  if (value.periodEnd.getTime() <= value.periodStart.getTime()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periodEnd'], message: 'period_invalid' })
  } else if (daysBetween(value.periodStart, value.periodEnd) > COST_INPUT_MAX_PERIOD_DAYS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periodEnd'], message: 'period_too_large' })
  }

  const hasUser = value.userId != null
  const hasChannel = value.channelId != null
  const dimensionValid = value.costType === 'agent'
    ? hasUser && !hasChannel
    : value.costType === 'channel'
      ? hasChannel && !hasUser
      : !hasUser && !hasChannel
  if (!dimensionValid) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['costType'], message: 'dimension_invalid' })
  }

  const hasInvoiceRef = value.providerInvoiceRef != null
  const hasLineRef = value.providerLineRef != null
  const provenanceValid = value.source === 'provider_invoice'
    ? hasInvoiceRef && hasLineRef
    : !hasInvoiceRef && !hasLineRef
  if (!provenanceValid) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source'], message: 'provenance_invalid' })
  }
}

export const costInputCreateSchema = costInputFieldsSchema.strict().superRefine(refineCostInput)

export const costInputUpdateSchema = costInputFieldsSchema
  .extend({ id: z.string().uuid() })
  .strict()
  .superRefine(refineCostInput)

export const costInputDeleteSchema = z.object({ id: z.string().uuid() }).strict()

export type CostInputCreateInput = z.infer<typeof costInputCreateSchema>
export type CostInputUpdateInput = z.infer<typeof costInputUpdateSchema>

export const COST_INPUT_SORT_FIELDS = [
  'periodStart',
  'periodEnd',
  'costType',
  'amountMinor',
  'currencyCode',
  'createdAt',
  'updatedAt',
] as const

export const costInputListQuerySchema = z
  .object({
    id: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
    sortField: z.enum(COST_INPUT_SORT_FIELDS).default('periodStart'),
    sortDir: z.enum(['asc', 'desc']).default('desc'),
    costType: z.enum(COST_INPUT_TYPES).optional(),
    currencyCode: currencyCodeSchema.optional(),
    source: z.enum(COST_INPUT_SOURCES).optional(),
    userId: z.string().uuid().optional(),
    channelId: z.string().uuid().optional(),
    periodStart: z.string().optional(),
    periodEnd: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasStart = value.periodStart != null && value.periodStart.length > 0
    const hasEnd = value.periodEnd != null && value.periodEnd.length > 0
    if (hasStart !== hasEnd) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periodStart'], message: 'period_invalid' })
      return
    }
    if (!hasStart || !hasEnd) return
    const start = new Date(value.periodStart as string)
    const end = new Date(value.periodEnd as string)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periodStart'], message: 'period_invalid' })
      return
    }
    if (daysBetween(start, end) > COST_INPUT_MAX_PERIOD_DAYS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periodEnd'], message: 'period_too_large' })
    }
  })

export type CostInputListQuery = z.infer<typeof costInputListQuerySchema>

import { z } from 'zod'

export const COST_PER_CONTACT_FORMULA_VERSION = 'connect_cost_reporting.cost_per_contact.v1' as const
export const COST_SOURCE_VERSION = 'connect_analytics.allocated_cost.v1' as const
export const DENOMINATOR_SOURCE_VERSION = 'connect.contact_root_created.v1' as const

export const costTypeSchema = z.enum(['agent', 'channel', 'ai'])
export const rationalSchema = z.object({
  numerator: z.string().regex(/^\d+$/),
  denominator: z.string().regex(/^[1-9]\d*$/),
}).strict()
export const allocatedCostSummarySchema = z.object({
  contractVersion: z.literal(COST_SOURCE_VERSION),
  generatedAt: z.string().datetime(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  matchedInputCount: z.number().int().nonnegative(),
  byType: z.array(z.object({ type: costTypeSchema, allocatedMinor: rationalSchema }).strict()).max(3),
}).strict().superRefine((value, context) => {
  const types = value.byType.map((entry) => entry.type)
  if (new Set(types).size !== types.length) {
    context.addIssue({ code: 'custom', message: '[internal] duplicate cost type' })
  }
})
export const denominatorSummarySchema = z.object({
  contractVersion: z.literal(DENOMINATOR_SOURCE_VERSION),
  generatedAt: z.string().datetime(),
  count: z.number().int().nonnegative(),
}).strict()

export const unavailableReasonSchema = z.enum([
  'cost_module_disabled', 'cost_reader_unavailable', 'cost_source_initializing',
  'cost_source_timeout', 'cost_source_error', 'cost_contract_version_unsupported',
  'connect_module_disabled', 'denominator_reader_unavailable', 'lineage_initializing',
  'denominator_source_timeout', 'denominator_source_error',
  'denominator_contract_version_unsupported', 'not_authorized',
])
export const moneyTotalsSchema = z.object({
  agentMinor: z.string().regex(/^\d+$/),
  channelMinor: z.string().regex(/^\d+$/),
  aiMinor: z.string().regex(/^\d+$/),
  totalMinor: z.string().regex(/^\d+$/),
}).strict()
export const availableReportSchema = z.object({
  capability: z.literal('available'),
  formulaVersion: z.literal(COST_PER_CONTACT_FORMULA_VERSION),
  from: z.string().datetime(),
  to: z.string().datetime(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  totals: moneyTotalsSchema,
  denominator: z.number().int().nonnegative(),
  costPerContactMinor: z.string().regex(/^\d+$/).nullable(),
  matchedInputCount: z.number().int().nonnegative(),
  costSourceVersion: z.literal(COST_SOURCE_VERSION),
  denominatorSourceVersion: z.literal(DENOMINATOR_SOURCE_VERSION),
  costGeneratedAt: z.string().datetime(),
  denominatorGeneratedAt: z.string().datetime(),
}).strict()
export const unavailableReportSchema = z.object({
  capability: z.literal('unavailable'),
  formulaVersion: z.literal(COST_PER_CONTACT_FORMULA_VERSION),
  reason: unavailableReasonSchema,
  totals: z.null(),
  denominator: z.null(),
  costPerContactMinor: z.null(),
}).strict()
export const reportResponseSchema = z.discriminatedUnion('capability', [
  availableReportSchema,
  unavailableReportSchema,
])
export const reportQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  currency: z.string().regex(/^[A-Z]{3}$/).refine(
    (value) => Intl.supportedValuesOf('currency').includes(value),
    { message: '[internal] unsupported ISO-4217 currency' },
  ),
}).strict()
export const apiErrorSchema = z.object({
  error: z.string(),
  code: z.enum(['organization_required', 'invalid_range', 'range_too_large', 'invalid_currency', 'unauthorized', 'forbidden']),
}).strict()

export type AllocatedCostSummary = z.infer<typeof allocatedCostSummarySchema>
export type DenominatorSummary = z.infer<typeof denominatorSummarySchema>
export type AvailableReport = z.infer<typeof availableReportSchema>
export type ReportResponse = z.infer<typeof reportResponseSchema>
export type UnavailableReason = z.infer<typeof unavailableReasonSchema>
export type ApiError = z.infer<typeof apiErrorSchema>

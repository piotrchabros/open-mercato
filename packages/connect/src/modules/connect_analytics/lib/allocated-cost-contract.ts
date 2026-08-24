import { z } from 'zod'

export const CONNECT_ALLOCATED_COST_CONTRACT_VERSION = 'connect_analytics.allocated_cost.v1' as const

export const scopedCostRangeSchema = z
  .object({
    tenantId: z.string().uuid(),
    organizationId: z.string().uuid(),
    periodStart: z.date(),
    periodEnd: z.date(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict()
  .refine((value) => value.periodStart < value.periodEnd, { path: ['periodEnd'] })

export const rationalSchema = z
  .object({
    numerator: z.string().regex(/^\d+$/),
    denominator: z.string().regex(/^[1-9]\d*$/),
  })
  .strict()

export const allocatedCostSummarySchema = z
  .object({
    contractVersion: z.literal(CONNECT_ALLOCATED_COST_CONTRACT_VERSION),
    generatedAt: z.string().datetime(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
    matchedInputCount: z.number().int().nonnegative(),
    byType: z
      .array(
        z
          .object({
            type: z.enum(['agent', 'channel', 'ai']),
            allocatedMinor: rationalSchema,
          })
          .strict(),
      )
      .max(3),
  })
  .strict()

export type ScopedCostRange = z.input<typeof scopedCostRangeSchema>
export type AllocatedCostSummary = z.infer<typeof allocatedCostSummarySchema>

export type ConnectAllocatedCostReader = {
  summarizeAllocated(input: ScopedCostRange): Promise<AllocatedCostSummary>
}

export type AllocatedCostReaderErrorCode =
  | 'invalid_currency'
  | 'invalid_range'
  | 'range_too_large'
  | 'invalid_scope'

export class AllocatedCostReaderError extends Error {
  constructor(readonly code: AllocatedCostReaderErrorCode) {
    super(`[internal] allocated cost reader rejected input: ${code}`)
    this.name = 'AllocatedCostReaderError'
  }
}

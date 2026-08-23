import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import { CostInput, type CostInputType } from '../data/entities'
import { COST_INPUT_MAX_PERIOD_DAYS, daysBetween } from '../data/validators'

/**
 * Sanitized row-level cost reader.
 *
 * `connect_analytics` owns the storage and its semantics; a reporting consumer
 * owns allocation and denominators. This reader is the whole boundary between
 * the two, so it returns the five fields an allocation needs and nothing else
 * — no description, no actor, no provider identity, no user or channel id.
 * A consumer that wanted those would be reading a financial audit trail
 * through a reporting API.
 *
 * It is bounded on both axes deliberately: an unbounded range or an unbounded
 * row count turns a report request into an accidental full-table export.
 */

export const COST_INPUT_READER_MAX_ROWS = 10_000

export type ConnectCostInputReaderRow = {
  periodStart: Date
  periodEnd: Date
  costType: CostInputType
  amountMinor: string
  currencyCode: string
}

export type ConnectCostInputReader = {
  listOverlapping(input: {
    tenantId: string
    organizationId: string
    periodStart: Date
    periodEnd: Date
    currencyCode: string
  }): Promise<ConnectCostInputReaderRow[]>
}

export class CostInputResultTooLargeError extends Error {
  readonly code = 'cost_input_result_too_large'

  constructor() {
    super('[internal] cost input overlap query exceeded the published row bound')
    this.name = 'CostInputResultTooLargeError'
  }
}

const readerInputSchema = z
  .object({
    tenantId: z.string().uuid(),
    organizationId: z.string().uuid(),
    periodStart: z.date(),
    periodEnd: z.date(),
    currencyCode: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.periodEnd.getTime() <= value.periodStart.getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periodEnd'], message: 'period_invalid' })
      return
    }
    if (daysBetween(value.periodStart, value.periodEnd) > COST_INPUT_MAX_PERIOD_DAYS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['periodEnd'], message: 'period_too_large' })
    }
  })

export function createConnectCostInputReader(em: EntityManager): ConnectCostInputReader {
  return {
    async listOverlapping(rawInput) {
      const input = readerInputSchema.parse(rawInput)

      /**
       * Half-open overlap: a row touching the requested window at all is in,
       * a row that merely abuts it is out. `row.end > requested.start` and
       * `row.start < requested.end` is the only pair of strict comparisons
       * that gets both boundaries right.
       */
      const rows = await em.find(
        CostInput,
        {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          currencyCode: input.currencyCode,
          deletedAt: null,
          periodStart: { $lt: input.periodEnd },
          periodEnd: { $gt: input.periodStart },
        },
        {
          // Never selects `description`: the column is encrypted and has no
          // business crossing this boundary even decrypted.
          fields: ['id', 'periodStart', 'periodEnd', 'costType', 'amountMinor', 'currencyCode'],
          orderBy: [{ periodStart: 'asc' }, { id: 'asc' }],
          limit: COST_INPUT_READER_MAX_ROWS + 1,
        },
      )

      if (rows.length > COST_INPUT_READER_MAX_ROWS) throw new CostInputResultTooLargeError()

      return rows.map((row) => ({
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        costType: row.costType,
        amountMinor: String(row.amountMinor),
        currencyCode: row.currencyCode,
      }))
    },
  }
}

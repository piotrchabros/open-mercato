import type { EntityManager } from '@mikro-orm/postgresql'
import {
  AllocatedCostReaderError,
  CONNECT_ALLOCATED_COST_CONTRACT_VERSION,
  allocatedCostSummarySchema,
  scopedCostRangeSchema,
  type ConnectAllocatedCostReader,
  type ScopedCostRange,
} from './allocated-cost-contract'
import { addRationals, serializeRational, type ExactRational } from './exact-rational'

const MAX_RANGE_MILLISECONDS = 366 * 24 * 60 * 60 * 1_000
const COST_TYPE_ORDER = ['agent', 'channel', 'ai'] as const
type CostType = (typeof COST_TYPE_ORDER)[number]

type AllocatedCostRow = {
  period_start: Date | string
  period_end: Date | string
  cost_type: CostType
  amount_minor: string
}

function parseInput(rawInput: ScopedCostRange): ScopedCostRange {
  const parsed = scopedCostRangeSchema.safeParse(rawInput)
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path[0])
    if (paths.includes('tenantId') || paths.includes('organizationId')) {
      throw new AllocatedCostReaderError('invalid_scope')
    }
    if (paths.includes('currencyCode')) throw new AllocatedCostReaderError('invalid_currency')
    throw new AllocatedCostReaderError('invalid_range')
  }
  if (parsed.data.periodEnd.getTime() - parsed.data.periodStart.getTime() > MAX_RANGE_MILLISECONDS) {
    throw new AllocatedCostReaderError('range_too_large')
  }
  return parsed.data
}

function overlapMilliseconds(row: AllocatedCostRow, input: ScopedCostRange): bigint {
  const rowStart = new Date(row.period_start).getTime()
  const rowEnd = new Date(row.period_end).getTime()
  const overlapStart = Math.max(rowStart, input.periodStart.getTime())
  const overlapEnd = Math.min(rowEnd, input.periodEnd.getTime())
  return BigInt(Math.max(0, overlapEnd - overlapStart))
}

export function createConnectAllocatedCostReader(em: EntityManager): ConnectAllocatedCostReader {
  return {
    async summarizeAllocated(rawInput) {
      const input = parseInput(rawInput)
      const rows = await em.getConnection().execute<AllocatedCostRow[]>(
        `select period_start, period_end, cost_type, amount_minor
           from connect_cost_inputs
          where tenant_id = ?
            and organization_id = ?
            and currency_code = ?
            and deleted_at is null
            and period_start < ?
            and period_end > ?`,
        [
          input.tenantId,
          input.organizationId,
          input.currencyCode,
          input.periodEnd,
          input.periodStart,
        ],
      )

      const totals = new Map<CostType, ExactRational>()
      for (const row of rows) {
        const rowDuration = BigInt(new Date(row.period_end).getTime() - new Date(row.period_start).getTime())
        const allocated = {
          numerator: BigInt(row.amount_minor) * overlapMilliseconds(row, input),
          denominator: rowDuration,
        }
        totals.set(
          row.cost_type,
          addRationals(totals.get(row.cost_type) ?? { numerator: 0n, denominator: 1n }, allocated),
        )
      }

      return allocatedCostSummarySchema.parse({
        contractVersion: CONNECT_ALLOCATED_COST_CONTRACT_VERSION,
        generatedAt: new Date().toISOString(),
        currencyCode: input.currencyCode,
        matchedInputCount: rows.length,
        byType: COST_TYPE_ORDER.flatMap((type) => {
          const total = totals.get(type)
          if (!total || total.numerator === 0n) return []
          return [{ type, allocatedMinor: serializeRational(total) }]
        }),
      })
    },
  }
}

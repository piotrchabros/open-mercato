import type { EntityManager } from '@mikro-orm/postgresql'

/**
 * Connect-owned answer to "how much work does this agent currently hold?".
 *
 * Connect owns Case semantics and Case storage, so it — not a consumer — must
 * decide which statuses are current workload. Publishing this as a DI contract
 * is what lets `connect_routing` build a capacity projection without importing
 * `ConnectCase` or querying `connect_cases` itself.
 *
 * The value is intentionally derived on every read rather than mirrored into a
 * counter on assignment: an increment/decrement mirror drifts after a crash, an
 * import, a repair, or any period where the consuming module was disabled, and
 * nothing can tell you afterwards that it drifted.
 */

/**
 * `resolved` and `closed` Cases are no longer workload; a soft-deleted Case and
 * an unassigned Case never count at all.
 */
export const CONNECT_ACTIVE_CASE_STATUSES = ['new', 'in_progress', 'waiting_customer'] as const

export type ConnectActiveCaseStatus = (typeof CONNECT_ACTIVE_CASE_STATUSES)[number]

export function isActiveConnectCaseStatus(status: string): status is ConnectActiveCaseStatus {
  return (CONNECT_ACTIVE_CASE_STATUSES as readonly string[]).includes(status)
}

export type ConnectCurrentCaseCount = {
  assigneeUserId: string
  currentCaseCount: number
}

export type ConnectCurrentCaseCountScope = {
  tenantId: string
  organizationId: string
}

export type ConnectCurrentCaseCountReader = {
  listByAssignee(input: ConnectCurrentCaseCountScope): Promise<ConnectCurrentCaseCount[]>
}

/** `int4` upper bound: the consumer persists this into an integer column. */
export const CONNECT_MAX_CURRENT_CASE_COUNT = 2147483647

/**
 * Postgres returns `count(*)` as a bigint, which the driver hands back as a
 * string (or a native bigint, depending on parser configuration). Coercing with
 * a bare `Number()` would silently turn an out-of-range aggregate into a lossy
 * float and write it into the projection, so every form is validated here and a
 * bad one throws before any write happens.
 */
export function parseCurrentCaseCount(raw: unknown): number {
  const value =
    typeof raw === 'bigint'
      ? Number(raw)
      : typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)
          ? Number(raw.trim())
          : Number.NaN
  if (!Number.isSafeInteger(value) || value < 0 || value > CONNECT_MAX_CURRENT_CASE_COUNT) {
    throw new Error('[internal] case_count_out_of_range')
  }
  return value
}

/**
 * Grouped so the result is one row per assignee rather than one per Case: the
 * caller must never materialize a whole organization's Cases to count them.
 * `connect_cases_assignee_idx` covers the scope/assignee/status predicate.
 */
const LIST_BY_ASSIGNEE_SQL = `
  select "assignee_user_id" as "assigneeUserId", count(*) as "currentCaseCount"
    from "connect_cases"
   where "tenant_id" = ?
     and "organization_id" = ?
     and "assignee_user_id" is not null
     and "deleted_at" is null
     and "status" in (?, ?, ?)
   group by "assignee_user_id"
   order by "assignee_user_id"
`

export function createConnectCurrentCaseCountReader(em: EntityManager): ConnectCurrentCaseCountReader {
  return {
    async listByAssignee(input) {
      // Both scope predicates are mandatory arguments, not optional filters: a
      // grouped read that lost one of them would hand a sibling organization's
      // workload to the caller's capacity projection.
      const rows = await em.execute<Array<{ assigneeUserId: string; currentCaseCount: unknown }>>(
        LIST_BY_ASSIGNEE_SQL,
        [input.tenantId, input.organizationId, ...CONNECT_ACTIVE_CASE_STATUSES],
      )
      return rows.map((row) => ({
        assigneeUserId: row.assigneeUserId,
        currentCaseCount: parseCurrentCaseCount(row.currentCaseCount),
      }))
    },
  }
}

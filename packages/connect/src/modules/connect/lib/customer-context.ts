import type { EntityManager } from '@mikro-orm/postgresql'
import type { ConnectCaseStatus } from '../data/entities'

/**
 * The customer-keyed Connect summary shown on Customer screens.
 *
 * Deliberately three numbers and nothing else. Widgets render this next to a
 * customer record for viewers whose only Connect permission is `.read`, so a
 * subject line or a masked handle here would put conversation content on a
 * screen that was never authorized to show it. Counting is safe; quoting is not.
 *
 * Two isolation rules hold throughout:
 *
 *   - Only the CURRENT active association counts. A Case whose customer was
 *     cleared by an unlink contributes nothing, immediately, even while the
 *     upstream tombstones are still draining.
 *   - A reference outside the caller's tenant+organization contributes nothing
 *     and is indistinguishable from one that simply has no Cases. The batch
 *     route therefore cannot enumerate another organization's customers.
 */

export const CUSTOMER_CONTEXT_BATCH_LIMIT = 100

/** Statuses that still need somebody. `resolved`/`closed` are done. */
const OPEN_STATUSES: ConnectCaseStatus[] = ['new', 'in_progress', 'waiting_customer']

export type CustomerContextRef = {
  kind: 'person' | 'company'
  id: string
}

export type CustomerContext = CustomerContextRef & {
  openCaseCount: number
  lastCaseAt: string | null
  lastCaseStatus: ConnectCaseStatus | null
}

export type CustomerContextScope = {
  tenantId: string
  organizationId: string
}

type ContextRow = {
  kind: string
  id: string
  open_count: string | number
  last_case_at: Date | string | null
  last_case_status: ConnectCaseStatus | null
}

/**
 * Aggregate context for up to `CUSTOMER_CONTEXT_BATCH_LIMIT` references.
 *
 * ONE grouped query for the whole batch, regardless of how many references —
 * list enrichers call this once per page, and a per-row query would put a
 * page-sized burst of round trips behind every customer list render. The last
 * status comes from an ordered aggregate in the same pass rather than a
 * follow-up lookup, for the same reason.
 *
 * References with no contribution are simply absent from the result. Returning
 * a zeroed entry would confirm the reference exists, which is exactly the
 * distinction cross-organization isolation must not expose.
 */
export async function readCustomerContexts(
  em: EntityManager,
  scope: CustomerContextScope,
  refs: CustomerContextRef[],
): Promise<CustomerContext[]> {
  const unique = new Map<string, CustomerContextRef>()
  for (const ref of refs) unique.set(`${ref.kind}:${ref.id}`, ref)
  const wanted = [...unique.values()].slice(0, CUSTOMER_CONTEXT_BATCH_LIMIT)
  if (!wanted.length) return []

  // Matched as (kind, id) PAIRS. Two independent `in` lists would let a person
  // id and a company kind cross-match and attribute one record's Cases to
  // another.
  const pairs = wanted.map(() => '(?, ?)').join(', ')
  const rows = (await em.execute(
    `select "customer_kind" as "kind",
            "customer_id" as "id",
            count(*) filter (where "status" in (?, ?, ?)) as "open_count",
            max("created_at") as "last_case_at",
            (array_agg("status" order by "created_at" desc))[1] as "last_case_status"
       from "connect_cases"
      where "tenant_id" = ?
        and "organization_id" = ?
        and "deleted_at" is null
        -- A merged source is not a second Case for this customer. Counting it
        -- would inflate "open cases" with a Case nobody can work, and let the
        -- "latest" status be one a supervisor deliberately retired.
        and "merged_into_case_id" is null
        and "customer_id" is not null
        and ("customer_kind", "customer_id") in (${pairs})
      group by "customer_kind", "customer_id"`,
    [
      ...OPEN_STATUSES,
      scope.tenantId,
      scope.organizationId,
      ...wanted.flatMap((ref) => [ref.kind, ref.id]),
    ],
  )) as ContextRow[]

  const byKey = new Map<string, ContextRow>()
  for (const row of rows) byKey.set(`${row.kind}:${row.id}`, row)

  // Preserve the caller's order so an enricher can zip results back onto rows.
  const contexts: CustomerContext[] = []
  for (const ref of wanted) {
    const row = byKey.get(`${ref.kind}:${ref.id}`)
    if (!row) continue
    const lastCaseAt = row.last_case_at ? new Date(row.last_case_at) : null
    contexts.push({
      kind: ref.kind,
      id: ref.id,
      openCaseCount: Number(row.open_count ?? 0),
      lastCaseAt: lastCaseAt ? lastCaseAt.toISOString() : null,
      lastCaseStatus: row.last_case_status ?? null,
    })
  }
  return contexts
}

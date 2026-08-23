import type { EntityManager } from '@mikro-orm/postgresql'

/**
 * Playwright transpiles specs with standard TC39 decorators while the ORM
 * entities use MikroORM's legacy decorators. Importing `../data/entities` from
 * a spec throws during test *collection*, and a collection error aborts the
 * whole repository's run rather than just this file. These helpers therefore
 * reach the cost tables through SQL and never load an entity class.
 */

export type CostScope = {
  tenantId: string
  organizationId: string
}

export type RawCostInputRow = {
  id: string
  tenant_id: string
  organization_id: string
  period_start: string
  period_end: string
  cost_type: string
  user_id: string | null
  channel_id: string | null
  amount_minor: string
  currency_code: string
  source: string
  provider_invoice_ref: string | null
  provider_line_ref: string | null
  description: string | null
  created_by_user_id: string | null
  updated_by_user_id: string | null
  deleted_at: string | null
}

export async function readCostInputRow(
  em: EntityManager,
  id: string,
): Promise<RawCostInputRow | null> {
  const rows = await em.getConnection().execute<RawCostInputRow[]>(
    'select * from connect_cost_inputs where id = ?',
    [id],
  )
  return rows[0] ?? null
}

export async function countCostInputs(em: EntityManager, scope: CostScope): Promise<number> {
  const rows = await em.getConnection().execute<{ count: string }[]>(
    `select count(*)::text as count from connect_cost_inputs
      where tenant_id = ? and organization_id = ? and deleted_at is null`,
    [scope.tenantId, scope.organizationId],
  )
  return Number(rows[0]?.count ?? '0')
}

export async function readRevisionSecretDescriptions(
  em: EntityManager,
  costInputId: string,
): Promise<Array<{ operation: string; description_before: string | null; description_after: string | null }>> {
  return em.getConnection().execute(
    `select operation, description_before, description_after
       from connect_cost_input_revision_secrets
      where cost_input_id = ?
      order by created_at asc`,
    [costInputId],
  )
}

/**
 * Inserts a row directly, bypassing the API.
 *
 * Used only to plant a *sibling-organization* or foreign-tenant row that the
 * API under test must never return — creating it through the API would require
 * a second authenticated principal in that scope, which is exactly the setup
 * the isolation test is trying not to depend on.
 */
export async function insertCostInputRow(
  em: EntityManager,
  values: CostScope & {
    periodStart: string
    periodEnd: string
    costType: string
    amountMinor: string
    currencyCode: string
    source?: string
  },
): Promise<string> {
  const rows = await em.getConnection().execute<{ id: string }[]>(
    `insert into connect_cost_inputs
       (tenant_id, organization_id, period_start, period_end, cost_type,
        amount_minor, currency_code, source, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, now(), now())
     returning id`,
    [
      values.tenantId,
      values.organizationId,
      values.periodStart,
      values.periodEnd,
      values.costType,
      values.amountMinor,
      values.currencyCode,
      values.source ?? 'manual',
    ],
  )
  return rows[0]!.id
}

export async function hardDeleteCostInputs(em: EntityManager, ids: string[]): Promise<void> {
  const present = ids.filter((id) => typeof id === 'string' && id.length > 0)
  if (!present.length) return
  const placeholders = present.map(() => '?').join(', ')
  await em.getConnection().execute(
    `delete from connect_cost_input_revision_secrets where cost_input_id in (${placeholders})`,
    present,
  )
  await em.getConnection().execute(
    `delete from connect_cost_inputs where id in (${placeholders})`,
    present,
  )
}

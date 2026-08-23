import type { EntityManager } from '@mikro-orm/postgresql'

// Playwright transpiles specs with standard TC39 decorators while the ORM
// entities use MikroORM's legacy decorators. Importing `../data/entities` from
// a spec therefore throws while Playwright is collecting tests, and because a
// collection error aborts the whole run it takes every other spec in the
// repository down with it. These helpers reach the principal sidecar tables
// through SQL so the specs never load an entity class.

export type PrincipalScope = {
  tenantId: string
  organizationId: string
}

export async function insertPrincipalClassification(
  em: EntityManager,
  values: PrincipalScope & { userId: string; kind: string },
): Promise<void> {
  await em.getConnection().execute(
    `insert into connect_principal_classifications
       (tenant_id, organization_id, user_id, kind, created_at, updated_at)
     values (?, ?, ?, ?, now(), now())`,
    [values.tenantId, values.organizationId, values.userId, values.kind],
  )
}

export async function countPrincipalClassifications(
  em: EntityManager,
  scope: PrincipalScope & { userId: string },
): Promise<number> {
  const rows = await em.getConnection().execute<{ count: string }[]>(
    `select count(*)::text as count from connect_principal_classifications
      where tenant_id = ? and organization_id = ? and user_id = ?`,
    [scope.tenantId, scope.organizationId, scope.userId],
  )
  return Number(rows[0]?.count ?? '0')
}

export async function countPrincipalChanges(
  em: EntityManager,
  scope: PrincipalScope & { userId: string; tombstonedOnly?: boolean },
): Promise<number> {
  const rows = await em.getConnection().execute<{ count: string }[]>(
    `select count(*)::text as count from connect_principal_classification_changes
      where tenant_id = ? and organization_id = ? and user_id = ?
        and (? = false or tombstoned_classification = true)`,
    [scope.tenantId, scope.organizationId, scope.userId, scope.tombstonedOnly === true],
  )
  return Number(rows[0]?.count ?? '0')
}

export async function findPrincipalChangeIdByAfterKind(
  em: EntityManager,
  scope: { classificationId: string; afterKind: string },
): Promise<string> {
  const rows = await em.getConnection().execute<{ id: string }[]>(
    `select id from connect_principal_classification_changes
      where classification_id = ? and after_kind = ?
      order by created_at desc limit 1`,
    [scope.classificationId, scope.afterKind],
  )
  const id = rows[0]?.id
  if (!id) throw new Error(`[internal] no principal change with after_kind=${scope.afterKind}`)
  return id
}

export async function readPrincipalManifestEntry(
  em: EntityManager,
  scope: PrincipalScope & { userId: string },
): Promise<{ active: boolean; revision: number; lastResultCode: string | null } | null> {
  const rows = await em.getConnection().execute<
    { active: boolean; revision: number; last_result_code: string | null }[]
  >(
    `select active, revision, last_result_code from connect_principal_classification_manifest_entries
      where tenant_id = ? and organization_id = ? and user_id = ?`,
    [scope.tenantId, scope.organizationId, scope.userId],
  )
  const row = rows[0]
  return row ? { active: row.active, revision: Number(row.revision), lastResultCode: row.last_result_code } : null
}

// Reconciliation is declarative over a whole tenant/organization, so its counts
// include every manifest entry in scope. Any row left behind by an operator or a
// previous run would change `retired`/`unavailable` and make the spec flaky, so
// the scope starts empty. Only Connect's own sidecar tables are touched.
export async function clearPrincipalScope(em: EntityManager, scope: PrincipalScope): Promise<void> {
  for (const table of [
    'connect_principal_classification_changes',
    'connect_principal_classification_manifest_entries',
    'connect_principal_classifications',
  ]) {
    await em.getConnection().execute(
      `delete from ${table} where tenant_id = ? and organization_id = ?`,
      [scope.tenantId, scope.organizationId],
    )
  }
}

export async function deletePrincipalRows(
  em: EntityManager,
  scope: PrincipalScope & { userIds: string[] },
): Promise<void> {
  if (scope.userIds.length === 0) return
  // Bind each id as its own placeholder: the driver expands a JS array into a
  // comma-separated binding list, which breaks `= any(?::uuid[])`.
  const placeholders = scope.userIds.map(() => '?').join(', ')
  const params = [scope.tenantId, scope.organizationId, ...scope.userIds]
  for (const table of [
    'connect_principal_classification_changes',
    'connect_principal_classification_manifest_entries',
    'connect_principal_classifications',
  ]) {
    await em.getConnection().execute(
      `delete from ${table}
        where tenant_id = ? and organization_id = ? and user_id in (${placeholders})`,
      params,
    )
  }
}

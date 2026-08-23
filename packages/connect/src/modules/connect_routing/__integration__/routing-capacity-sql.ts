import type { EntityManager } from '@mikro-orm/postgresql'

// Playwright transpiles specs with standard TC39 decorators while the ORM
// entities use MikroORM's legacy decorators. Importing `../data/entities` from a
// spec therefore throws during collection, and a collection error aborts the
// whole run — it takes every other spec in the repository down with it. These
// helpers reach both Connect's Cases and the routing tables through SQL so no
// spec ever loads an entity class.

export type CapacityScope = {
  tenantId: string
  organizationId: string
}

export type SeededCase = {
  assigneeUserId: string | null
  status?: string
  softDeleted?: boolean
}

/**
 * `number` is unique per organization, so the fixture allocates from the current
 * maximum rather than from a constant: a spec that collided with a leftover row
 * would fail for a reason that has nothing to do with capacity.
 */
export async function insertCases(
  em: EntityManager,
  scope: CapacityScope,
  cases: SeededCase[],
): Promise<string[]> {
  const channelId = '00000000-0000-4000-8000-0000000000ca'
  const startRows = await em.getConnection().execute<{ next: string }[]>(
    `select coalesce(max("number"), 0) + 1 as next from "connect_cases"
      where "tenant_id" = ? and "organization_id" = ?`,
    [scope.tenantId, scope.organizationId],
  )
  let next = Number(startRows[0]?.next ?? '1')
  const ids: string[] = []
  // Batched: the scale fixture seeds several hundred Cases, and one round trip
  // per row would dominate the spec's wall time without testing anything.
  for (let offset = 0; offset < cases.length; offset += 200) {
    const batch = cases.slice(offset, offset + 200)
    const tuples: string[] = []
    const params: unknown[] = []
    for (const seeded of batch) {
      tuples.push(`(?, ?, ?, ?, ?, ?, now(), now(), ${seeded.softDeleted ? 'now()' : 'null'})`)
      params.push(
        scope.tenantId,
        scope.organizationId,
        next,
        seeded.status ?? 'new',
        seeded.assigneeUserId,
        channelId,
      )
      next += 1
    }
    const rows = await em.getConnection().execute<{ id: string }[]>(
      `insert into "connect_cases"
         ("tenant_id", "organization_id", "number", "status", "assignee_user_id", "channel_id",
          "created_at", "updated_at", "deleted_at")
       values ${tuples.join(', ')}
       returning "id"`,
      params,
    )
    ids.push(...rows.map((row) => row.id))
  }
  return ids
}

export async function updateCase(
  em: EntityManager,
  caseId: string,
  values: { assigneeUserId?: string | null; status?: string; softDeleted?: boolean },
): Promise<void> {
  const assignments: string[] = []
  const params: unknown[] = []
  if ('assigneeUserId' in values) {
    assignments.push(`"assignee_user_id" = ?`)
    params.push(values.assigneeUserId)
  }
  if (values.status !== undefined) {
    assignments.push(`"status" = ?`)
    params.push(values.status)
  }
  if (values.softDeleted !== undefined) {
    assignments.push(`"deleted_at" = ${values.softDeleted ? 'now()' : 'null'}`)
  }
  if (assignments.length === 0) return
  await em.getConnection().execute(
    `update "connect_cases" set ${assignments.join(', ')}, "updated_at" = now() where "id" = ?`,
    [...params, caseId],
  )
}

export async function deleteCases(em: EntityManager, caseIds: string[]): Promise<void> {
  if (caseIds.length === 0) return
  // Each id gets its own placeholder: the driver expands a JS array into a
  // comma-separated binding list, which breaks `= any(?::uuid[])`.
  const placeholders = caseIds.map(() => '?').join(', ')
  await em.getConnection().execute(
    `delete from "connect_cases" where "id" in (${placeholders})`,
    caseIds,
  )
}

export type PresenceRow = {
  userId: string
  status: string
  currentCaseCount: number
}

export async function readPresences(em: EntityManager, scope: CapacityScope): Promise<PresenceRow[]> {
  const rows = await em.getConnection().execute<
    { user_id: string; status: string; current_case_count: number }[]
  >(
    `select "user_id", "status", "current_case_count" from "connect_agent_presences"
      where "tenant_id" = ? and "organization_id" = ?
      order by "user_id"`,
    [scope.tenantId, scope.organizationId],
  )
  return rows.map((row) => ({
    userId: row.user_id,
    status: row.status,
    currentCaseCount: Number(row.current_case_count),
  }))
}

export async function readPresence(
  em: EntityManager,
  scope: CapacityScope & { userId: string },
): Promise<PresenceRow | null> {
  const rows = await readPresences(em, scope)
  return rows.find((row) => row.userId === scope.userId) ?? null
}

export async function setPresenceStatus(
  em: EntityManager,
  scope: CapacityScope & { userId: string; status: string },
): Promise<void> {
  await em.getConnection().execute(
    `update "connect_agent_presences" set "status" = ?, "updated_at" = now()
      where "tenant_id" = ? and "organization_id" = ? and "user_id" = ?`,
    [scope.status, scope.tenantId, scope.organizationId, scope.userId],
  )
}

export type CheckpointRow = {
  state: string
  foundationVersion: string | null
  generation: number
  completedAt: string | null
  lastErrorCode: string | null
}

export async function readCheckpoint(
  em: EntityManager,
  scope: CapacityScope,
): Promise<CheckpointRow | null> {
  const rows = await em.getConnection().execute<
    {
      state: string
      foundation_version: string | null
      generation: string
      completed_at: Date | null
      last_error_code: string | null
    }[]
  >(
    `select "state", "foundation_version", "generation", "completed_at", "last_error_code"
       from "connect_routing_capacity_checkpoints"
      where "tenant_id" = ? and "organization_id" = ?`,
    [scope.tenantId, scope.organizationId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    state: row.state,
    foundationVersion: row.foundation_version,
    generation: Number(row.generation),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    lastErrorCode: row.last_error_code,
  }
}

/**
 * Reconciliation is declarative over a whole scope, so its created/zeroed counts
 * include every presence row in it. A row left behind by a previous run would
 * change those numbers and make the spec flaky, so each scope starts empty. Only
 * routing's own tables are touched.
 */
export async function clearRoutingScope(em: EntityManager, scope: CapacityScope): Promise<void> {
  for (const table of ['connect_agent_presences', 'connect_routing_capacity_checkpoints']) {
    await em.getConnection().execute(
      `delete from "${table}" where "tenant_id" = ? and "organization_id" = ?`,
      [scope.tenantId, scope.organizationId],
    )
  }
}

/** Bounded probe used by the concurrency spec to prove the advisory key is scope-specific. */
export async function countAdvisoryLocksHeld(em: EntityManager): Promise<number> {
  const rows = await em.getConnection().execute<{ count: string }[]>(
    `select count(*)::text as count from pg_locks where locktype = 'advisory'`,
  )
  return Number(rows[0]?.count ?? '0')
}

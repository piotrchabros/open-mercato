import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'

/**
 * SQL fixtures for the Case-reparenting specs.
 *
 * Everything here reaches the Connect tables through raw SQL, and NOTHING in
 * this file (or any spec importing it) may import `../data/entities`. Playwright
 * transpiles specs with standard TC39 decorators while the ORM entities use
 * MikroORM's legacy ones; a single offending import throws during collection,
 * and a collection error aborts the ENTIRE repository's run rather than just
 * that spec. This is the same rule the principal-classification specs follow.
 *
 * Cases have no creation API on purpose — a Case originates from an authorized
 * inbound receipt — so seeding them directly is the supported route for a test
 * that needs one to exist before exercising a correction.
 */

export type ReparentingScope = {
  tenantId: string
  organizationId: string
}

export type SeededCase = {
  id: string
  number: number
  updatedAt: string
}

export type SeededConversation = {
  id: string
  bindingId: string
  externalConversationId: string
}

/**
 * A tag stamped into every seeded row's channel id so teardown can find them.
 *
 * Cleanup is by explicit id list rather than by tag — a `delete where` over a
 * shared table is how a test suite eats somebody else's data — but the tag
 * makes an orphan easy to spot when a run is killed mid-test.
 */
export function newFixtureChannelId(): string {
  return randomUUID()
}

export async function seedCase(
  em: EntityManager,
  scope: ReparentingScope,
  values: {
    channelId: string
    status?: string
    priority?: string
    customerKind?: 'person' | 'company' | null
    customerId?: string | null
    assigneeUserId?: string | null
    firstInboundAt?: Date | null
    lastInboundAt?: Date | null
    resolvedAt?: Date | null
    slaGeneration?: number
  },
): Promise<SeededCase> {
  // The number comes from the same locked sequence production uses, so a spec
  // seeding cases concurrently with anything else cannot collide.
  const allocated = await em.getConnection().execute<Array<{ allocated: string | number }>>(
    `insert into connect_case_number_sequences
       (tenant_id, organization_id, next_number, created_at, updated_at)
     values (?, ?, 2, now(), now())
     on conflict (tenant_id, organization_id) do update
        set next_number = connect_case_number_sequences.next_number + 1, updated_at = now()
     returning next_number - 1 as allocated`,
    [scope.tenantId, scope.organizationId],
  )
  const number = Number(allocated[0]?.allocated ?? 1)

  const rows = await em.getConnection().execute<Array<{ id: string; updated_at: string }>>(
    `insert into connect_cases
       (tenant_id, organization_id, number, display_label, status, priority,
        assignee_user_id, customer_kind, customer_id, channel_id,
        first_inbound_at, last_inbound_at, resolved_at, sla_generation, lineage_version, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, now(), now())
     returning id, updated_at`,
    [
      scope.tenantId,
      scope.organizationId,
      number,
      `fixture-case-${number}`,
      values.status ?? 'in_progress',
      values.priority ?? 'normal',
      values.assigneeUserId ?? null,
      values.customerKind ?? null,
      values.customerId ?? null,
      values.channelId,
      values.firstInboundAt ?? new Date(Date.now() - 3_600_000),
      values.lastInboundAt ?? new Date(Date.now() - 600_000),
      values.resolvedAt ?? null,
      values.slaGeneration ?? 0,
    ],
  )
  const row = rows[0]
  return { id: row.id, number, updatedAt: new Date(row.updated_at).toISOString() }
}

export async function seedConversation(
  em: EntityManager,
  scope: ReparentingScope,
  values: { channelId: string; caseId: string; lastMessageAt?: Date | null },
): Promise<SeededConversation> {
  const externalConversationId = randomUUID()
  const conversationRows = await em.getConnection().execute<Array<{ id: string }>>(
    `insert into connect_conversations
       (tenant_id, organization_id, channel_id, external_conversation_id, current_case_id,
        last_message_at, reply_target_ref, reply_target_masked_label, reply_target_source_version,
        created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 1, now(), now())
     returning id`,
    [
      scope.tenantId,
      scope.organizationId,
      values.channelId,
      externalConversationId,
      values.caseId,
      values.lastMessageAt ?? new Date(Date.now() - 600_000),
      `fixture-reply-ref-${externalConversationId}`,
      'f***@example.test',
    ],
  )
  const conversationId = conversationRows[0].id

  const bindingRows = await em.getConnection().execute<Array<{ id: string }>>(
    `insert into connect_conversation_case_bindings
       (tenant_id, organization_id, conversation_id, case_id, bound_at, reason, created_at)
     values (?, ?, ?, ?, now(), 'fixture', now())
     returning id`,
    [scope.tenantId, scope.organizationId, conversationId, values.caseId],
  )

  return { id: conversationId, bindingId: bindingRows[0].id, externalConversationId }
}

export type CaseRow = {
  id: string
  status: string
  merged_into_case_id: string | null
  split_from_case_id: string | null
  lineage_version: number
  sla_generation: number
  closed_at: string | null
  first_inbound_at: string | null
  last_inbound_at: string | null
  updated_at: string
  deleted_at: string | null
  channel_id: string
  customer_id: string | null
  number: number
}

export async function readCase(em: EntityManager, caseId: string): Promise<CaseRow | null> {
  const rows = await em.getConnection().execute<CaseRow[]>(
    `select id, status, merged_into_case_id, split_from_case_id, sla_generation, lineage_version, closed_at,
            first_inbound_at, last_inbound_at, updated_at, deleted_at, channel_id, customer_id, number
       from connect_cases where id = ?`,
    [caseId],
  )
  return rows[0] ?? null
}

export async function readConversationCaseId(
  em: EntityManager,
  conversationId: string,
): Promise<string | null> {
  const rows = await em.getConnection().execute<Array<{ current_case_id: string | null }>>(
    `select current_case_id from connect_conversations where id = ?`,
    [conversationId],
  )
  return rows[0]?.current_case_id ?? null
}

export type BindingRow = { id: string; case_id: string; unbound_at: string | null; reason: string | null }

export async function readBindings(em: EntityManager, conversationId: string): Promise<BindingRow[]> {
  return em.getConnection().execute<BindingRow[]>(
    `select id, case_id, unbound_at, reason from connect_conversation_case_bindings
      where conversation_id = ? order by bound_at asc, id asc`,
    [conversationId],
  )
}

export async function countActiveBindings(em: EntityManager, conversationId: string): Promise<number> {
  const rows = await em.getConnection().execute<Array<{ count: string }>>(
    `select count(*)::text as count from connect_conversation_case_bindings
      where conversation_id = ? and unbound_at is null`,
    [conversationId],
  )
  return Number(rows[0]?.count ?? '0')
}

export type ReparentingRow = {
  id: string
  operation: string
  source_case_id: string
  destination_case_id: string
  status: string
  reverses_reparenting_id: string | null
  reason: string
  client_command_key: string
}

export async function readReparentings(
  em: EntityManager,
  scope: ReparentingScope,
  caseId: string,
): Promise<ReparentingRow[]> {
  return em.getConnection().execute<ReparentingRow[]>(
    `select id, operation, source_case_id, destination_case_id, status, reverses_reparenting_id,
            reason, client_command_key
       from connect_case_reparentings
      where tenant_id = ? and organization_id = ? and (source_case_id = ? or destination_case_id = ?)
      order by created_at asc, id asc`,
    [scope.tenantId, scope.organizationId, caseId, caseId],
  )
}

export async function readOutboxEventTypes(
  em: EntityManager,
  scope: ReparentingScope,
  sourceEventIds: string[],
): Promise<Array<{ source_event_id: string; event_type: string; payload: Record<string, unknown> }>> {
  if (!sourceEventIds.length) return []
  const placeholders = sourceEventIds.map(() => '?').join(', ')
  return em.getConnection().execute(
    `select source_event_id, event_type, payload from connect_domain_outbox
      where tenant_id = ? and source_event_id in (${placeholders})`,
    [scope.tenantId, ...sourceEventIds],
  )
}

export async function countTransitions(em: EntityManager, caseId: string): Promise<number> {
  const rows = await em.getConnection().execute<Array<{ count: string }>>(
    `select count(*)::text as count from connect_case_transitions where case_id = ?`,
    [caseId],
  )
  return Number(rows[0]?.count ?? '0')
}

/**
 * Remove everything a spec seeded, child rows first.
 *
 * Always called from `finally`. A spec that leaves Cases behind poisons the
 * next run's Inbox assertions, and a shared development database is exactly
 * where that goes unnoticed for a week.
 */
export async function cleanupFixtures(
  em: EntityManager,
  ids: { caseIds: string[]; conversationIds: string[] },
): Promise<void> {
  const connection = em.getConnection()
  const caseIds = ids.caseIds.filter(Boolean)
  const conversationIds = ids.conversationIds.filter(Boolean)

  if (caseIds.length) {
    const placeholders = caseIds.map(() => '?').join(', ')
    await connection.execute(
      `delete from connect_case_reparenting_items
        where reparenting_id in (
          select id from connect_case_reparentings
           where source_case_id in (${placeholders}) or destination_case_id in (${placeholders})
        )`,
      [...caseIds, ...caseIds],
    )
    await connection.execute(
      `delete from connect_domain_outbox where source_event_id in (
         select id::text from connect_case_reparentings
          where source_case_id in (${placeholders}) or destination_case_id in (${placeholders})
       )`,
      [...caseIds, ...caseIds],
    )
    await connection.execute(
      `delete from connect_case_reparentings
        where source_case_id in (${placeholders}) or destination_case_id in (${placeholders})`,
      [...caseIds, ...caseIds],
    )
  }
  if (conversationIds.length) {
    const placeholders = conversationIds.map(() => '?').join(', ')
    await connection.execute(
      `delete from connect_conversation_case_bindings where conversation_id in (${placeholders})`,
      conversationIds,
    )
    await connection.execute(
      `delete from connect_outbound_messages where conversation_id in (${placeholders})`,
      conversationIds,
    )
    await connection.execute(`delete from connect_conversations where id in (${placeholders})`, conversationIds)
  }
  if (caseIds.length) {
    const placeholders = caseIds.map(() => '?').join(', ')
    await connection.execute(`delete from connect_case_transitions where case_id in (${placeholders})`, caseIds)
    await connection.execute(`delete from connect_case_read_states where case_id in (${placeholders})`, caseIds)
    await connection.execute(`delete from connect_conversation_case_bindings where case_id in (${placeholders})`, caseIds)
    // A split child is discovered rather than tracked by the spec, so clear
    // descendants before the parents they point at.
    await connection.execute(`delete from connect_cases where split_from_case_id in (${placeholders})`, caseIds)
    await connection.execute(`delete from connect_cases where id in (${placeholders})`, caseIds)
  }
}

/** Ids the fixtures created, so a spec can clean up without tracking them by hand. */
export class FixtureLedger {
  readonly caseIds: string[] = []
  readonly conversationIds: string[] = []

  trackCase(id: string): string {
    this.caseIds.push(id)
    return id
  }

  trackConversation(id: string): string {
    this.conversationIds.push(id)
    return id
  }

  async cleanup(em: EntityManager): Promise<void> {
    await cleanupFixtures(em, { caseIds: this.caseIds, conversationIds: this.conversationIds })
  }
}

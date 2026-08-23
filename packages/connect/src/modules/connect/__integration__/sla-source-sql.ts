import type { EntityManager } from '@mikro-orm/postgresql'

// Playwright transpiles specs with standard TC39 decorators while the ORM
// entities use MikroORM's legacy decorators. Importing `../data/entities` from
// a spec therefore throws while Playwright is COLLECTING tests, and a collection
// error aborts the entire repository run, not just this file. These helpers
// reach the SLA source-fact tables through SQL so no spec ever loads an entity.

export type FactScope = {
  tenantId: string
  organizationId: string
}

export type GenerationFactInput = FactScope & {
  sourceEventId: string
  caseId: string
  generation: number
  channelId: string
  boundary: 'started' | 'resolved'
  cause: 'opened' | 'reopened' | 'resolved'
  startedAt: string
  resolvedAt?: string | null
  occurredAt: string
}

export async function insertGenerationFact(
  em: EntityManager,
  values: GenerationFactInput,
): Promise<void> {
  await em.getConnection().execute(
    `insert into connect_case_generation_facts
       (tenant_id, organization_id, source_event_id, case_id, generation, channel_id,
        boundary, cause, started_at, resolved_at, occurred_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [
      values.tenantId,
      values.organizationId,
      values.sourceEventId,
      values.caseId,
      values.generation,
      values.channelId,
      values.boundary,
      values.cause,
      values.startedAt,
      values.resolvedAt ?? null,
      values.occurredAt,
    ],
  )
}

export type WaitFactInput = FactScope & {
  sourceEventId: string
  caseId: string
  generation: number
  boundary: 'started' | 'ended'
  startedAt: string
  endedAt?: string | null
  occurredAt: string
}

export async function insertWaitFact(em: EntityManager, values: WaitFactInput): Promise<void> {
  await em.getConnection().execute(
    `insert into connect_case_wait_facts
       (tenant_id, organization_id, source_event_id, case_id, generation,
        boundary, started_at, ended_at, occurred_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [
      values.tenantId,
      values.organizationId,
      values.sourceEventId,
      values.caseId,
      values.generation,
      values.boundary,
      values.startedAt,
      values.endedAt ?? null,
      values.occurredAt,
    ],
  )
}

export type DeliveryFactInput = FactScope & {
  sourceEventId: string
  caseId: string
  generation: number
  outboundMessageId: string
  attemptId: string
  deliveryRevision: number
  confirmedAt: string
  responseEvidence: string
  authorUserId?: string | null
  acceptedByUserId?: string | null
  occurredAt: string
}

export async function insertDeliveryFact(
  em: EntityManager,
  values: DeliveryFactInput,
): Promise<void> {
  await em.getConnection().execute(
    `insert into connect_outbound_delivery_facts
       (tenant_id, organization_id, source_event_id, case_id, generation, outbound_message_id,
        attempt_id, delivery_revision, confirmed_at, response_evidence, response_evidence_version,
        author_user_id, accepted_by_user_id, occurred_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, now())`,
    [
      values.tenantId,
      values.organizationId,
      values.sourceEventId,
      values.caseId,
      values.generation,
      values.outboundMessageId,
      values.attemptId,
      values.deliveryRevision,
      values.confirmedAt,
      values.responseEvidence,
      values.authorUserId ?? null,
      values.acceptedByUserId ?? null,
      values.occurredAt,
    ],
  )
}

export type CaseRowInput = FactScope & {
  caseId: string
  channelId: string
  number: number
  status?: string
  assigneeUserId?: string | null
}

export async function insertCaseRow(em: EntityManager, values: CaseRowInput): Promise<void> {
  await em.getConnection().execute(
    `insert into connect_cases
       (id, tenant_id, organization_id, number, channel_id, status, priority,
        assignee_user_id, sla_generation, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, 'normal', ?, 0, now(), now())`,
    [
      values.caseId,
      values.tenantId,
      values.organizationId,
      values.number,
      values.channelId,
      values.status ?? 'new',
      values.assigneeUserId ?? null,
    ],
  )
}

export async function readCaseGeneration(
  em: EntityManager,
  scope: FactScope & { caseId: string },
): Promise<number | null> {
  const rows = await em.getConnection().execute<{ sla_generation: number }[]>(
    `select sla_generation from connect_cases
      where id = ? and tenant_id = ? and organization_id = ?`,
    [scope.caseId, scope.tenantId, scope.organizationId],
  )
  const row = rows[0]
  return row ? Number(row.sla_generation) : null
}

/**
 * Remove only what a spec created, keyed by the Case ids it owns.
 *
 * Scoped deletes rather than a scope-wide truncate: the integration database is
 * shared with every other spec in the run, and wiping the organization would
 * silently break whichever of them happened to go second.
 */
export async function deleteFactsForCases(
  em: EntityManager,
  scope: FactScope & { caseIds: string[] },
): Promise<void> {
  if (scope.caseIds.length === 0) return
  const placeholders = scope.caseIds.map(() => '?').join(', ')
  const params = [scope.tenantId, scope.organizationId, ...scope.caseIds]
  for (const table of [
    'connect_case_generation_facts',
    'connect_case_wait_facts',
    'connect_outbound_delivery_facts',
  ]) {
    await em.getConnection().execute(
      `delete from ${table}
        where tenant_id = ? and organization_id = ? and case_id in (${placeholders})`,
      params,
    )
  }
  await em.getConnection().execute(
    `delete from connect_cases
      where tenant_id = ? and organization_id = ? and id in (${placeholders})`,
    params,
  )
}

export async function nextCaseNumber(em: EntityManager, scope: FactScope): Promise<number> {
  const rows = await em.getConnection().execute<{ next: string }[]>(
    `select coalesce(max(number), 0) + 1 as next from connect_cases
      where tenant_id = ? and organization_id = ?`,
    [scope.tenantId, scope.organizationId],
  )
  return Number(rows[0]?.next ?? '1')
}

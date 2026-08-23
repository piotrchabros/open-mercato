import type { EntityManager } from '@mikro-orm/postgresql'

// Playwright transpiles specs with standard TC39 decorators while the ORM
// entities use MikroORM's legacy decorators. Importing `connect/data/entities`
// from a spec therefore throws during test collection, and because a collection
// error aborts the whole run it takes every other spec in the repository down
// with it. These helpers seed the Phase 1 aggregate through SQL so no spec ever
// loads an entity class.

export type MetricDayScope = {
  tenantId: string
  organizationId: string
}

export type MetricDaySeed = {
  utcDate: string
  inboundClaimed?: number
  casesOpened?: number
  casesAttached?: number
  inboundSuppressed?: number
  inboundDeadLettered?: number
  outboundAttempted?: number
  outboundSent?: number
  outboundFailed?: number
  outboundUnknown?: number
  unknownMaxAgeSeconds?: number | null
  casesAssigned?: number
  casesResolved?: number
  casesReopened?: number
  firstResponseP50Seconds?: number | null
  firstResponseP90Seconds?: number | null
  firstResponseSampleCount?: number
  elapsedResolutionP50Seconds?: number | null
  elapsedResolutionP90Seconds?: number | null
  elapsedResolutionSampleCount?: number
  projectionLagP50Ms?: number | null
  projectionLagP90Ms?: number | null
  projectionLagMaxMs?: number | null
  projectionSampleCount?: number
  projectionFailed?: number
  observedMaxPermittedPerSender?: number
  appliedCountLimit?: number | null
  stale?: boolean
  generatedAt?: string
}

export async function insertMetricDay(
  em: EntityManager,
  scope: MetricDayScope,
  seed: MetricDaySeed,
): Promise<void> {
  await em.getConnection().execute(
    `insert into connect_metric_daily (
       tenant_id, organization_id, utc_date,
       inbound_claimed, cases_opened, cases_attached, inbound_suppressed, inbound_dead_lettered,
       outbound_attempted, outbound_sent, outbound_failed, outbound_unknown, unknown_max_age_seconds,
       cases_assigned, cases_resolved, cases_reopened,
       first_response_p50_seconds, first_response_p90_seconds, first_response_sample_count,
       elapsed_resolution_p50_seconds, elapsed_resolution_p90_seconds, elapsed_resolution_sample_count,
       projection_lag_p50_ms, projection_lag_p90_ms, projection_lag_max_ms,
       projection_sample_count, projection_failed,
       observed_max_permitted_per_sender, applied_count_limit,
       stale, generated_at, created_at, updated_at
     ) values (
       ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?,
       ?, ?,
       ?, ?,
       ?, ?, now(), now()
     )`,
    [
      scope.tenantId,
      scope.organizationId,
      seed.utcDate,
      seed.inboundClaimed ?? 0,
      seed.casesOpened ?? 0,
      seed.casesAttached ?? 0,
      seed.inboundSuppressed ?? 0,
      seed.inboundDeadLettered ?? 0,
      seed.outboundAttempted ?? 0,
      seed.outboundSent ?? 0,
      seed.outboundFailed ?? 0,
      seed.outboundUnknown ?? 0,
      seed.unknownMaxAgeSeconds ?? null,
      seed.casesAssigned ?? 0,
      seed.casesResolved ?? 0,
      seed.casesReopened ?? 0,
      seed.firstResponseP50Seconds ?? null,
      seed.firstResponseP90Seconds ?? null,
      seed.firstResponseSampleCount ?? 0,
      seed.elapsedResolutionP50Seconds ?? null,
      seed.elapsedResolutionP90Seconds ?? null,
      seed.elapsedResolutionSampleCount ?? 0,
      seed.projectionLagP50Ms ?? null,
      seed.projectionLagP90Ms ?? null,
      seed.projectionLagMaxMs ?? null,
      seed.projectionSampleCount ?? 0,
      seed.projectionFailed ?? 0,
      seed.observedMaxPermittedPerSender ?? 0,
      seed.appliedCountLimit ?? null,
      seed.stale ?? false,
      seed.generatedAt ?? `${seed.utcDate}T23:59:00.000Z`,
    ],
  )
}

/**
 * Removes only the rows a test seeded. The suite must never truncate the table:
 * a developer's local aggregates are real data as far as this test is
 * concerned.
 */
export async function deleteMetricDays(
  em: EntityManager,
  scope: MetricDayScope,
  utcDates: string[],
): Promise<void> {
  if (!utcDates.length) return
  await em.getConnection().execute(
    `delete from connect_metric_daily
      where tenant_id = ? and organization_id = ? and utc_date = any(?)`,
    [scope.tenantId, scope.organizationId, utcDates],
  )
}

export async function countMetricDays(
  em: EntityManager,
  scope: MetricDayScope,
  utcDates: string[],
): Promise<number> {
  const rows = await em.getConnection().execute<{ count: string }[]>(
    `select count(*)::text as count from connect_metric_daily
      where tenant_id = ? and organization_id = ? and utc_date = any(?)`,
    [scope.tenantId, scope.organizationId, utcDates],
  )
  return Number(rows[0]?.count ?? '0')
}

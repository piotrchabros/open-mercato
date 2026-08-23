import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectMetricDaily } from '../data/entities'

/**
 * The sanctioned read facade over `connect_metric_daily`.
 *
 * Connect keeps ownership of the storage and of what a counter MEANS; a
 * consumer gets aggregates and nothing else. The DTO deliberately carries no
 * receipt id, no sender hash, no handle, no subject, no body and no
 * customer/Case identifier, so a reporting module cannot reconstruct traffic
 * for an individual person from a report it is allowed to read.
 *
 * The range is already validated by the caller and is applied verbatim: this
 * reader never clamps or widens it, because a facade that quietly changed the
 * cohort would make every published number unfalsifiable.
 */

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * `p50`/`p90` are seconds, matching the Phase 1 aggregate columns. `null` for
 * either value with a non-zero `sampleCount` is possible when the source row
 * has no computed percentile, and stays null rather than becoming zero.
 */
const percentileSchema = z
  .object({
    p50: z.number().nonnegative().nullable(),
    p90: z.number().nonnegative().nullable(),
    sampleCount: z.number().int().nonnegative(),
  })
  .strict()

const projectionSchema = z
  .object({
    p50Ms: z.number().nonnegative().nullable(),
    p90Ms: z.number().nonnegative().nullable(),
    maxMs: z.number().nonnegative().nullable(),
    sampleCount: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict()

export const connectOperationalMetricDaySchema = z
  .object({
    utcDate: dateSchema,
    inboundClaimed: z.number().int().nonnegative(),
    casesOpened: z.number().int().nonnegative(),
    casesAttached: z.number().int().nonnegative(),
    inboundSuppressed: z.number().int().nonnegative(),
    inboundDeadLettered: z.number().int().nonnegative(),
    // Signed: the published reconciliation invariant can go negative when
    // dispositions outrun claims, and hiding that would hide the defect.
    unreconciled: z.number().int(),
    outboundAttempted: z.number().int().nonnegative(),
    outboundSent: z.number().int().nonnegative(),
    outboundFailed: z.number().int().nonnegative(),
    outboundUnknown: z.number().int().nonnegative(),
    unknownMaxAgeSeconds: z.number().int().nonnegative().nullable(),
    casesAssigned: z.number().int().nonnegative(),
    casesResolved: z.number().int().nonnegative(),
    casesReopened: z.number().int().nonnegative(),
    firstResponse: percentileSchema.nullable(),
    elapsedAssignedToResolution: percentileSchema.nullable(),
    projectionLag: projectionSchema.nullable(),
    suppression: z
      .object({
        observedMaxPermittedPerSender: z.number().int().nonnegative(),
        appliedCountLimit: z.number().int().positive().nullable(),
        withinLimit: z.boolean().nullable(),
      })
      .strict(),
    generatedAt: z.string().datetime(),
    stale: z.boolean(),
  })
  .strict()

export type ConnectOperationalMetricDay = z.infer<typeof connectOperationalMetricDaySchema>

export type ConnectOperationalMetricsRange = {
  tenantId: string
  organizationId: string
  fromUtcDate: string
  toUtcDate: string
}

export type ConnectOperationalMetricsReader = {
  listDaily(input: ConnectOperationalMetricsRange): Promise<ConnectOperationalMetricDay[]>
}

type MetricDailyRow = Pick<
  ConnectMetricDaily,
  | 'utcDate'
  | 'inboundClaimed'
  | 'casesOpened'
  | 'casesAttached'
  | 'inboundSuppressed'
  | 'inboundDeadLettered'
  | 'outboundAttempted'
  | 'outboundSent'
  | 'outboundFailed'
  | 'outboundUnknown'
  | 'unknownMaxAgeSeconds'
  | 'casesAssigned'
  | 'casesResolved'
  | 'casesReopened'
  | 'firstResponseP50Seconds'
  | 'firstResponseP90Seconds'
  | 'firstResponseSampleCount'
  | 'elapsedResolutionP50Seconds'
  | 'elapsedResolutionP90Seconds'
  | 'elapsedResolutionSampleCount'
  | 'projectionLagP50Ms'
  | 'projectionLagP90Ms'
  | 'projectionLagMaxMs'
  | 'projectionSampleCount'
  | 'projectionFailed'
  | 'observedMaxPermittedPerSender'
  | 'appliedCountLimit'
  | 'stale'
  | 'generatedAt'
>

/**
 * Row -> DTO. Exported so the aggregate semantics have exactly one definition
 * and a unit test can assert them without a database.
 */
export function toConnectOperationalMetricDay(row: MetricDailyRow): ConnectOperationalMetricDay {
  const appliedCountLimit = row.appliedCountLimit ?? null
  return {
    utcDate: row.utcDate,
    inboundClaimed: row.inboundClaimed,
    casesOpened: row.casesOpened,
    casesAttached: row.casesAttached,
    inboundSuppressed: row.inboundSuppressed,
    inboundDeadLettered: row.inboundDeadLettered,
    unreconciled:
      row.inboundClaimed -
      row.casesOpened -
      row.casesAttached -
      row.inboundSuppressed -
      row.inboundDeadLettered,
    outboundAttempted: row.outboundAttempted,
    outboundSent: row.outboundSent,
    outboundFailed: row.outboundFailed,
    outboundUnknown: row.outboundUnknown,
    unknownMaxAgeSeconds: row.unknownMaxAgeSeconds ?? null,
    casesAssigned: row.casesAssigned,
    casesResolved: row.casesResolved,
    casesReopened: row.casesReopened,
    // An empty population is unavailable, never a p90 of zero seconds.
    firstResponse: row.firstResponseSampleCount
      ? {
          p50: row.firstResponseP50Seconds ?? null,
          p90: row.firstResponseP90Seconds ?? null,
          sampleCount: row.firstResponseSampleCount,
        }
      : null,
    elapsedAssignedToResolution: row.elapsedResolutionSampleCount
      ? {
          p50: row.elapsedResolutionP50Seconds ?? null,
          p90: row.elapsedResolutionP90Seconds ?? null,
          sampleCount: row.elapsedResolutionSampleCount,
        }
      : null,
    projectionLag: row.projectionSampleCount
      ? {
          p50Ms: row.projectionLagP50Ms ?? null,
          p90Ms: row.projectionLagP90Ms ?? null,
          maxMs: row.projectionLagMaxMs ?? null,
          sampleCount: row.projectionSampleCount,
          failed: row.projectionFailed,
        }
      : null,
    suppression: {
      observedMaxPermittedPerSender: row.observedMaxPermittedPerSender,
      appliedCountLimit,
      withinLimit:
        appliedCountLimit === null ? null : row.observedMaxPermittedPerSender <= appliedCountLimit,
    },
    generatedAt: row.generatedAt.toISOString(),
    stale: row.stale,
  }
}

export function createConnectOperationalMetricsReader(em: EntityManager): ConnectOperationalMetricsReader {
  return {
    async listDaily(input) {
      // Both scope columns are predicates on the query itself. A consumer
      // cannot widen them, and a missing one would be a cross-organization
      // disclosure rather than a broader report.
      const rows = await em.fork().find(
        ConnectMetricDaily,
        {
          tenantId: input.tenantId,
          organizationId: input.organizationId,
          utcDate: { $gte: input.fromUtcDate, $lte: input.toUtcDate },
        },
        { orderBy: { utcDate: 'asc' } },
      )
      return rows.map(toConnectOperationalMetricDay)
    },
  }
}

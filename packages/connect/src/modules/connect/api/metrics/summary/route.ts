import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectMetricDaily } from '../../../data/entities'
import { resolveInboxContext } from '../../../lib/inbox-route-context'

/**
 * Complete-day aggregates for the selected organization.
 *
 * Three deliberate refusals shape this response:
 *
 *   - **Today is excluded.** A partial UTC day always looks like a bad day, and
 *     a reconciliation equation cannot balance while receipts are still in
 *     flight. The response says how many complete days it covered.
 *   - **A missing day is `null`, not zero.** "No traffic" and "never
 *     aggregated" are different facts and an operator must be able to tell them
 *     apart.
 *   - **An empty percentile population is `unavailable`.** A p90 over zero
 *     samples is not zero seconds.
 *
 * `baselineMaturity` exists so nobody reads a trend off four days of data: the
 * spec defers any improvement target until 30 complete days exist.
 */

export const metadata = {
  path: '/connect/metrics/summary',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect.metrics.view'],
  },
}

export const CONNECT_METRICS_MAX_RANGE_DAYS = 92
export const CONNECT_METRICS_BASELINE_DAYS = 30

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const querySchema = z.object({
  from: DATE,
  to: DATE,
})

function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function dayCount(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00.000Z`).getTime()
  const end = new Date(`${to}T00:00:00.000Z`).getTime()
  return Math.floor((end - start) / 86_400_000) + 1
}

export async function GET(req: Request): Promise<Response> {
  const resolved = await resolveInboxContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context

  let query: z.infer<typeof querySchema>
  try {
    query = querySchema.parse(Object.fromEntries(new URL(req.url).searchParams))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid query' },
      { status: 422 },
    )
  }
  if (query.from > query.to) {
    return NextResponse.json({ error: 'The range starts after it ends.' }, { status: 422 })
  }
  if (dayCount(query.from, query.to) > CONNECT_METRICS_MAX_RANGE_DAYS) {
    return NextResponse.json(
      {
        error: `Ranges are limited to ${CONNECT_METRICS_MAX_RANGE_DAYS} days.`,
        code: 'range_too_large',
      },
      { status: 422 },
    )
  }

  // Clamp to yesterday. Serving an in-flight day would show an unreconciled
  // count that is simply "not finished yet" as though it were a defect.
  const today = utcToday()
  const to = query.to >= today ? new Date(new Date(`${today}T00:00:00.000Z`).getTime() - 86_400_000).toISOString().slice(0, 10) : query.to
  if (query.from > to) {
    return NextResponse.json({
      from: query.from,
      to: query.to,
      completeDays: 0,
      days: [],
      totals: null,
      baselineMaturity: { completeDays: 0, requiredDays: CONNECT_METRICS_BASELINE_DAYS, mature: false },
      note: 'incomplete_range',
    })
  }

  const em = (container.resolve('em') as EntityManager).fork()
  const rows = await em.find(
    ConnectMetricDaily,
    {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      utcDate: { $gte: query.from, $lte: to },
    },
    { orderBy: { utcDate: 'asc' } },
  )

  const days = rows.map((row) => ({
    utcDate: row.utcDate,
    inboundClaimed: row.inboundClaimed,
    casesOpened: row.casesOpened,
    casesAttached: row.casesAttached,
    inboundSuppressed: row.inboundSuppressed,
    inboundDeadLettered: row.inboundDeadLettered,
    // The published invariant. Non-zero on a complete day means receipts are
    // stuck, and it is shown rather than smoothed away.
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
    firstResponse: row.firstResponseSampleCount
      ? {
          p50Seconds: row.firstResponseP50Seconds,
          p90Seconds: row.firstResponseP90Seconds,
          sampleCount: row.firstResponseSampleCount,
        }
      : null,
    elapsedAssignedToResolution: row.elapsedResolutionSampleCount
      ? {
          p50Seconds: row.elapsedResolutionP50Seconds,
          p90Seconds: row.elapsedResolutionP90Seconds,
          sampleCount: row.elapsedResolutionSampleCount,
        }
      : null,
    // Null, never zero: with the Customer Projection capability absent there is
    // no lag to report, and zero would read as "instant".
    projectionLag: row.projectionSampleCount
      ? {
          p50Ms: row.projectionLagP50Ms,
          p90Ms: row.projectionLagP90Ms,
          maxMs: row.projectionLagMaxMs,
          sampleCount: row.projectionSampleCount,
          failed: row.projectionFailed,
        }
      : null,
    suppression: {
      observedMaxPermittedPerSender: row.observedMaxPermittedPerSender,
      appliedCountLimit: row.appliedCountLimit ?? null,
      // The safety criterion, evaluated rather than left to the reader.
      withinLimit:
        row.appliedCountLimit === null || row.appliedCountLimit === undefined
          ? null
          : row.observedMaxPermittedPerSender <= row.appliedCountLimit,
    },
    generatedAt: row.generatedAt.toISOString(),
    stale: row.stale,
  }))

  const sum = (pick: (day: (typeof days)[number]) => number) => days.reduce((total, day) => total + pick(day), 0)

  return NextResponse.json({
    from: query.from,
    to,
    // Aggregated days, not calendar days. A gap here IS the signal that
    // aggregation has not run for part of the range.
    completeDays: days.length,
    requestedDays: dayCount(query.from, to),
    days,
    totals: days.length
      ? {
          inboundClaimed: sum((day) => day.inboundClaimed),
          casesOpened: sum((day) => day.casesOpened),
          casesAttached: sum((day) => day.casesAttached),
          inboundSuppressed: sum((day) => day.inboundSuppressed),
          inboundDeadLettered: sum((day) => day.inboundDeadLettered),
          unreconciled: sum((day) => day.unreconciled),
          outboundAttempted: sum((day) => day.outboundAttempted),
          outboundSent: sum((day) => day.outboundSent),
          outboundFailed: sum((day) => day.outboundFailed),
          outboundUnknown: sum((day) => day.outboundUnknown),
          casesResolved: sum((day) => day.casesResolved),
          casesReopened: sum((day) => day.casesReopened),
        }
      : null,
    baselineMaturity: {
      completeDays: days.length,
      requiredDays: CONNECT_METRICS_BASELINE_DAYS,
      mature: days.length >= CONNECT_METRICS_BASELINE_DAYS,
    },
  })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    GET: {
      summary: 'Read complete-day Connect operational aggregates',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Aggregates for the complete UTC days in range' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 422, description: 'Invalid or oversized range' },
      ],
    },
  },
}

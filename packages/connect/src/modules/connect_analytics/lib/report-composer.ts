import { z } from 'zod'
import {
  connectOperationalMetricDaySchema,
  type ConnectOperationalMetricDay,
} from '@open-mercato/connect/modules/connect/lib/operational-metrics-reader'

/**
 * Pure composition for the operational report.
 *
 * Two refusals define this file:
 *
 *   - **Totals sum counters only.** A mean of daily p50s is not a range p50,
 *     and publishing one would be arithmetic that looks authoritative and is
 *     wrong. Percentiles stay on the day they were computed for.
 *   - **A missing day is omitted, not synthesised.** `completeDays` counts
 *     aggregated days, so a gap in the series IS the signal that aggregation
 *     has not run — a zero-filled row would hide it.
 *
 * Every published number carries `formulaVersion`, so the meaning of a report
 * cannot change silently under a reader who saved a screenshot.
 */

export const CONNECT_ANALYTICS_OPERATIONAL_FORMULA_VERSION = 'connect_analytics.operational.v1'
export const CONNECT_ANALYTICS_MAX_RANGE_DAYS = 92

const MS_PER_DAY = 86_400_000

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const operationalQuerySchema = z.object({ from: dateSchema, to: dateSchema }).strict()

export const operationalTotalsSchema = z
  .object({
    inboundClaimed: z.number().int(),
    casesOpened: z.number().int(),
    casesAttached: z.number().int(),
    inboundSuppressed: z.number().int(),
    inboundDeadLettered: z.number().int(),
    unreconciled: z.number().int(),
    outboundAttempted: z.number().int(),
    outboundSent: z.number().int(),
    outboundFailed: z.number().int(),
    outboundUnknown: z.number().int(),
    casesAssigned: z.number().int(),
    casesResolved: z.number().int(),
    casesReopened: z.number().int(),
  })
  .strict()

export const operationalReportSchema = z
  .object({
    from: dateSchema,
    to: dateSchema,
    requestedDays: z.number().int().nonnegative(),
    completeDays: z.number().int().nonnegative(),
    formulaVersion: z.literal(CONNECT_ANALYTICS_OPERATIONAL_FORMULA_VERSION),
    operationalMetrics: z.object({ capability: z.literal('available') }).strict(),
    days: z.array(connectOperationalMetricDaySchema),
    totals: operationalTotalsSchema.nullable(),
  })
  .strict()

export const apiErrorSchema = z
  .object({
    error: z.string(),
    code: z.enum([
      'organization_required',
      'invalid_range',
      'range_too_large',
      'metrics_reader_unavailable',
      'unauthorized',
      'forbidden',
    ]),
  })
  .strict()

export type OperationalReport = z.infer<typeof operationalReportSchema>
export type OperationalTotals = z.infer<typeof operationalTotalsSchema>
export type ApiError = z.infer<typeof apiErrorSchema>

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

export function shiftUtcDate(day: string, delta: number): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + delta * MS_PER_DAY)
    .toISOString()
    .slice(0, 10)
}

export function countUtcDays(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00.000Z`).getTime()
  const end = new Date(`${to}T00:00:00.000Z`).getTime()
  return Math.floor((end - start) / MS_PER_DAY) + 1
}

export type OperationalRangeResolution =
  | { kind: 'invalid_range' }
  | { kind: 'range_too_large' }
  /** The clamp left nothing complete to report; the envelope is empty, not an error. */
  | { kind: 'no_complete_days'; to: string }
  | { kind: 'ok'; to: string; requestedDays: number }

/**
 * Resolves the requested range against the complete-day cohort.
 *
 * `todayUtc` is a parameter rather than a `new Date()` call so the cohort rule
 * is testable and so a report never depends on when the process happened to
 * start. Today is excluded exactly as Phase 1 excludes it: a partial UTC day
 * always looks like a bad day, and its reconciliation cannot balance.
 */
export function resolveOperationalRange(input: {
  from: string
  to: string
  todayUtc: string
}): OperationalRangeResolution {
  if (input.from > input.to) return { kind: 'invalid_range' }
  if (countUtcDays(input.from, input.to) > CONNECT_ANALYTICS_MAX_RANGE_DAYS) {
    return { kind: 'range_too_large' }
  }
  const yesterday = shiftUtcDate(input.todayUtc, -1)
  const to = input.to >= input.todayUtc ? yesterday : input.to
  if (input.from > to) return { kind: 'no_complete_days', to }
  return { kind: 'ok', to, requestedDays: countUtcDays(input.from, to) }
}

export function sumOperationalTotals(days: ConnectOperationalMetricDay[]): OperationalTotals | null {
  if (!days.length) return null
  const sum = (pick: (day: ConnectOperationalMetricDay) => number) =>
    days.reduce((total, day) => total + pick(day), 0)
  return {
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
    casesAssigned: sum((day) => day.casesAssigned),
    casesResolved: sum((day) => day.casesResolved),
    casesReopened: sum((day) => day.casesReopened),
  }
}

export function composeOperationalReport(input: {
  from: string
  to: string
  requestedDays: number
  days: ConnectOperationalMetricDay[]
}): OperationalReport {
  const days = [...input.days].sort((left, right) => (left.utcDate < right.utcDate ? -1 : 1))
  return {
    from: input.from,
    to: input.to,
    requestedDays: input.requestedDays,
    // Aggregated days, not calendar days.
    completeDays: days.length,
    formulaVersion: CONNECT_ANALYTICS_OPERATIONAL_FORMULA_VERSION,
    operationalMetrics: { capability: 'available' },
    days,
    totals: sumOperationalTotals(days),
  }
}

export function emptyOperationalReport(input: { from: string; to: string }): OperationalReport {
  return composeOperationalReport({ from: input.from, to: input.to, requestedDays: 0, days: [] })
}

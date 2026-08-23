import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { ConnectAnalyticsMetricsSource } from '../di'
import {
  composeOperationalReport,
  emptyOperationalReport,
  resolveOperationalRange,
  type OperationalReport,
} from './report-composer'

/**
 * The one place a report is produced.
 *
 * The API route and the server-rendered page share it so a reader can never get
 * two different answers for the same range depending on which surface asked.
 * It stays free of HTTP: the caller maps these outcomes onto status codes or
 * onto UI states as appropriate.
 */

export type LoadOperationalReportResult =
  | { status: 'ok'; report: OperationalReport }
  | { status: 'unavailable' }
  | { status: 'invalid_range' }
  | { status: 'range_too_large' }

export async function loadOperationalReport(input: {
  container: AppContainer
  tenantId: string
  organizationId: string
  from: string
  to: string
  todayUtc: string
}): Promise<LoadOperationalReportResult> {
  const range = resolveOperationalRange({ from: input.from, to: input.to, todayUtc: input.todayUtc })
  if (range.kind === 'invalid_range') return { status: 'invalid_range' }
  if (range.kind === 'range_too_large') return { status: 'range_too_large' }

  const source = input.container.resolve('connectAnalyticsMetricsSource') as ConnectAnalyticsMetricsSource
  // Absent Connect is unavailable, never an all-zero dataset that reads as a
  // quiet week.
  if (!source) return { status: 'unavailable' }

  if (range.kind === 'no_complete_days') {
    return { status: 'ok', report: emptyOperationalReport({ from: input.from, to: range.to }) }
  }

  const days = await source.listDaily({
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    fromUtcDate: input.from,
    toUtcDate: range.to,
  })

  return {
    status: 'ok',
    report: composeOperationalReport({
      from: input.from,
      to: range.to,
      requestedDays: range.requestedDays,
      days,
    }),
  }
}

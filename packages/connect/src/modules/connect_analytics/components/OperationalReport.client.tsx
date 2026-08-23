'use client'

import * as React from 'react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { Input } from '@open-mercato/ui/primitives/input'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { OperationalReport } from '../lib/report-composer'

/**
 * The single client island on the analytics page.
 *
 * It exists for the date controls and the refresh, nothing else. Every value it
 * renders comes from the server; it computes no derived statistic, because a
 * number invented in the browser would carry no formula version.
 *
 * Three states are kept distinct on purpose, since collapsing any two of them
 * is how an operator ends up reading "a quiet week" off a broken pipeline:
 *
 *   - **unavailable** — Connect's metrics reader could not be reached.
 *   - **empty** — the range holds no aggregated day.
 *   - **zero** — an aggregated day whose counter really is zero.
 *
 * Every trend value is rendered as exact text in a semantic table, so the
 * screen-reader and high-contrast experience is the same information, not a
 * summary of it.
 */

export type OperationalReportFailure = 'unavailable' | 'load'

type ApiFailureBody = { code?: string }

function formatSeconds(value: number | null): string | null {
  if (value === null) return null
  if (value < 60) return `${Math.round(value)}s`
  if (value < 3600) return `${Math.round(value / 60)}m`
  return `${(value / 3600).toFixed(1)}h`
}

type Props = {
  initialReport: OperationalReport | null
  initialFailure: OperationalReportFailure | null
  initialFrom: string
  initialTo: string
  maxDate: string
}

export function OperationalReportClient({
  initialReport,
  initialFailure,
  initialFrom,
  initialTo,
  maxDate,
}: Props) {
  const t = useT()
  const [from, setFrom] = React.useState(initialFrom)
  const [to, setTo] = React.useState(initialTo)
  const [report, setReport] = React.useState<OperationalReport | null>(initialReport)
  const [failure, setFailure] = React.useState<OperationalReportFailure | null>(initialFailure)
  const [isLoading, setIsLoading] = React.useState(false)
  const [reloadToken, setReloadToken] = React.useState(0)
  const isFirstRender = React.useRef(true)

  const reload = React.useCallback(() => setReloadToken((token) => token + 1), [])

  React.useEffect(() => {
    // The server already rendered the initial range; refetching it on mount
    // would double the work and flash the table for no new information.
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    let cancelled = false
    setIsLoading(true)
    void (async () => {
      const response = await apiCall<OperationalReport & ApiFailureBody>(
        `/api/connect_analytics/reports/operational?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ).catch(() => null)
      if (cancelled) return
      if (response?.ok && response.result) {
        setReport(response.result)
        setFailure(null)
      } else {
        setReport(null)
        setFailure(response?.result?.code === 'metrics_reader_unavailable' ? 'unavailable' : 'load')
      }
      setIsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [from, to, reloadToken])

  const totals = report?.totals ?? null
  const unavailableLabel = t('connect_analytics.table.unavailable', 'unavailable')

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-label={t('connect_analytics.range.aria', 'Reporting range')}
        className="flex flex-wrap items-end gap-3"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('connect_analytics.range.from', 'From (UTC)')}</span>
          <Input type="date" value={from} max={maxDate} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('connect_analytics.range.to', 'To (UTC)')}</span>
          <Input type="date" value={to} max={maxDate} onChange={(event) => setTo(event.target.value)} />
        </label>
        <Button type="button" variant="outline" onClick={reload}>
          {t('connect_analytics.actions.refresh', 'Refresh')}
        </Button>
      </section>

      <p className="text-xs text-muted-foreground">
        {t(
          'connect_analytics.range.explainer',
          'Day boundaries are UTC and today is excluded, because a partial day cannot reconcile. Reporting is read-only: rebuilding aggregates stays on the Connect metrics page.',
        )}
      </p>

      {isLoading ? <LoadingMessage label={t('connect_analytics.loading', 'Loading report...')} /> : null}

      {failure === 'unavailable' ? (
        <Alert status="warning">
          <AlertTitle>
            {t('connect_analytics.unavailable.title', 'Operational metrics are unavailable')}
          </AlertTitle>
          <AlertDescription>
            {t(
              'connect_analytics.unavailable.description',
              'Connect did not answer, so there is no report for this range. This is not a report of zero activity.',
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {failure === 'load' ? (
        <ErrorMessage
          label={t('connect_analytics.errors.load', 'Could not load the operational report')}
          action={
            <Button type="button" size="sm" variant="outline" onClick={reload}>
              {t('connect_analytics.actions.retry', 'Retry')}
            </Button>
          }
        />
      ) : null}

      {report && !isLoading ? (
        <>
          <section
            aria-label={t('connect_analytics.provenance.aria', 'Report provenance')}
            className="rounded-md border border-border p-3 text-xs text-muted-foreground"
          >
            <dl className="grid gap-2 md:grid-cols-4">
              <div>
                <dt className="font-medium">{t('connect_analytics.provenance.cohort', 'Cohort (UTC)')}</dt>
                <dd>{`${report.from} → ${report.to}`}</dd>
              </div>
              <div>
                <dt className="font-medium">
                  {t('connect_analytics.provenance.requestedDays', 'Complete days requested')}
                </dt>
                <dd>{report.requestedDays}</dd>
              </div>
              <div>
                <dt className="font-medium">
                  {t('connect_analytics.provenance.completeDays', 'Days aggregated')}
                </dt>
                <dd>{report.completeDays}</dd>
              </div>
              <div>
                <dt className="font-medium">
                  {t('connect_analytics.provenance.formulaVersion', 'Formula version')}
                </dt>
                <dd>{report.formulaVersion}</dd>
              </div>
            </dl>
          </section>

          {report.completeDays === 0 ? (
            <EmptyState
              title={t('connect_analytics.empty.title', 'No aggregated days in this range')}
              description={t(
                'connect_analytics.empty.description',
                'Either Connect saw no traffic on these days, or aggregation has not run for them yet. The Connect metrics page can rebuild them.',
              )}
            />
          ) : (
            <>
              <section
                aria-label={t('connect_analytics.kpi.aria', 'Range totals')}
                className="grid gap-3 md:grid-cols-4"
              >
                <KpiCard
                  title={t('connect_analytics.kpi.inboundClaimed', 'Inbound received')}
                  value={totals?.inboundClaimed ?? 0}
                />
                <KpiCard
                  title={t('connect_analytics.kpi.casesResolved', 'Cases resolved')}
                  value={totals?.casesResolved ?? 0}
                />
                <KpiCard
                  title={t('connect_analytics.kpi.outboundSent', 'Replies delivered')}
                  value={totals?.outboundSent ?? 0}
                />
                <KpiCard
                  title={t('connect_analytics.kpi.unreconciled', 'Unreconciled inbound')}
                  value={totals?.unreconciled ?? 0}
                />
              </section>

              <section aria-label={t('connect_analytics.daily.aria', 'Daily breakdown')}>
                <SectionHeader title={t('connect_analytics.daily.title', 'Daily breakdown (UTC)')} />
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">
                      {t(
                        'connect_analytics.daily.caption',
                        'Connect operational report by complete UTC day, with the range total in the final row',
                      )}
                    </caption>
                    <thead>
                      <tr className="border-b border-border text-left">
                        <th scope="col" className="p-2">{t('connect_analytics.table.date', 'Date')}</th>
                        <th scope="col" className="p-2">{t('connect_analytics.table.claimed', 'Received')}</th>
                        <th scope="col" className="p-2">{t('connect_analytics.table.opened', 'Opened')}</th>
                        <th scope="col" className="p-2">{t('connect_analytics.table.attached', 'Attached')}</th>
                        <th scope="col" className="p-2">{t('connect_analytics.table.suppressed', 'Suppressed')}</th>
                        <th scope="col" className="p-2">{t('connect_analytics.table.deadLettered', 'Dead-lettered')}</th>
                        <th scope="col" className="p-2">{t('connect_analytics.table.unreconciled', 'Unreconciled')}</th>
                        <th scope="col" className="p-2">{t('connect_analytics.table.outboundSent', 'Delivered')}</th>
                        <th scope="col" className="p-2">{t('connect_analytics.table.outboundFailed', 'Failed')}</th>
                        <th scope="col" className="p-2">{t('connect_analytics.table.outboundUnknown', 'Unknown')}</th>
                        <th scope="col" className="p-2">{t('connect_analytics.table.unknownMaxAge', 'Oldest unknown')}</th>
                        <th scope="col" className="p-2">{t('connect_analytics.table.assigned', 'Assigned')}</th>
                        <th scope="col" className="p-2">{t('connect_analytics.table.resolved', 'Resolved')}</th>
                        <th scope="col" className="p-2">{t('connect_analytics.table.reopened', 'Reopened')}</th>
                        <th scope="col" className="p-2">
                          {t('connect_analytics.table.firstResponse', 'First response p50 / p90')}
                        </th>
                        <th scope="col" className="p-2">
                          {t('connect_analytics.table.elapsed', 'Assigned → resolved p50 / p90')}
                        </th>
                        <th scope="col" className="p-2">
                          {t('connect_analytics.table.suppressionLimit', 'Per-sender limit')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.days.map((day) => (
                        <tr key={day.utcDate} className="border-b border-border">
                          <th scope="row" className="p-2 text-left font-normal">
                            {day.utcDate}
                            {day.stale ? (
                              <span className="ml-1 text-xs text-status-warning-base">
                                {t('connect_analytics.table.stale', '(rebuilding)')}
                              </span>
                            ) : null}
                          </th>
                          <td className="p-2">{day.inboundClaimed}</td>
                          <td className="p-2">{day.casesOpened}</td>
                          <td className="p-2">{day.casesAttached}</td>
                          <td className="p-2">{day.inboundSuppressed}</td>
                          <td className="p-2">{day.inboundDeadLettered}</td>
                          <td className={`p-2 ${day.unreconciled === 0 ? '' : 'text-status-error-base'}`}>
                            {day.unreconciled}
                          </td>
                          <td className="p-2">{day.outboundSent}</td>
                          <td className="p-2">{day.outboundFailed}</td>
                          <td className="p-2">{day.outboundUnknown}</td>
                          <td className="p-2">
                            {day.unknownMaxAgeSeconds === null
                              ? unavailableLabel
                              : formatSeconds(day.unknownMaxAgeSeconds)}
                          </td>
                          <td className="p-2">{day.casesAssigned}</td>
                          <td className="p-2">{day.casesResolved}</td>
                          <td className="p-2">{day.casesReopened}</td>
                          <td className="p-2">
                            {day.firstResponse
                              ? `${formatSeconds(day.firstResponse.p50) ?? unavailableLabel} / ${formatSeconds(day.firstResponse.p90) ?? unavailableLabel} (n=${day.firstResponse.sampleCount})`
                              : unavailableLabel}
                          </td>
                          <td className="p-2">
                            {day.elapsedAssignedToResolution
                              ? `${formatSeconds(day.elapsedAssignedToResolution.p50) ?? unavailableLabel} / ${formatSeconds(day.elapsedAssignedToResolution.p90) ?? unavailableLabel} (n=${day.elapsedAssignedToResolution.sampleCount})`
                              : unavailableLabel}
                          </td>
                          <td
                            className={`p-2 ${day.suppression.withinLimit === false ? 'text-status-error-base' : ''}`}
                          >
                            {day.suppression.appliedCountLimit === null
                              ? unavailableLabel
                              : `${day.suppression.observedMaxPermittedPerSender} / ${day.suppression.appliedCountLimit}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row" className="p-2 text-left">
                          {t('connect_analytics.table.total', 'Range total')}
                        </th>
                        <td className="p-2">{totals?.inboundClaimed ?? 0}</td>
                        <td className="p-2">{totals?.casesOpened ?? 0}</td>
                        <td className="p-2">{totals?.casesAttached ?? 0}</td>
                        <td className="p-2">{totals?.inboundSuppressed ?? 0}</td>
                        <td className="p-2">{totals?.inboundDeadLettered ?? 0}</td>
                        <td className="p-2">{totals?.unreconciled ?? 0}</td>
                        <td className="p-2">{totals?.outboundSent ?? 0}</td>
                        <td className="p-2">{totals?.outboundFailed ?? 0}</td>
                        <td className="p-2">{totals?.outboundUnknown ?? 0}</td>
                        {/* Percentiles and the oldest-unknown age have no
                            meaningful range total: averaging daily percentiles
                            does not produce a range percentile. */}
                        <td className="p-2">{unavailableLabel}</td>
                        <td className="p-2">{totals?.casesAssigned ?? 0}</td>
                        <td className="p-2">{totals?.casesResolved ?? 0}</td>
                        <td className="p-2">{totals?.casesReopened ?? 0}</td>
                        <td className="p-2">{unavailableLabel}</td>
                        <td className="p-2">{unavailableLabel}</td>
                        <td className="p-2">{unavailableLabel}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p className="p-2 text-xs text-muted-foreground">
                  {t(
                    'connect_analytics.daily.footnote',
                    'Percentiles are per day and are never averaged into a range percentile; "n" is the population behind them. Assigned → resolved is wall-clock elapsed time, not active handle time.',
                  )}
                </p>
              </section>
            </>
          )}
        </>
      ) : null}
    </div>
  )
}

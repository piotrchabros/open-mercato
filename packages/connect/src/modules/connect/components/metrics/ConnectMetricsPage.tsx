'use client'

import * as React from 'react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { Button } from '@open-mercato/ui/primitives/button'
import { Input } from '@open-mercato/ui/primitives/input'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { ExceptionsPane } from './ExceptionsPane'
import type { MetricsSummary } from './types'

/**
 * The Connect operations screen.
 *
 * Written to make the shape of the data legible rather than flattering:
 *
 *   - **UTC everywhere, complete days only.** Every label says so. A partial
 *     day always looks like a bad day, and its reconciliation cannot balance.
 *   - **Baseline maturity is stated up front.** Under 30 complete days the
 *     screen says so instead of implying a trend the sample cannot support.
 *   - **Reconciliation is shown as the equation**, not as a verdict, so an
 *     operator can see which term is off.
 *   - **Empty populations read "unavailable", not 0.** A p90 over zero samples
 *     is not zero seconds, and projection lag with the capability absent is not
 *     instantaneous.
 *
 * Every chart-like block here is a table. That is deliberate: a synchronized
 * text equivalent is the accessible form, and with this much of the value in
 * exact integers a table IS the better visualisation.
 */

const DEFAULT_RANGE_DAYS = 30

function shiftDays(day: string, delta: number): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + delta * 86_400_000)
    .toISOString()
    .slice(0, 10)
}

function formatSeconds(value: number | null | undefined): string | null {
  if (typeof value !== 'number') return null
  if (value < 60) return `${Math.round(value)}s`
  if (value < 3600) return `${Math.round(value / 60)}m`
  return `${(value / 3600).toFixed(1)}h`
}

type Props = {
  canManage: boolean
}

export function ConnectMetricsPage({ canManage }: Props) {
  const t = useT()
  const yesterday = React.useMemo(() => shiftDays(new Date().toISOString().slice(0, 10), -1), [])

  const [from, setFrom] = React.useState(() => shiftDays(yesterday, -(DEFAULT_RANGE_DAYS - 1)))
  const [to, setTo] = React.useState(yesterday)
  const [summary, setSummary] = React.useState<MetricsSummary | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [rebuildNotice, setRebuildNotice] = React.useState<string | null>(null)

  const { runMutation, retryLastMutation } = useGuardedMutation({ contextId: 'connect.metrics' })
  const reload = React.useCallback(() => setReloadToken((token) => token + 1), [])

  React.useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    void (async () => {
      const response = await apiCall<MetricsSummary>(
        `/api/connect/metrics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ).catch(() => null)
      if (cancelled) return
      if (!response || !response.ok || !response.result) {
        setError(t('connect.metrics.errors.load', 'Could not load metrics'))
      } else {
        setSummary(response.result)
        setError(null)
      }
      setIsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [from, to, reloadToken, t])

  const rebuild = React.useCallback(async () => {
    setRebuildNotice(null)
    try {
      await runMutation({
        context: { from, to, retryLastMutation },
        mutationPayload: { from, to },
        operation: async () => {
          const response = await apiCall<{ error?: string; days?: number }>('/api/connect/metrics/rebuild', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ from, to }),
          })
          if (!response.ok) {
            throw new Error(
              response.result?.error ?? t('connect.metrics.errors.rebuild', 'Could not start a rebuild'),
            )
          }
          return response.result
        },
      })
      setRebuildNotice(
        t(
          'connect.metrics.rebuild.queued',
          'Rebuild queued. The numbers below stay as they were until it finishes.',
        ),
      )
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('connect.metrics.errors.rebuild', 'Could not start a rebuild'))
    }
  }, [from, reload, retryLastMutation, runMutation, t, to])

  const totals = summary?.totals ?? null
  const unreconciled = totals?.unreconciled ?? 0
  const suppressionBreaches = (summary?.days ?? []).filter((day) => day.suppression.withinLimit === false).length

  return (
    <div className="flex flex-col gap-6">
      <section aria-label={t('connect.metrics.range.aria', 'Reporting range')} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('connect.metrics.range.from', 'From (UTC)')}</span>
          <Input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('connect.metrics.range.to', 'To (UTC)')}</span>
          <Input type="date" value={to} max={yesterday} onChange={(event) => setTo(event.target.value)} />
        </label>
        <Button type="button" variant="outline" onClick={reload}>
          {t('connect.metrics.actions.refresh', 'Refresh')}
        </Button>
        {canManage ? (
          <Button type="button" variant="outline" onClick={() => void rebuild()}>
            {t('connect.metrics.actions.rebuild', 'Rebuild this range')}
          </Button>
        ) : null}
      </section>

      <p className="text-xs text-muted-foreground">
        {t(
          'connect.metrics.range.explainer',
          'All day boundaries are UTC. Today is excluded because a partial day cannot reconcile.',
        )}
      </p>

      {rebuildNotice ? (
        <div role="status" aria-live="polite" className="rounded-md border border-border bg-status-info-bg p-3 text-sm">
          {rebuildNotice}
        </div>
      ) : null}

      {isLoading ? <LoadingMessage label={t('connect.metrics.loading', 'Loading metrics...')} /> : null}
      {error ? (
        <ErrorMessage
          label={error}
          action={
            <Button type="button" size="sm" variant="outline" onClick={reload}>
              {t('connect.metrics.actions.retry', 'Retry')}
            </Button>
          }
        />
      ) : null}

      {summary && !isLoading ? (
        summary.completeDays === 0 ? (
          <EmptyState
            title={t('connect.metrics.empty.title', 'No aggregated days in this range')}
            description={t(
              'connect.metrics.empty.description',
              'Either Connect saw no traffic on these days, or aggregation has not run for them yet. A rebuild resolves the second case.',
            )}
          />
        ) : (
          <>
            <section aria-label={t('connect.metrics.baseline.aria', 'Baseline maturity')}>
              <div
                className={`rounded-md border border-border p-3 text-sm ${
                  summary.baselineMaturity.mature ? 'bg-status-success-bg' : 'bg-status-warning-bg'
                }`}
              >
                {summary.baselineMaturity.mature
                  ? t('connect.metrics.baseline.mature', 'Baseline is mature: {days} complete UTC days.').replace(
                      '{days}',
                      String(summary.baselineMaturity.completeDays),
                    )
                  : t(
                      'connect.metrics.baseline.immature',
                      'Baseline is still forming: {days} of {required} complete UTC days. Read these as observations, not as a trend.',
                    )
                      .replace('{days}', String(summary.baselineMaturity.completeDays))
                      .replace('{required}', String(summary.baselineMaturity.requiredDays))}
              </div>
            </section>

            <section aria-label={t('connect.metrics.safety.aria', 'Safety checks')} className="flex flex-col gap-2">
              <SectionHeader title={t('connect.metrics.safety.title', 'Safety checks')} />
              <ul className="grid gap-2 md:grid-cols-2">
                <li
                  className={`rounded-md border border-border p-3 text-sm ${
                    unreconciled === 0 ? 'bg-status-success-bg' : 'bg-status-error-bg'
                  }`}
                >
                  <span className="font-medium">
                    {t('connect.metrics.safety.reconciliation', 'Inbound reconciliation')}
                  </span>
                  <br />
                  {/* The equation, not a verdict: an operator needs to see which
                      term is off, not just that something is. */}
                  <span>
                    {`${totals?.inboundClaimed ?? 0} claimed − ${totals?.casesOpened ?? 0} opened − ${totals?.casesAttached ?? 0} attached − ${totals?.inboundSuppressed ?? 0} suppressed − ${totals?.inboundDeadLettered ?? 0} dead-lettered = ${unreconciled}`}
                  </span>
                </li>
                <li
                  className={`rounded-md border border-border p-3 text-sm ${
                    suppressionBreaches === 0 ? 'bg-status-success-bg' : 'bg-status-error-bg'
                  }`}
                >
                  <span className="font-medium">
                    {t('connect.metrics.safety.suppression', 'Per-sender inbound limit')}
                  </span>
                  <br />
                  <span>
                    {suppressionBreaches === 0
                      ? t('connect.metrics.safety.suppressionOk', 'No sender exceeded the applied limit.')
                      : t('connect.metrics.safety.suppressionBreached', '{days} day(s) exceeded the applied limit.').replace(
                          '{days}',
                          String(suppressionBreaches),
                        )}
                  </span>
                </li>
              </ul>
            </section>

            <section aria-label={t('connect.metrics.volume.aria', 'Volume')} className="grid gap-3 md:grid-cols-4">
              <KpiCard title={t('connect.metrics.kpi.inboundClaimed', 'Inbound received')} value={totals?.inboundClaimed ?? 0} />
              <KpiCard title={t('connect.metrics.kpi.casesOpened', 'Cases opened')} value={totals?.casesOpened ?? 0} />
              <KpiCard title={t('connect.metrics.kpi.outboundSent', 'Replies delivered')} value={totals?.outboundSent ?? 0} />
              <KpiCard
                title={t('connect.metrics.kpi.outboundUnknown', 'Replies with unknown outcome')}
                value={totals?.outboundUnknown ?? 0}
              />
            </section>

            <section aria-label={t('connect.metrics.daily.aria', 'Daily breakdown')}>
              <SectionHeader title={t('connect.metrics.daily.title', 'Daily breakdown (UTC)')} />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <caption className="sr-only">
                    {t('connect.metrics.daily.caption', 'Connect operational metrics by complete UTC day')}
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th scope="col" className="p-2">{t('connect.metrics.table.date', 'Date')}</th>
                      <th scope="col" className="p-2">{t('connect.metrics.table.claimed', 'Received')}</th>
                      <th scope="col" className="p-2">{t('connect.metrics.table.opened', 'Opened')}</th>
                      <th scope="col" className="p-2">{t('connect.metrics.table.attached', 'Attached')}</th>
                      <th scope="col" className="p-2">{t('connect.metrics.table.suppressed', 'Suppressed')}</th>
                      <th scope="col" className="p-2">{t('connect.metrics.table.unreconciled', 'Unreconciled')}</th>
                      <th scope="col" className="p-2">{t('connect.metrics.table.firstResponse', 'First response p50 / p90')}</th>
                      <th scope="col" className="p-2">{t('connect.metrics.table.elapsed', 'Assigned → resolved p50 / p90')}</th>
                      <th scope="col" className="p-2">{t('connect.metrics.table.projection', 'Projection lag p90')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.days.map((day) => (
                      <tr key={day.utcDate} className="border-b border-border">
                        <th scope="row" className="p-2 text-left font-normal">
                          {day.utcDate}
                          {day.stale ? (
                            <span className="ml-1 text-xs text-status-warning-base">
                              {t('connect.metrics.table.stale', '(rebuilding)')}
                            </span>
                          ) : null}
                        </th>
                        <td className="p-2">{day.inboundClaimed}</td>
                        <td className="p-2">{day.casesOpened}</td>
                        <td className="p-2">{day.casesAttached}</td>
                        <td className="p-2">{day.inboundSuppressed}</td>
                        <td className={`p-2 ${day.unreconciled === 0 ? '' : 'text-status-error-base'}`}>
                          {day.unreconciled}
                        </td>
                        <td className="p-2">
                          {day.firstResponse
                            ? `${formatSeconds(day.firstResponse.p50Seconds)} / ${formatSeconds(day.firstResponse.p90Seconds)} (n=${day.firstResponse.sampleCount})`
                            : t('connect.metrics.table.unavailable', 'unavailable')}
                        </td>
                        <td className="p-2">
                          {day.elapsedAssignedToResolution
                            ? `${formatSeconds(day.elapsedAssignedToResolution.p50Seconds)} / ${formatSeconds(day.elapsedAssignedToResolution.p90Seconds)} (n=${day.elapsedAssignedToResolution.sampleCount})`
                            : t('connect.metrics.table.unavailable', 'unavailable')}
                        </td>
                        <td className="p-2">
                          {day.projectionLag
                            ? `${Math.round((day.projectionLag.p90Ms ?? 0) / 1000)}s (n=${day.projectionLag.sampleCount})`
                            : t('connect.metrics.table.unavailable', 'unavailable')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="p-2 text-xs text-muted-foreground">
                {t(
                  'connect.metrics.table.footnote',
                  'Assigned → resolved is wall-clock elapsed time. It includes waiting on the customer and off-hours, and is not active handle time.',
                )}
              </p>
            </section>

            <ExceptionsPane />
          </>
        )
      ) : null}
    </div>
  )
}

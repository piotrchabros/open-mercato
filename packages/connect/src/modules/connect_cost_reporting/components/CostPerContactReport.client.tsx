'use client'

import * as React from 'react'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { Input } from '@open-mercato/ui/primitives/input'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ReportResponse } from '../data/validators'

type Props = {
  initialReport: ReportResponse | null
  initialFrom: string
  initialTo: string
  initialCurrency: string
}

function toLocalInput(iso: string): string {
  return iso.slice(0, 16)
}

function toIso(local: string): string {
  return new Date(local).toISOString()
}

function amount(minor: string | null, currency: string, unavailable: string): string {
  return minor === null ? unavailable : `${minor} ${currency} ${unavailable}`
}

export function CostPerContactReport({ initialReport, initialFrom, initialTo, initialCurrency }: Props) {
  const t = useT()
  const [from, setFrom] = React.useState(toLocalInput(initialFrom))
  const [to, setTo] = React.useState(toLocalInput(initialTo))
  const [currency, setCurrency] = React.useState(initialCurrency)
  const [report, setReport] = React.useState<ReportResponse | null>(initialReport)
  const [loading, setLoading] = React.useState(false)
  const [failed, setFailed] = React.useState(initialReport === null)
  const unavailable = t('connect_cost_reporting.units.minor', 'minor units')

  const refresh = React.useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const response = await apiCall<ReportResponse>(
        `/api/connect_cost_reporting/report?from=${encodeURIComponent(toIso(from))}&to=${encodeURIComponent(toIso(to))}&currency=${encodeURIComponent(currency)}`,
      )
      if (!response.ok || !response.result) throw new Error('[internal] cost report request failed')
      setReport(response.result)
    } catch {
      setReport(null)
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [currency, from, to])

  const availableReport = report?.capability === 'available' ? report : null

  return (
    <div className="flex flex-col gap-6">
      <section aria-label={t('connect_cost_reporting.range.aria', 'Reporting range')} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('connect_cost_reporting.range.from', 'From')}</span>
          <Input type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('connect_cost_reporting.range.to', 'To')}</span>
          <Input type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">{t('connect_cost_reporting.range.currency', 'Currency')}</span>
          <Input value={currency} maxLength={3} onChange={(event) => setCurrency(event.target.value.toUpperCase())} />
        </label>
        <Button type="button" variant="outline" onClick={() => void refresh()}>
          {t('connect_cost_reporting.actions.refresh', 'Refresh')}
        </Button>
      </section>

      <p className="text-xs text-muted-foreground">
        {t('connect_cost_reporting.page.explainer', 'The cohort counts non-deleted root cases created in the half-open range. Split descendants collapse into their root.')}
      </p>

      {loading ? <LoadingMessage label={t('connect_cost_reporting.loading', 'Loading report...')} /> : null}
      {failed ? <ErrorMessage label={t('connect_cost_reporting.errors.load', 'Could not load the cost report')} /> : null}

      {report?.capability === 'unavailable' && !loading ? (
        <Alert status="warning">
          <AlertTitle>{t('connect_cost_reporting.unavailable.title', 'Cost report unavailable')}</AlertTitle>
          <AlertDescription>
            {t(`connect_cost_reporting.unavailable.${report.reason}`, report.reason)}
          </AlertDescription>
        </Alert>
      ) : null}

      {availableReport && !loading ? (
        <>
          <section aria-label={t('connect_cost_reporting.kpi.aria', 'Cost summary')} className="grid gap-3 md:grid-cols-4">
            {[
              [t('connect_cost_reporting.kpi.total', 'Authoritative total'), amount(availableReport.totals.totalMinor, availableReport.currencyCode, unavailable)],
              [t('connect_cost_reporting.kpi.contacts', 'Canonical contacts'), String(availableReport.denominator)],
              [t('connect_cost_reporting.kpi.perContact', 'Cost per contact'), amount(availableReport.costPerContactMinor, availableReport.currencyCode, unavailable)],
              [t('connect_cost_reporting.kpi.inputs', 'Matched cost inputs'), String(availableReport.matchedInputCount)],
            ].map(([label, value]) => (
              <KpiCard key={label} title={label} value={0} formatValue={() => value} />
            ))}
          </section>

          {availableReport.denominator === 0 ? (
            <EmptyState title={t('connect_cost_reporting.zero.title', 'No canonical contacts')} description={t('connect_cost_reporting.zero.description', 'The result is unavailable because this range has no root contacts.')} />
          ) : null}

          <section aria-label={t('connect_cost_reporting.breakdown.aria', 'Cost breakdown')}>
            <SectionHeader title={t('connect_cost_reporting.breakdown.title', 'Cost breakdown')} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">{t('connect_cost_reporting.breakdown.caption', 'Rounded cost totals by source type')}</caption>
                <thead><tr className="border-b border-border text-left"><th className="p-2" scope="col">{t('connect_cost_reporting.table.type', 'Type')}</th><th className="p-2" scope="col">{t('connect_cost_reporting.table.amount', 'Rounded minor amount')}</th></tr></thead>
                <tbody>
                  {(['agent', 'channel', 'ai'] as const).map((type) => (
                    <tr key={type} className="border-b border-border"><th className="p-2 text-left font-normal" scope="row">{t(`connect_cost_reporting.type.${type}`, type)}</th><td className="p-2">{amount(availableReport.totals[`${type}Minor`], availableReport.currencyCode, unavailable)}</td></tr>
                  ))}
                </tbody>
                <tfoot><tr><th className="p-2 text-left" scope="row">{t('connect_cost_reporting.table.total', 'Authoritative grand total')}</th><td className="p-2">{amount(availableReport.totals.totalMinor, availableReport.currencyCode, unavailable)}</td></tr></tfoot>
              </table>
            </div>
          </section>

          <Alert>
            <AlertTitle>{t('connect_cost_reporting.rounding.title', 'Exact allocation, rounded once')}</AlertTitle>
            <AlertDescription>{t('connect_cost_reporting.rounding.description', 'Each displayed bucket and the authoritative grand total are rounded independently to the nearest minor unit, with halves rounded up.')}</AlertDescription>
          </Alert>

          <section aria-label={t('connect_cost_reporting.provenance.aria', 'Report provenance')} className="rounded-md border border-border p-3 text-xs text-muted-foreground">
            <dl className="grid gap-2 md:grid-cols-3">
              <div><dt className="font-medium">{t('connect_cost_reporting.provenance.formula', 'Formula')}</dt><dd>{availableReport.formulaVersion}</dd></div>
              <div><dt className="font-medium">{t('connect_cost_reporting.provenance.cost', 'Cost source')}</dt><dd>{`${availableReport.costSourceVersion} · ${availableReport.costGeneratedAt}`}</dd></div>
              <div><dt className="font-medium">{t('connect_cost_reporting.provenance.denominator', 'Denominator source')}</dt><dd>{`${availableReport.denominatorSourceVersion} · ${availableReport.denominatorGeneratedAt}`}</dd></div>
            </dl>
          </section>
        </>
      ) : null}
    </div>
  )
}

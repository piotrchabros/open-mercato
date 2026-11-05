'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { formatDateTime } from '@open-mercato/shared/lib/time'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { useAppEvent } from '@open-mercato/ui/backend/injection/useAppEvent'
import { KpiCard } from '@open-mercato/ui/backend/charts'
import { SectionHeader } from '@open-mercato/ui/backend/SectionHeader'
import { Badge } from '@open-mercato/ui/primitives/badge'
import { Button } from '@open-mercato/ui/primitives/button'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@open-mercato/ui/primitives/table'
import {
  formatDuration,
  formatReferrerHost,
  resolveInsightValueKey,
  toTimestamp,
  type InsightsDimension,
} from '../lib/insights-format'
import type { OfferInsightsDto, OfferViewRow } from './types'

const VIEWED_EVENT_ID = 'offer_generator.offer.viewed'

const DIMENSION_FALLBACKS: Record<InsightsDimension, Record<string, string>> = {
  device: { desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet', other: 'Other' },
  browser: {
    chrome: 'Chrome',
    safari: 'Safari',
    firefox: 'Firefox',
    edge: 'Edge',
    opera: 'Opera',
    samsung: 'Samsung Internet',
    other: 'Other',
  },
  os: {
    windows: 'Windows',
    macos: 'macOS',
    ios: 'iOS',
    android: 'Android',
    linux: 'Linux',
    other: 'Other',
  },
}

type OfferInsightsSectionProps = {
  offerId: string
}

export function OfferInsightsSection({ offerId }: OfferInsightsSectionProps) {
  const t = useT()
  const [data, setData] = React.useState<OfferInsightsDto | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)

  const load = React.useCallback(async () => {
    setFailed(false)
    try {
      const result = await readApiResultOrThrow<OfferInsightsDto>(
        `/api/offer_generator/offers/${encodeURIComponent(offerId)}/insights`,
        { cache: 'no-store' },
      )
      setData(result)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [offerId])

  React.useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  useAppEvent(
    VIEWED_EVENT_ID,
    (event) => {
      if (event.payload?.offerId === offerId) void load()
    },
    [offerId, load],
  )

  const dimensionLabel = React.useCallback(
    (dimension: InsightsDimension, value: string): string => {
      const key = resolveInsightValueKey(dimension, value)
      return t(`offer_generator.insights.${dimension}.${key}`, DIMENSION_FALLBACKS[dimension][key])
    },
    [t],
  )

  const deviceSummary = React.useCallback(
    (view: OfferViewRow): string =>
      [
        dimensionLabel('device', view.device),
        dimensionLabel('browser', view.browser),
        dimensionLabel('os', view.os),
      ].join(' / '),
    [dimensionLabel],
  )

  const formatTimestamp = React.useCallback(
    (value: number): string => formatDateTime(new Date(value).toISOString()) ?? '-',
    [],
  )

  if (loading && !data) {
    return <LoadingMessage label={t('offer_generator.insights.loading', 'Loading insights...')} />
  }

  if (failed && !data) {
    return (
      <ErrorMessage
        label={t('offer_generator.insights.loadError', 'Failed to load insights.')}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            {t('offer_generator.insights.retry', 'Retry')}
          </Button>
        }
      />
    )
  }

  if (!data) return null

  const { stats, views, sections } = data

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <SectionHeader
          title={t('offer_generator.insights.stats.title', 'View statistics')}
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {t('offer_generator.insights.refresh', 'Refresh')}
            </Button>
          }
        />
        {failed ? (
          <p className="text-sm text-destructive">
            {t('offer_generator.insights.refreshError', 'Failed to refresh insights.')}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard title={t('offer_generator.insights.stats.views', 'Views')} value={stats.views} />
          <KpiCard
            title={t('offer_generator.insights.stats.uniqueVisitors', 'Unique visitors')}
            value={stats.uniqueVisitors}
          />
          <KpiCard
            title={t('offer_generator.insights.stats.avgTime', 'Average time')}
            value={stats.avgActiveMs}
            formatValue={formatDuration}
          />
          <KpiCard
            title={t('offer_generator.insights.stats.totalTime', 'Total time')}
            value={stats.totalActiveMs}
            formatValue={formatDuration}
          />
          <KpiCard
            title={t('offer_generator.insights.stats.firstViewed', 'First viewed')}
            value={toTimestamp(stats.firstViewedAt)}
            formatValue={formatTimestamp}
           
          />
          <KpiCard
            title={t('offer_generator.insights.stats.lastViewed', 'Last viewed')}
            value={toTimestamp(stats.lastViewAt)}
            formatValue={formatTimestamp}
          />
          <KpiCard
            title={t('offer_generator.insights.stats.avgScroll', 'Average scroll depth')}
            value={stats.avgMaxScrollPct}
            suffix="%"
            formatValue={(value) => String(Math.round(value))}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            'offer_generator.insights.stats.internalNote',
            'Internal views (not counted in statistics): {count}',
            { count: stats.internalViews },
          )}
        </p>
      </div>

      <div className="space-y-3">
        <SectionHeader title={t('offer_generator.insights.views.title', 'Views')} count={views.length} />
        {views.length === 0 ? (
          <EmptyState title={t('offer_generator.insights.views.empty', 'No views yet.')} />
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('offer_generator.insights.views.when', 'When')}</TableHead>
                  <TableHead>{t('offer_generator.insights.views.visitor', 'Visitor')}</TableHead>
                  <TableHead>{t('offer_generator.insights.views.device', 'Device')}</TableHead>
                  <TableHead>{t('offer_generator.insights.views.country', 'Country')}</TableHead>
                  <TableHead>{t('offer_generator.insights.views.referrer', 'Source')}</TableHead>
                  <TableHead>{t('offer_generator.insights.views.activeTime', 'Active time')}</TableHead>
                  <TableHead>{t('offer_generator.insights.views.scroll', 'Scroll')}</TableHead>
                  <TableHead>{t('offer_generator.insights.views.sections', 'Sections')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {views.map((view) => (
                  <TableRow key={view.id} className={view.isInternal ? 'opacity-60' : undefined}>
                    <TableCell className="whitespace-nowrap">{formatDateTime(view.startedAt) ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {t('offer_generator.insights.views.visitorLabel', 'Visitor #{number}', {
                        number: view.visitorNo,
                      })}
                      {view.isInternal ? (
                        <Badge variant="muted" size="sm" className="ml-2">
                          {t('offer_generator.insights.views.internal', 'Internal')}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{deviceSummary(view)}</TableCell>
                    <TableCell>{view.country ?? '-'}</TableCell>
                    <TableCell>{formatReferrerHost(view.referrer) ?? '-'}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDuration(view.activeMs)}</TableCell>
                    <TableCell>{view.maxScrollPct}%</TableCell>
                    <TableCell>{view.sectionsSeen}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {data.truncated ? (
          <p className="text-xs text-muted-foreground">
            {t('offer_generator.insights.views.truncated', 'Showing the {count} most recent views.', {
              count: views.length,
            })}
          </p>
        ) : null}
      </div>

      <div className="space-y-3">
        <SectionHeader title={t('offer_generator.insights.sections.title', 'Section engagement')} />
        {sections.length === 0 ? (
          <EmptyState title={t('offer_generator.insights.sections.empty', 'No section data yet.')} />
        ) : (
          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('offer_generator.insights.sections.label', 'Section')}</TableHead>
                  <TableHead>{t('offer_generator.insights.sections.viewers', 'Viewers')}</TableHead>
                  <TableHead>{t('offer_generator.insights.sections.avgTime', 'Average time')}</TableHead>
                  <TableHead>{t('offer_generator.insights.sections.totalTime', 'Total time')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sections.map((section) => (
                  <TableRow key={section.key}>
                    <TableCell>{section.label}</TableCell>
                    <TableCell>{section.viewers}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDuration(section.avgMs)}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDuration(section.totalMs)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}

export default OfferInsightsSection

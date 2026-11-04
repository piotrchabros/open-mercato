"use client"

import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@open-mercato/ui/primitives/table'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { SyncRunStatusBadge } from './StatusBadges'
import type { PagedResponse, SyncRunDto } from './types'

const PAGE_SIZE = 20
const POLL_INTERVAL_MS = 5000

type SyncRunsSectionProps = {
  refreshToken: number
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

export function SyncRunsSection({ refreshToken }: SyncRunsSectionProps) {
  const t = useT()
  const scopeVersion = useOrganizationScopeVersion()
  const [page, setPage] = React.useState(1)
  const [data, setData] = React.useState<PagedResponse<SyncRunDto> | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async (silent: boolean) => {
    if (!silent) setLoading(true)
    try {
      const result = await readApiResultOrThrow<PagedResponse<SyncRunDto>>(
        `/api/meta_lead_ads/sync-runs?page=${page}&pageSize=${PAGE_SIZE}`,
        undefined,
        { errorMessage: t('meta_lead_ads.syncRuns.errors.load', 'Failed to load sync runs.') },
      )
      setData(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('meta_lead_ads.syncRuns.errors.load', 'Failed to load sync runs.'))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [page, t])

  React.useEffect(() => {
    void load(false)
  }, [load, scopeVersion, refreshToken])

  const hasRunning = Boolean(data?.items.some((run) => run.status === 'running'))

  React.useEffect(() => {
    if (!hasRunning) return
    const timer = setInterval(() => { void load(true) }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [hasRunning, load])

  const items = data?.items ?? []
  const totalPages = data?.totalPages ?? 1

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-base font-semibold">{t('meta_lead_ads.syncRuns.title', 'Sync runs')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('meta_lead_ads.syncRuns.description', 'History of backfills and nightly reconciliations.')}
        </p>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" />
          {t('meta_lead_ads.syncRuns.loading', 'Loading sync runs…')}
        </div>
      ) : error ? (
        <p role="alert" className="text-sm text-destructive">{error}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('meta_lead_ads.syncRuns.empty', 'No sync runs yet.')}</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('meta_lead_ads.syncRuns.columns.kind', 'Type')}</TableHead>
                <TableHead>{t('meta_lead_ads.syncRuns.columns.form', 'Form')}</TableHead>
                <TableHead>{t('meta_lead_ads.syncRuns.columns.range', 'Range')}</TableHead>
                <TableHead>{t('meta_lead_ads.syncRuns.columns.status', 'Status')}</TableHead>
                <TableHead>{t('meta_lead_ads.syncRuns.columns.checked', 'Checked')}</TableHead>
                <TableHead>{t('meta_lead_ads.syncRuns.columns.imported', 'Imported')}</TableHead>
                <TableHead>{t('meta_lead_ads.syncRuns.columns.duplicates', 'Duplicates')}</TableHead>
                <TableHead>{t('meta_lead_ads.syncRuns.columns.failed', 'Failed')}</TableHead>
                <TableHead>{t('meta_lead_ads.syncRuns.columns.startedAt', 'Started')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    {run.kind === 'backfill'
                      ? t('meta_lead_ads.syncRuns.kind.backfill', 'Backfill')
                      : t('meta_lead_ads.syncRuns.kind.reconciliation', 'Reconciliation')}
                  </TableCell>
                  <TableCell>{run.formName ?? '—'}</TableCell>
                  <TableCell>
                    {run.rangeFrom && run.rangeTo
                      ? `${formatTimestamp(run.rangeFrom)} – ${formatTimestamp(run.rangeTo)}`
                      : '—'}
                  </TableCell>
                  <TableCell>
                    <SyncRunStatusBadge status={run.status} />
                    {run.error ? <p className="mt-1 text-xs text-muted-foreground">{run.error}</p> : null}
                  </TableCell>
                  <TableCell>{run.checked}</TableCell>
                  <TableCell>{run.imported}</TableCell>
                  <TableCell>{run.duplicates}</TableCell>
                  <TableCell>{run.failed}</TableCell>
                  <TableCell>{formatTimestamp(run.startedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {totalPages > 1 ? (
            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                {t('meta_lead_ads.syncRuns.pagination.previous', 'Previous')}
              </Button>
              <span className="text-sm text-muted-foreground">
                {t('meta_lead_ads.syncRuns.pagination.page', 'Page {page} of {total}', { page, total: totalPages })}
              </span>
              <Button type="button" variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>
                {t('meta_lead_ads.syncRuns.pagination.next', 'Next')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
}

export default SyncRunsSection

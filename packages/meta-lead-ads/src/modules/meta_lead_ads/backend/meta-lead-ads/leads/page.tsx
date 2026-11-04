"use client"

import * as React from 'react'
import Link from 'next/link'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterOverlay'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useAppEvent } from '@open-mercato/ui/backend/injection/useAppEvent'
import { hasFeature } from '@open-mercato/shared/security/features'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { LeadEventStatusBadge } from '../../../components/StatusBadges'
import type {
  LeadErrorCode,
  LeadEventStatus,
  LeadEventSummaryDto,
  PagedResponse,
  RetryResponse,
} from '../../../components/types'

const STATUS_FILTER_VALUES: LeadEventStatus[] = [
  'received',
  'processing',
  'processed',
  'duplicate',
  'skipped',
  'retrying',
  'failed',
  'dead_lettered',
]
const RETRYABLE_STATUSES: LeadEventStatus[] = ['failed', 'dead_lettered']
const DEFAULT_PAGE_SIZE = 25
const MUTATION_CONTEXT_ID = 'meta_lead_ads-lead-events:retry'

type RetryMutationContext = {
  formId: string
  resourceKind: string
  retryLastMutation: () => Promise<boolean>
}

function isRetryable(row: LeadEventSummaryDto): boolean {
  return RETRYABLE_STATUSES.includes(row.status)
}

function endOfDayIso(value: string): string {
  return `${value}T23:59:59.999Z`
}

export default function MetaLeadAdsLeadsPage() {
  const t = useT()
  const { payload } = useBackendChrome()
  const canManage = hasFeature(payload?.grantedFeatures ?? [], 'meta_lead_ads.manage')
  const [rows, setRows] = React.useState<LeadEventSummaryDto[]>([])
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(DEFAULT_PAGE_SIZE)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [filterValues, setFilterValues] = React.useState<FilterValues>({})
  const [refreshKey, setRefreshKey] = React.useState(0)

  const { runMutation, retryLastMutation } = useGuardedMutation<RetryMutationContext>({
    contextId: MUTATION_CONTEXT_ID,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  const refresh = React.useCallback(() => setRefreshKey((key) => key + 1), [])

  useAppEvent('meta_lead_ads.lead.received', refresh, [refresh])

  const queryString = React.useMemo(() => {
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('pageSize', String(Math.min(pageSize, 100)))
    const statuses = Array.isArray(filterValues.status) ? filterValues.status : []
    if (statuses.length) params.set('status', statuses.join(','))
    const dateRange = filterValues.submittedAt as { from?: string; to?: string } | undefined
    if (dateRange?.from) params.set('from', dateRange.from)
    if (dateRange?.to) params.set('to', endOfDayIso(dateRange.to))
    return params.toString()
  }, [page, pageSize, filterValues])

  React.useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    readApiResultOrThrow<PagedResponse<LeadEventSummaryDto>>(`/api/meta_lead_ads/lead-events?${queryString}`)
      .then((result) => {
        if (cancelled) return
        setRows(result.items)
        setTotal(result.total)
        setTotalPages(result.totalPages)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        setError(t('meta_lead_ads.leads.loadError', 'Failed to load leads.'))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [queryString, refreshKey, t])

  const retryLeads = React.useCallback(async (ids: string[]): Promise<boolean> => {
    if (!ids.length) return false
    try {
      const result = await runMutation({
        operation: () =>
          // optimistic-lock-exempt: retry re-enqueues lead events, no field-level lost-update
          readApiResultOrThrow<RetryResponse>('/api/meta_lead_ads/lead-events/retry', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ids }),
          }),
        context: {
          formId: MUTATION_CONTEXT_ID,
          resourceKind: 'meta_lead_ads.lead_event',
          retryLastMutation,
        },
        mutationPayload: { ids },
      })
      flash(
        t('meta_lead_ads.leads.retry.success', '{count} lead(s) queued for retry.', { count: result.enqueued }),
        result.skipped.length ? 'warning' : 'success',
      )
      refresh()
      return true
    } catch {
      flash(t('meta_lead_ads.leads.retry.error', 'Failed to retry leads.'), 'error')
      return false
    }
  }, [refresh, retryLastMutation, runMutation, t])

  const translateError = React.useCallback((code: LeadErrorCode | null): string => {
    if (!code) return ''
    return t(`meta_lead_ads.errorCodes.${code}`, code)
  }, [t])

  const formatTime = React.useCallback((row: LeadEventSummaryDto): string => {
    const value = row.submittedAt ?? row.receivedAt
    return new Date(value).toLocaleString()
  }, [])

  const columns = React.useMemo<ColumnDef<LeadEventSummaryDto>[]>(() => [
    {
      id: 'time',
      header: t('meta_lead_ads.leads.columns.time', 'Time'),
      accessorFn: formatTime,
      enableSorting: false,
    },
    {
      id: 'page',
      header: t('meta_lead_ads.leads.columns.page', 'Page'),
      accessorFn: (row) => row.pageName ?? '',
      enableSorting: false,
    },
    {
      id: 'form',
      header: t('meta_lead_ads.leads.columns.form', 'Form'),
      accessorFn: (row) => row.formName ?? '',
      enableSorting: false,
    },
    {
      id: 'status',
      header: t('meta_lead_ads.leads.columns.status', 'Status'),
      accessorFn: (row) => row.status,
      cell: ({ row }) => <LeadEventStatusBadge status={row.original.status} />,
      enableSorting: false,
    },
    {
      id: 'error',
      header: t('meta_lead_ads.leads.columns.error', 'Error'),
      accessorFn: (row) => translateError(row.lastErrorCode),
      enableSorting: false,
    },
    {
      id: 'person',
      header: t('meta_lead_ads.leads.columns.person', 'Person'),
      accessorFn: (row) => row.personId ?? '',
      cell: ({ row }) =>
        row.original.personId ? (
          <Link
            href={`/backend/customers/people/${row.original.personId}`}
            className="text-primary underline-offset-2 hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {t('meta_lead_ads.leads.openPerson', 'Open person')}
          </Link>
        ) : null,
      enableSorting: false,
    },
  ], [formatTime, t, translateError])

  const filters = React.useMemo<FilterDef[]>(() => [
    {
      id: 'status',
      label: t('meta_lead_ads.leads.filters.status', 'Status'),
      type: 'select',
      multiple: true,
      options: STATUS_FILTER_VALUES.map((value) => ({
        value,
        label: t(`meta_lead_ads.statuses.leadEvent.${value}`, value),
      })),
    },
    {
      id: 'submittedAt',
      label: t('meta_lead_ads.leads.filters.date', 'Submitted'),
      type: 'dateRange',
    },
  ], [t])

  const bulkActions = React.useMemo(() => (
    canManage
      ? [
          {
            id: 'retry',
            label: t('meta_lead_ads.leads.actions.retrySelected', 'Retry selected'),
            onExecute: async (selected: LeadEventSummaryDto[]) => {
              const retryableIds = selected.filter(isRetryable).map((row) => row.id)
              if (!retryableIds.length) {
                flash(t('meta_lead_ads.leads.retry.noneRetryable', 'No selected lead can be retried.'), 'warning')
                return false
              }
              return retryLeads(retryableIds)
            },
          },
        ]
      : undefined
  ), [canManage, retryLeads, t])

  return (
    <Page>
      <PageBody>
        <DataTable<LeadEventSummaryDto>
          title={t('meta_lead_ads.leads.title', 'Recent leads')}
          titleHeadingLevel={1}
          refreshButton={{
            label: t('meta_lead_ads.leads.actions.refresh', 'Refresh'),
            onRefresh: refresh,
          }}
          columns={columns}
          data={rows}
          isLoading={isLoading}
          error={error}
          filters={filters}
          filterValues={filterValues}
          onFiltersApply={(values) => {
            setFilterValues(values)
            setPage(1)
          }}
          onFiltersClear={() => {
            setFilterValues({})
            setPage(1)
          }}
          bulkActions={bulkActions}
          rowActions={canManage
            ? (row) => (
                isRetryable(row) ? (
                  <RowActions
                    items={[
                      {
                        id: 'retry',
                        label: t('meta_lead_ads.leads.actions.retry', 'Retry'),
                        onSelect: () => {
                          void retryLeads([row.id])
                        },
                      },
                    ]}
                  />
                ) : null
              )
            : undefined}
          pagination={{
            page,
            pageSize,
            total,
            totalPages,
            onPageChange: setPage,
            pageSizeOptions: [10, 25, 50, 100],
            onPageSizeChange: (size) => {
              setPageSize(size)
              setPage(1)
            },
          }}
        />
      </PageBody>
    </Page>
  )
}

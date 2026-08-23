"use client"

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { SortingState } from '@tanstack/react-table'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Plus } from 'lucide-react'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { hasFeature } from '@open-mercato/shared/security/features'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { ListEmptyState } from '@open-mercato/ui/backend/filters/ListEmptyState'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { apiCall, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { formatCostAmount } from '../../../../lib/format-cost-amount'

type CostInputRow = {
  id: string
  periodStart: string | null
  periodEnd: string | null
  costType: 'agent' | 'channel' | 'ai' | null
  userId: string | null
  channelId: string | null
  amountMinor: string | null
  currencyCode: string | null
  source: 'manual' | 'provider_invoice' | null
  providerInvoiceRef: string | null
  providerLineRef: string | null
  createdAt: string | null
  updatedAt: string | null
}

type CostInputListResponse = {
  items: CostInputRow[]
  total: number
  totalPages: number
  totalIsCapped?: boolean
}

function formatUtcDay(value: string | null, emptyLabel: string): string {
  if (!value) return emptyLabel
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? emptyLabel : date.toISOString().slice(0, 10)
}

export default function ConnectCostInputsPage() {
  const translate = useT()
  const locale = useLocale()
  const router = useRouter()
  const scopeVersion = useOrganizationScopeVersion()
  const { payload } = useBackendChrome()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const canManage = hasFeature(payload?.grantedFeatures, 'connect_analytics.cost_inputs.manage')

  const [rows, setRows] = React.useState<CostInputRow[]>([])
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(20)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [totalIsCapped, setTotalIsCapped] = React.useState(false)
  const [sorting, setSorting] = React.useState<SortingState>([{ id: 'periodStart', desc: true }])
  const [filters, setFilters] = React.useState<FilterValues>({})
  const [loading, setLoading] = React.useState(true)
  const [reloadToken, setReloadToken] = React.useState(0)

  const mutationContextId = 'connect-analytics-cost-inputs-list:delete'
  const { runMutation, retryLastMutation } = useGuardedMutation<{
    formId: string
    resourceKind: string
    resourceId: string
    retryLastMutation: () => Promise<boolean>
  }>({
    contextId: mutationContextId,
    blockedMessage: translate('ui.forms.flash.saveBlocked'),
  })

  const queryParams = React.useMemo(() => {
    // Built explicitly rather than spread from filter state: the list route's
    // query schema is strict, so an unexpected parameter is a 400.
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('pageSize', String(pageSize))
    const firstSort = sorting[0]
    if (firstSort) {
      params.set('sortField', firstSort.id)
      params.set('sortDir', firstSort.desc ? 'desc' : 'asc')
    }
    for (const key of ['costType', 'source', 'currencyCode'] as const) {
      const value = filters[key]
      if (typeof value === 'string' && value.trim()) params.set(key, value.trim())
    }
    return params.toString()
  }, [filters, page, pageSize, sorting])

  React.useEffect(() => {
    let cancelled = false
    async function loadRows() {
      setLoading(true)
      try {
        const fallback: CostInputListResponse = { items: [], total: 0, totalPages: 1 }
        const call = await apiCall<CostInputListResponse>(
          `/api/connect_analytics/cost-inputs?${queryParams}`,
          undefined,
          { fallback },
        )
        if (cancelled) return
        if (!call.ok) {
          flash(translate('connect_analytics.costInputs.list.loadError'), 'error')
          return
        }
        const result = call.result ?? fallback
        setRows(Array.isArray(result.items) ? result.items : [])
        setTotal(typeof result.total === 'number' ? result.total : 0)
        setTotalPages(typeof result.totalPages === 'number' ? result.totalPages : 1)
        setTotalIsCapped(result.totalIsCapped === true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void loadRows()
    return () => {
      cancelled = true
    }
  }, [queryParams, reloadToken, scopeVersion, translate])

  const refreshRows = React.useCallback(() => {
    setReloadToken((token) => token + 1)
  }, [])

  const handleDelete = React.useCallback(async (row: CostInputRow) => {
    const confirmed = await confirm({
      title: translate('connect_analytics.costInputs.list.confirmDelete'),
      variant: 'destructive',
    })
    if (!confirmed) return
    try {
      await runMutation({
        operation: async () => {
          const call = await withScopedApiRequestHeaders(
            buildOptimisticLockHeader(row.updatedAt ?? ''),
            () => apiCall(
              `/api/connect_analytics/cost-inputs?id=${encodeURIComponent(row.id)}`,
              { method: 'DELETE' },
            ),
          )
          if (!call.ok) {
            throw Object.assign(new Error('[internal] connect_analytics cost input delete failed'), {
              status: call.status,
              ...((call.result as Record<string, unknown> | null) ?? {}),
            })
          }
          return call
        },
        context: {
          formId: mutationContextId,
          resourceKind: 'connect_analytics.cost_input',
          resourceId: row.id,
          retryLastMutation,
        },
        mutationPayload: { id: row.id },
      })
      flash(translate('connect_analytics.costInputs.list.deleteSuccess'), 'success')
      refreshRows()
    } catch (error) {
      if (surfaceRecordConflict(error, translate, { onRefresh: refreshRows })) return
      flash(translate('connect_analytics.costInputs.list.deleteError'), 'error')
    }
  }, [confirm, mutationContextId, refreshRows, retryLastMutation, runMutation, translate])

  const emptyLabel = translate('connect_analytics.common.empty')

  const columns = React.useMemo<ColumnDef<CostInputRow>[]>(() => [
    {
      accessorKey: 'periodStart',
      header: translate('connect_analytics.costInputs.list.columns.periodStart'),
      cell: ({ row }) => (
        <Link
          href={`/backend/connect/analytics/cost-inputs/${row.original.id}`}
          className="font-medium hover:underline"
        >
          {formatUtcDay(row.original.periodStart, emptyLabel)}
        </Link>
      ),
    },
    {
      accessorKey: 'periodEnd',
      header: translate('connect_analytics.costInputs.list.columns.periodEnd'),
      cell: ({ row }) => formatUtcDay(row.original.periodEnd, emptyLabel),
    },
    {
      accessorKey: 'costType',
      header: translate('connect_analytics.costInputs.list.columns.costType'),
      cell: ({ row }) => (
        <StatusBadge variant="neutral">
          {translate(`connect_analytics.costInputs.type.${row.original.costType ?? 'ai'}`)}
        </StatusBadge>
      ),
    },
    {
      accessorKey: 'amountMinor',
      header: translate('connect_analytics.costInputs.list.columns.amount'),
      cell: ({ row }) => formatCostAmount(row.original.amountMinor, row.original.currencyCode, locale, emptyLabel),
      meta: { align: 'right' },
    },
    {
      accessorKey: 'source',
      header: translate('connect_analytics.costInputs.list.columns.source'),
      enableSorting: false,
      cell: ({ row }) => translate(`connect_analytics.costInputs.source.${row.original.source ?? 'manual'}`),
    },
    {
      accessorKey: 'providerInvoiceRef',
      header: translate('connect_analytics.costInputs.list.columns.providerInvoiceRef'),
      enableSorting: false,
      cell: ({ row }) => row.original.providerInvoiceRef ?? emptyLabel,
      meta: { maxWidth: '220px', truncate: true },
    },
    {
      accessorKey: 'updatedAt',
      header: translate('connect_analytics.costInputs.list.columns.updatedAt'),
      cell: ({ row }) => (
        row.original.updatedAt
          ? new Date(row.original.updatedAt).toLocaleString(locale || undefined)
          : emptyLabel
      ),
    },
  ], [emptyLabel, locale, translate])

  const filterDefs = React.useMemo<FilterDef[]>(() => [
    {
      id: 'costType',
      label: translate('connect_analytics.costInputs.list.filters.costType'),
      type: 'select',
      options: [
        { value: 'agent', label: translate('connect_analytics.costInputs.type.agent') },
        { value: 'channel', label: translate('connect_analytics.costInputs.type.channel') },
        { value: 'ai', label: translate('connect_analytics.costInputs.type.ai') },
      ],
    },
    {
      id: 'source',
      label: translate('connect_analytics.costInputs.list.filters.source'),
      type: 'select',
      options: [
        { value: 'manual', label: translate('connect_analytics.costInputs.source.manual') },
        { value: 'provider_invoice', label: translate('connect_analytics.costInputs.source.provider_invoice') },
      ],
    },
  ], [translate])

  return (
    <Page>
      <PageBody>
        <DataTable<CostInputRow>
          title={translate('connect_analytics.costInputs.list.title')}
          columns={columns}
          data={rows}
          filters={filterDefs}
          filterValues={filters}
          onFiltersApply={(nextFilters) => {
            setFilters(nextFilters)
            setPage(1)
          }}
          onFiltersClear={() => {
            setFilters({})
            setPage(1)
          }}
          actions={canManage ? (
            <Button asChild>
              <Link href="/backend/connect/analytics/cost-inputs/create">
                <Plus className="mr-2 size-4" aria-hidden="true" />
                {translate('connect_analytics.costInputs.list.actions.create')}
              </Link>
            </Button>
          ) : undefined}
          rowActions={canManage ? (row) => (
            <RowActions
              items={[
                {
                  id: 'edit',
                  label: translate('connect_analytics.costInputs.list.actions.edit'),
                  href: `/backend/connect/analytics/cost-inputs/${row.id}`,
                },
                {
                  id: 'delete',
                  label: translate('connect_analytics.costInputs.list.actions.delete'),
                  destructive: true,
                  onSelect: () => {
                    void handleDelete(row)
                  },
                },
              ]}
            />
          ) : undefined}
          onRowClick={(row) => router.push(`/backend/connect/analytics/cost-inputs/${row.id}`)}
          rowClickActionIds={['edit']}
          emptyState={(
            <ListEmptyState
              entityName={translate('connect_analytics.costInputs.list.entityName')}
              createHref={canManage ? '/backend/connect/analytics/cost-inputs/create' : undefined}
              createLabel={translate('connect_analytics.costInputs.list.actions.create')}
            />
          )}
          sortable
          manualSorting
          sorting={sorting}
          onSortingChange={(nextSorting) => {
            setSorting(nextSorting)
            setPage(1)
          }}
          pagination={{
            page,
            pageSize,
            total,
            totalPages,
            totalIsCapped,
            onPageChange: setPage,
            pageSizeOptions: [20, 50, 100],
            onPageSizeChange: (nextPageSize) => {
              setPageSize(nextPageSize)
              setPage(1)
            },
          }}
          isLoading={loading}
          perspective={{ tableId: 'connect_analytics.cost_inputs.list' }}
          stickyActionsColumn
        />
      </PageBody>
      {ConfirmDialogElement}
    </Page>
  )
}

"use client"

import * as React from 'react'
import Link from 'next/link'
import type { SortingState } from '@tanstack/react-table'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { RowActions, type RowActionItem } from '@open-mercato/ui/backend/RowActions'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterOverlay'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { readApiResultOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { deleteCrud } from '@open-mercato/ui/backend/utils/crud'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { Button } from '@open-mercato/ui/primitives/button'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { hasFeature } from '@open-mercato/shared/security/features'
import { OFFER_STATUSES, OfferStatusBadge, useOfferStatusLabel } from '../../components/OfferStatusBadge'
import { useCopyPublicLink } from '../../components/CopyPublicLinkButton'
import type { OfferDto, OfferStatus, PagedResponse } from '../../components/types'

const DEFAULT_PAGE_SIZE = 25
const DELETE_MUTATION_CONTEXT_ID = 'offer_generator-offers-list:delete'

type DeleteMutationContext = {
  formId: string
  resourceKind: string
  resourceId: string
  retryLastMutation: () => Promise<boolean>
}

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : ''
}

function formatDate(value: string | null): string {
  return value ? new Date(`${value}T00:00:00`).toLocaleDateString() : ''
}

function formatAmount(amount: string | null, currencyCode: string | null): string {
  if (amount === null) return ''
  const numeric = Number(amount)
  if (!Number.isFinite(numeric)) return amount
  if (!currencyCode) return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2 }).format(numeric)
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(numeric)
  } catch {
    return `${numeric.toFixed(2)} ${currencyCode}`
  }
}

function isOfferStatus(value: unknown): value is OfferStatus {
  return typeof value === 'string' && (OFFER_STATUSES as string[]).includes(value)
}

export default function OfferGeneratorOffersPage() {
  const t = useT()
  const scopeVersion = useOrganizationScopeVersion()
  const { payload } = useBackendChrome()
  const canManage = hasFeature(payload?.grantedFeatures ?? [], 'offer_generator.manage')
  const statusLabel = useOfferStatusLabel()
  const copyPublicLink = useCopyPublicLink()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [rows, setRows] = React.useState<OfferDto[]>([])
  const [page, setPage] = React.useState(1)
  const [pageSize, setPageSize] = React.useState(DEFAULT_PAGE_SIZE)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [search, setSearch] = React.useState('')
  const [sorting, setSorting] = React.useState<SortingState>([{ id: 'updatedAt', desc: true }])
  const [filterValues, setFilterValues] = React.useState<FilterValues>({})
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshKey, setRefreshKey] = React.useState(0)
  const [pendingDeleteId, setPendingDeleteId] = React.useState<string | null>(null)

  const { runMutation, retryLastMutation } = useGuardedMutation<DeleteMutationContext>({
    contextId: DELETE_MUTATION_CONTEXT_ID,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  const refresh = React.useCallback(() => setRefreshKey((key) => key + 1), [])

  const queryString = React.useMemo(() => {
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('pageSize', String(Math.min(pageSize, 100)))
    const term = search.trim()
    if (term) params.set('search', term)
    if (isOfferStatus(filterValues.status)) params.set('status', filterValues.status)
    const sort = sorting[0]
    if (sort) {
      params.set('sortField', sort.id)
      params.set('sortDir', sort.desc ? 'desc' : 'asc')
    }
    return params.toString()
  }, [filterValues.status, page, pageSize, search, sorting])

  React.useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    readApiResultOrThrow<PagedResponse<OfferDto>>(`/api/offer_generator/offers?${queryString}`)
      .then((result) => {
        if (cancelled) return
        setRows(result.items ?? [])
        setTotal(result.total ?? 0)
        setTotalPages(result.totalPages ?? 1)
        setError(null)
      })
      .catch(() => {
        if (cancelled) return
        setError(t('offer_generator.list.loadError', 'Failed to load offers.'))
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [queryString, refreshKey, scopeVersion, t])

  const handleDelete = React.useCallback(
    async (offer: OfferDto) => {
      if (pendingDeleteId) return
      const confirmed = await confirm({
        title: t('offer_generator.list.deleteConfirm', 'Delete this offer? Its public link will stop working.'),
        variant: 'destructive',
      })
      if (!confirmed) return
      setPendingDeleteId(offer.id)
      try {
        await runMutation({
          operation: async () => {
            await withScopedApiRequestHeaders(
              buildOptimisticLockHeader(offer.updatedAt),
              () => deleteCrud('offer_generator/offers', {
                body: { id: offer.id },
                errorMessage: t('offer_generator.list.deleteError', 'Failed to delete the offer.'),
              }),
            )
          },
          context: {
            formId: DELETE_MUTATION_CONTEXT_ID,
            resourceKind: 'offer_generator.offer',
            resourceId: offer.id,
            retryLastMutation,
          },
        })
        flash(t('offer_generator.list.deleteSuccess', 'Offer deleted.'), 'success')
        refresh()
      } catch (err) {
        if (surfaceRecordConflict(err, t)) {
          refresh()
          return
        }
        const message =
          err instanceof Error && err.message
            ? err.message
            : t('offer_generator.list.deleteError', 'Failed to delete the offer.')
        flash(message, 'error')
      } finally {
        setPendingDeleteId(null)
      }
    },
    [confirm, pendingDeleteId, refresh, retryLastMutation, runMutation, t],
  )

  const columns = React.useMemo<ColumnDef<OfferDto>[]>(() => [
    {
      id: 'title',
      header: t('offer_generator.list.columns.title', 'Title'),
      accessorKey: 'title',
      meta: { truncate: true, maxWidth: '280px' },
    },
    {
      id: 'clientName',
      header: t('offer_generator.list.columns.client', 'Client'),
      accessorKey: 'clientName',
      meta: { truncate: true, maxWidth: '220px' },
    },
    {
      id: 'status',
      header: t('offer_generator.list.columns.status', 'Status'),
      accessorFn: (row) => row.status,
      cell: ({ row }) => <OfferStatusBadge status={row.original.status} />,
    },
    {
      id: 'valueAmount',
      header: t('offer_generator.list.columns.value', 'Value'),
      accessorFn: (row) => formatAmount(row.valueAmount, row.currencyCode),
    },
    {
      id: 'validUntil',
      header: t('offer_generator.list.columns.validUntil', 'Valid until'),
      accessorFn: (row) => formatDate(row.validUntil),
    },
    {
      id: 'viewCount',
      header: t('offer_generator.list.columns.views', 'Views'),
      accessorFn: (row) => row.viewCount,
    },
    {
      id: 'lastViewedAt',
      header: t('offer_generator.list.columns.lastViewed', 'Last viewed'),
      accessorFn: (row) => formatDateTime(row.lastViewedAt),
    },
    {
      id: 'updatedAt',
      header: t('offer_generator.list.columns.updated', 'Updated'),
      accessorFn: (row) => formatDateTime(row.updatedAt),
    },
  ], [t])

  const filters = React.useMemo<FilterDef[]>(() => [
    {
      id: 'status',
      label: t('offer_generator.list.filters.status', 'Status'),
      type: 'select',
      options: OFFER_STATUSES.map((status) => ({ value: status, label: statusLabel(status) })),
    },
  ], [statusLabel, t])

  const renderRowActions = React.useCallback(
    (row: OfferDto) => {
      const items: RowActionItem[] = [
        {
          id: 'open',
          label: t('offer_generator.list.actions.open', 'Open'),
          href: `/backend/offer-generator/${encodeURIComponent(row.id)}`,
        },
        {
          id: 'copy-link',
          label: t('offer_generator.publicLink.copy', 'Copy public link'),
          onSelect: () => {
            void copyPublicLink(row.publicUrl)
          },
        },
      ]
      if (canManage) {
        items.push({
          id: 'delete',
          label: t('offer_generator.list.actions.delete', 'Delete'),
          destructive: true,
          onSelect: () => {
            void handleDelete(row)
          },
        })
      }
      return <RowActions items={items} />
    },
    [canManage, copyPublicLink, handleDelete, t],
  )

  return (
    <Page>
      <PageBody>
        <DataTable<OfferDto>
          title={t('offer_generator.list.title', 'Offers')}
          titleHeadingLevel={1}
          actions={canManage ? (
            <Button asChild>
              <Link href="/backend/offer-generator/create">
                {t('offer_generator.list.actions.new', 'New offer')}
              </Link>
            </Button>
          ) : undefined}
          refreshButton={{
            label: t('offer_generator.list.actions.refresh', 'Refresh'),
            onRefresh: refresh,
          }}
          columns={columns}
          data={rows}
          isLoading={isLoading}
          error={error}
          sortable
          manualSorting
          sorting={sorting}
          onSortingChange={(next) => {
            setSorting(next)
            setPage(1)
          }}
          searchValue={search}
          onSearchChange={(value) => {
            setSearch(value)
            setPage(1)
          }}
          searchPlaceholder={t('offer_generator.list.searchPlaceholder', 'Search by title or client')}
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
          rowActions={renderRowActions}
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
        {ConfirmDialogElement}
      </PageBody>
    </Page>
  )
}

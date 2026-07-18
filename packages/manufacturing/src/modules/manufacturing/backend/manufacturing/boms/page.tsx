'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { ListEmptyState } from '@open-mercato/ui/backend/filters/ListEmptyState'
import type { ColumnDef } from '@tanstack/react-table'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { Button } from '@open-mercato/ui/primitives/button'
import { Plus } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import type { FilterDef, FilterValues } from '@open-mercato/ui/backend/FilterBar'
import { TechnologyStatusBadge, type TechnologyStatus } from '../components/TechnologyStatusBadge'

type BomRow = {
  id: string
  productId: string
  variantId: string | null
  version: number
  status: TechnologyStatus
  validFrom: string | null
  validTo: string | null
  name: string
  updatedAt: string
}

type ResponsePayload = {
  items: BomRow[]
  total: number
  page: number
  totalPages: number
}

export default function BomsPage() {
  const t = useT()
  const router = useRouter()
  const { confirm: confirmDialog, ConfirmDialogElement } = useConfirmDialog()
  const [rows, setRows] = React.useState<BomRow[]>([])
  const [page, setPage] = React.useState(1)
  const [total, setTotal] = React.useState(0)
  const [totalPages, setTotalPages] = React.useState(1)
  const [search, setSearch] = React.useState('')
  const [filters, setFilters] = React.useState<FilterValues>({})
  const [isLoading, setIsLoading] = React.useState(true)
  const [reloadToken, setReloadToken] = React.useState(0)
  const scopeVersion = useOrganizationScopeVersion()
  const mutationContextId = 'manufacturing-boms-list:mutation'
  const { runMutation, retryLastMutation } = useGuardedMutation<{
    formId: string
    resourceKind: string
    resourceId: string
    retryLastMutation: () => Promise<boolean>
  }>({
    contextId: mutationContextId,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: '20' })
        if (search) params.set('search', search)
        if (filters.status) params.set('status', String(filters.status))

        const fallback: ResponsePayload = { items: [], total: 0, page, totalPages: 1 }
        const call = await apiCall<ResponsePayload>(`/api/manufacturing/boms?${params.toString()}`, undefined, { fallback })
        if (!call.ok) {
          if (!cancelled) flash(t('manufacturing.boms.error.fetch_failed', 'Failed to load BOMs'), 'error')
          return
        }
        const payload = call.result ?? fallback
        if (!cancelled) {
          setRows(Array.isArray(payload.items) ? payload.items : [])
          setTotal(payload.total || 0)
          setTotalPages(payload.totalPages || 1)
        }
      } catch {
        if (!cancelled) flash(t('manufacturing.boms.error.fetch_failed', 'Failed to load BOMs'), 'error')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [page, search, filters, reloadToken, scopeVersion, t])

  const handleActivate = React.useCallback(
    async (row: BomRow) => {
      const confirmed = await confirmDialog({
        title: t('manufacturing.boms.confirm.activate', 'Activate this BOM version? Any other active version for the same product/variant will be archived.'),
      })
      if (!confirmed) return

      try {
        await runMutation({
          operation: async () => {
            const call = await withScopedApiRequestHeaders(
              buildOptimisticLockHeader(row.updatedAt),
              () => apiCall(`/api/manufacturing/boms/${row.id}/activate`, { method: 'POST' }),
            )
            if (!call.ok) {
              throw Object.assign(new Error('[internal] manufacturing.boms.activate failed'), {
                status: call.status,
                ...((call.result as Record<string, unknown> | null) ?? {}),
              })
            }
            return call
          },
          context: { formId: mutationContextId, resourceKind: 'manufacturing.bom', resourceId: row.id, retryLastMutation },
          mutationPayload: { id: row.id },
        })
        flash(t('manufacturing.boms.success.activated', 'BOM version activated'), 'success')
        setReloadToken((tok) => tok + 1)
      } catch (error) {
        if (surfaceRecordConflict(error, t, { onRefresh: () => setReloadToken((tok) => tok + 1) })) return
        flash(t('manufacturing.boms.error.activate_failed', 'Failed to activate BOM version'), 'error')
      }
    },
    [t, confirmDialog, mutationContextId, retryLastMutation, runMutation],
  )

  const handleCopyVersion = React.useCallback(
    async (row: BomRow) => {
      try {
        const call = await apiCall<{ id?: string }>(`/api/manufacturing/boms/${row.id}/copy-version`, { method: 'POST' })
        if (!call.ok) throw new Error('[internal] manufacturing.boms.copyVersion failed')
        flash(t('manufacturing.boms.success.copied', 'BOM version copied as a new draft'), 'success')
        setReloadToken((tok) => tok + 1)
      } catch {
        flash(t('manufacturing.boms.error.copy_failed', 'Failed to copy BOM version'), 'error')
      }
    },
    [t],
  )

  const handleDelete = React.useCallback(
    async (row: BomRow) => {
      const confirmed = await confirmDialog({
        title: t('manufacturing.boms.confirm.delete', 'Are you sure you want to delete this BOM version?'),
        variant: 'destructive',
      })
      if (!confirmed) return

      try {
        await runMutation({
          operation: async () => {
            const call = await withScopedApiRequestHeaders(
              buildOptimisticLockHeader(row.updatedAt),
              () => apiCall('/api/manufacturing/boms', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: row.id }),
              }),
            )
            if (!call.ok) {
              throw Object.assign(new Error('[internal] manufacturing.boms.delete failed'), {
                status: call.status,
                ...((call.result as Record<string, unknown> | null) ?? {}),
              })
            }
            return call
          },
          context: { formId: mutationContextId, resourceKind: 'manufacturing.bom', resourceId: row.id, retryLastMutation },
          mutationPayload: { id: row.id },
        })
        flash(t('manufacturing.boms.success.deleted', 'BOM deleted successfully'), 'success')
        setReloadToken((tok) => tok + 1)
      } catch (error) {
        if (surfaceRecordConflict(error, t, { onRefresh: () => setReloadToken((tok) => tok + 1) })) return
        flash(t('manufacturing.boms.error.delete_failed', 'Failed to delete BOM'), 'error')
      }
    },
    [t, confirmDialog, mutationContextId, retryLastMutation, runMutation],
  )

  const columns = React.useMemo<ColumnDef<BomRow>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: t('manufacturing.boms.field.name', 'Name'),
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      { id: 'productId', accessorKey: 'productId', header: t('manufacturing.boms.field.product_id', 'Product ID') },
      { id: 'version', accessorKey: 'version', header: t('manufacturing.boms.field.version', 'Version') },
      {
        id: 'status',
        accessorKey: 'status',
        header: t('manufacturing.boms.field.status', 'Status'),
        enableSorting: false,
        cell: ({ row }) => <TechnologyStatusBadge status={row.original.status} t={t} />,
      },
      {
        id: 'validFrom',
        accessorKey: 'validFrom',
        header: t('manufacturing.boms.field.valid_from', 'Valid from'),
        cell: ({ row }) => (row.original.validFrom ? new Date(row.original.validFrom).toLocaleDateString() : '—'),
      },
      {
        id: 'validTo',
        accessorKey: 'validTo',
        header: t('manufacturing.boms.field.valid_to', 'Valid to'),
        cell: ({ row }) => (row.original.validTo ? new Date(row.original.validTo).toLocaleDateString() : '—'),
      },
    ],
    [t],
  )

  const filterDefs = React.useMemo<FilterDef[]>(
    () => [
      {
        id: 'status',
        label: t('manufacturing.boms.filters.status', 'Status'),
        type: 'select',
        options: [
          { label: t('manufacturing.boms.filters.all', 'All'), value: '' },
          { label: t('manufacturing.status.draft', 'Draft'), value: 'draft' },
          { label: t('manufacturing.status.active', 'Active'), value: 'active' },
          { label: t('manufacturing.status.archived', 'Archived'), value: 'archived' },
        ],
      },
    ],
    [t],
  )

  return (
    <Page>
      <PageBody>
        <DataTable<BomRow>
          title={t('manufacturing.boms.title', 'Bills of Materials')}
          columns={columns}
          data={rows}
          searchValue={search}
          onSearchChange={(value) => {
            setSearch(value)
            setPage(1)
          }}
          searchPlaceholder={t('manufacturing.boms.search.placeholder', 'Search BOMs...')}
          filters={filterDefs}
          filterValues={filters}
          onFiltersApply={(values) => {
            setFilters(values)
            setPage(1)
          }}
          onFiltersClear={() => {
            setFilters({})
            setPage(1)
          }}
          actions={
            <Button onClick={() => router.push('/backend/manufacturing/boms/create')}>
              <Plus className="mr-2 h-4 w-4" />
              {t('manufacturing.boms.action.create', 'New BOM')}
            </Button>
          }
          onRowClick={(row) => router.push(`/backend/manufacturing/boms/${row.id}`)}
          rowActions={(row) => (
            <RowActions
              items={[
                { id: 'edit', label: t('manufacturing.boms.action.edit', 'Edit'), href: `/backend/manufacturing/boms/${row.id}` },
                ...(row.status !== 'active'
                  ? [{ id: 'activate', label: t('manufacturing.boms.action.activate', 'Activate'), onSelect: () => handleActivate(row) }]
                  : []),
                { id: 'copy-version', label: t('manufacturing.boms.action.copy_version', 'Copy version'), onSelect: () => handleCopyVersion(row) },
                { id: 'delete', label: t('manufacturing.boms.action.delete', 'Delete'), destructive: true, onSelect: () => handleDelete(row) },
              ]}
            />
          )}
          emptyState={(
            <ListEmptyState
              entityName={t('manufacturing.boms.title', 'Bills of Materials')}
              createHref="/backend/manufacturing/boms/create"
              createLabel={t('manufacturing.boms.action.create', 'New BOM')}
            />
          )}
          pagination={{ page, pageSize: 20, total, totalPages, onPageChange: setPage }}
          isLoading={isLoading}
        />
        {ConfirmDialogElement}
      </PageBody>
    </Page>
  )
}

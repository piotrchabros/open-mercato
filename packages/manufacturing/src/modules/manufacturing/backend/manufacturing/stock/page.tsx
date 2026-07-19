'use client'

import * as React from 'react'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { ListEmptyState } from '@open-mercato/ui/backend/filters/ListEmptyState'
import type { ColumnDef } from '@tanstack/react-table'
import { RowActions } from '@open-mercato/ui/backend/RowActions'
import { Button } from '@open-mercato/ui/primitives/button'
import { Plus, Upload } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { createCrud } from '@open-mercato/ui/backend/utils/crud'
import { CrudForm, type CrudField } from '@open-mercato/ui/backend/CrudForm'
import { LookupSelect, type LookupSelectItem } from '@open-mercato/ui/backend/inputs/LookupSelect'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@open-mercato/ui/primitives/dialog'

type StockRow = {
  id: string
  productId: string
  variantId: string | null
  uom: string
  onHand: number
  reserved: number
  available: number
  batchCount: number
  updatedAt: string
}

type StockListResponse = { items: StockRow[]; total: number; page: number; pageSize: number }

type BatchRow = { id: string; batchNumber: string; onHand: number; expiresAt: string | null }
type MovementRow = {
  id: string
  movementType: 'receipt' | 'issue' | 'adjustment'
  qty: number
  uom: string
  sourceType: string
  reversesMovementId: string | null
  createdAt: string
}

type ProductLookupItem = LookupSelectItem & { defaultUnit: string | null }

type ReceiveFormValues = {
  productId: string
  variantId: string
  qty: number
  uom: string
  batchNumber: string
  expiresAt: string
}

type AdjustFormValues = {
  productId: string
  variantId: string
  qty: number
  uom: string
  batchNumber: string
  reason: string
}

/**
 * Stock intake backend UI (task 2.2). Kept as a single page — DataTable of
 * on-hand items, Receive/Adjust dialogs (`CrudForm embedded` inside a
 * `Dialog`, matching `AddStageDialog`'s pattern), a per-row details dialog
 * (batches + movement history + storno), and a CSV import dialog.
 */
export default function StockPage() {
  const t = useT()
  const { confirm: confirmDialog, ConfirmDialogElement } = useConfirmDialog()
  const scopeVersion = useOrganizationScopeVersion()

  const [rows, setRows] = React.useState<StockRow[]>([])
  const [page, setPage] = React.useState(1)
  const [total, setTotal] = React.useState(0)
  const [isLoading, setIsLoading] = React.useState(true)
  const [reloadToken, setReloadToken] = React.useState(0)

  const [receiveOpen, setReceiveOpen] = React.useState(false)
  const [receiveProduct, setReceiveProduct] = React.useState<ProductLookupItem | null>(null)
  const [receiveVariant, setReceiveVariant] = React.useState<LookupSelectItem | null>(null)
  const productLookupRef = React.useRef(new Map<string, ProductLookupItem>())
  const variantLookupRef = React.useRef(new Map<string, LookupSelectItem>())
  const [adjustTarget, setAdjustTarget] = React.useState<StockRow | null>(null)
  const [detailsTarget, setDetailsTarget] = React.useState<StockRow | null>(null)
  const [importOpen, setImportOpen] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setIsLoading(true)
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: '20' })
        const fallback: StockListResponse = { items: [], total: 0, page, pageSize: 20 }
        const call = await apiCall<StockListResponse>(`/api/manufacturing/stock?${params.toString()}`, undefined, { fallback })
        if (!call.ok) {
          if (!cancelled) flash(t('manufacturing.stock.error.fetch_failed', 'Failed to load stock items'), 'error')
          return
        }
        const payload = call.result ?? fallback
        if (!cancelled) {
          setRows(Array.isArray(payload.items) ? payload.items : [])
          setTotal(payload.total || 0)
        }
      } catch {
        if (!cancelled) flash(t('manufacturing.stock.error.fetch_failed', 'Failed to load stock items'), 'error')
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [page, reloadToken, scopeVersion, t])

  const columns = React.useMemo<ColumnDef<StockRow>[]>(
    () => [
      { id: 'productId', accessorKey: 'productId', header: t('manufacturing.stock.field.product_id', 'Product') },
      { id: 'uom', accessorKey: 'uom', header: t('manufacturing.stock.field.uom', 'UoM') },
      { id: 'onHand', accessorKey: 'onHand', header: t('manufacturing.stock.field.on_hand', 'On hand') },
      { id: 'reserved', accessorKey: 'reserved', header: t('manufacturing.stock.field.reserved', 'Reserved') },
      { id: 'available', accessorKey: 'available', header: t('manufacturing.stock.field.available', 'Available') },
      { id: 'batchCount', accessorKey: 'batchCount', header: t('manufacturing.stock.field.batch_count', 'Batches') },
    ],
    [t],
  )

  const loadProductItems = React.useCallback(async (query: string): Promise<LookupSelectItem[]> => {
    const params = new URLSearchParams({ pageSize: '20' })
    if (query.trim().length) params.set('search', query.trim())
    else params.set('sortField', 'title')
    const call = await apiCall<{ items?: Array<Record<string, unknown>> }>(
      `/api/catalog/products?${params.toString()}`,
      undefined,
      { fallback: { items: [] } },
    )
    const items = Array.isArray(call.result?.items) ? call.result.items : []
    return items.flatMap((item) => {
      const id = typeof item.id === 'string' ? item.id : null
      if (!id) return []
      const title = typeof item.title === 'string' && item.title.length
        ? item.title
        : typeof item.name === 'string' && item.name.length
          ? item.name
          : id
      const sku = typeof item.sku === 'string' && item.sku.length ? item.sku : null
      const defaultUnit = typeof item.default_unit === 'string' && item.default_unit.length ? item.default_unit : null
      const mapped: ProductLookupItem = { id, title, subtitle: sku ?? undefined, defaultUnit }
      productLookupRef.current.set(id, mapped)
      return [mapped]
    })
  }, [])

  const loadVariantItems = React.useCallback(async (productId: string, query: string): Promise<LookupSelectItem[]> => {
    if (!productId) return []
    const call = await apiCall<{ items?: Array<Record<string, unknown>> }>(
      `/api/catalog/variants?productId=${encodeURIComponent(productId)}&pageSize=50`,
      undefined,
      { fallback: { items: [] } },
    )
    const items = Array.isArray(call.result?.items) ? call.result.items : []
    const mapped = items.flatMap((item) => {
      const id = typeof item.id === 'string' ? item.id : null
      if (!id) return []
      const title = typeof item.name === 'string' && item.name.length ? item.name : id
      const sku = typeof item.sku === 'string' && item.sku.length ? item.sku : null
      const entry: LookupSelectItem = { id, title, subtitle: sku ?? undefined }
      variantLookupRef.current.set(id, entry)
      return [entry]
    })
    const needle = query.trim().toLowerCase()
    if (!needle.length) return mapped
    return mapped.filter(
      (entry) => entry.title.toLowerCase().includes(needle) || (entry.subtitle ?? '').toLowerCase().includes(needle),
    )
  }, [])

  const receiveFields = React.useMemo<CrudField[]>(
    () => [
      {
        id: 'productId',
        label: t('manufacturing.stock.receive.field.product', 'Product'),
        type: 'custom',
        required: true,
        component: ({ value, setValue, setFormValue }) => (
          <LookupSelect
            value={typeof value === 'string' && value.length ? value : null}
            onChange={(next) => {
              const picked = next ? (productLookupRef.current.get(next) ?? null) : null
              setReceiveProduct(picked)
              setReceiveVariant(null)
              setValue(next ?? '')
              setFormValue?.('variantId', '')
              if (picked?.defaultUnit) setFormValue?.('uom', picked.defaultUnit)
            }}
            fetchItems={loadProductItems}
            options={receiveProduct ? [receiveProduct] : undefined}
            minQuery={0}
          />
        ),
      },
      {
        id: 'variantId',
        label: t('manufacturing.stock.receive.field.variant', 'Variant'),
        type: 'custom',
        component: ({ value, setValue, values }) => {
          const productId = typeof values?.productId === 'string' ? values.productId : ''
          return (
            <LookupSelect
              value={typeof value === 'string' && value.length ? value : null}
              onChange={(next) => {
                setReceiveVariant(next ? (variantLookupRef.current.get(next) ?? null) : null)
                setValue(next ?? '')
              }}
              fetchItems={(query) => loadVariantItems(productId, query)}
              options={receiveVariant ? [receiveVariant] : undefined}
              minQuery={0}
              disabled={!productId.length}
            />
          )
        },
      },
      { id: 'qty', label: t('manufacturing.stock.receive.field.qty', 'Quantity'), type: 'number', required: true },
      { id: 'uom', label: t('manufacturing.stock.receive.field.uom', 'UoM'), type: 'text', required: true },
      { id: 'batchNumber', label: t('manufacturing.stock.receive.field.batch_number', 'Batch number'), type: 'text' },
      { id: 'expiresAt', label: t('manufacturing.stock.receive.field.expires_at', 'Expires at'), type: 'date' },
    ],
    [t, receiveProduct, receiveVariant, loadProductItems, loadVariantItems],
  )

  const handleReceiveSubmit = React.useCallback(
    async (values: ReceiveFormValues) => {
      await createCrud('manufacturing/stock/receipts', {
        productId: values.productId,
        variantId: values.variantId || null,
        qty: Number(values.qty),
        uom: values.uom,
        batchNumber: values.batchNumber || null,
        expiresAt: values.expiresAt || null,
      }, { errorMessage: t('manufacturing.stock.error.receive_failed', 'Failed to receive stock') })
      flash(t('manufacturing.stock.success.received', 'Stock received'), 'success')
      setReceiveOpen(false)
      setReloadToken((tok) => tok + 1)
    },
    [t],
  )

  const adjustFields = React.useMemo<CrudField[]>(
    () => [
      { id: 'qty', label: t('manufacturing.stock.adjust.field.qty', 'Signed quantity (+/-)'), type: 'number', required: true },
      { id: 'batchNumber', label: t('manufacturing.stock.adjust.field.batch_number', 'Batch number'), type: 'text' },
      { id: 'reason', label: t('manufacturing.stock.adjust.field.reason', 'Reason'), type: 'textarea', required: true },
    ],
    [t],
  )

  const handleAdjustSubmit = React.useCallback(
    async (values: AdjustFormValues) => {
      if (!adjustTarget) return
      await createCrud('manufacturing/stock/adjustments', {
        productId: adjustTarget.productId,
        variantId: adjustTarget.variantId,
        qty: Number(values.qty),
        uom: adjustTarget.uom,
        batchNumber: values.batchNumber || null,
        reason: values.reason,
      }, { errorMessage: t('manufacturing.stock.error.adjust_failed', 'Failed to adjust stock') })
      flash(t('manufacturing.stock.success.adjusted', 'Stock adjusted'), 'success')
      setAdjustTarget(null)
      setReloadToken((tok) => tok + 1)
    },
    [adjustTarget, t],
  )

  return (
    <Page>
      <PageBody>
        <DataTable<StockRow>
          title={t('manufacturing.stock.title', 'Stock')}
          columns={columns}
          data={rows}
          actions={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Upload className="mr-2 h-4 w-4" />
                {t('manufacturing.stock.action.import', 'Import CSV')}
              </Button>
              <Button onClick={() => setReceiveOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                {t('manufacturing.stock.action.receive', 'Receive stock')}
              </Button>
            </div>
          }
          onRowClick={(row) => setDetailsTarget(row)}
          rowActions={(row) => (
            <RowActions
              items={[
                { id: 'details', label: t('manufacturing.stock.action.details', 'View details'), onSelect: () => setDetailsTarget(row) },
                { id: 'adjust', label: t('manufacturing.stock.action.adjust', 'Adjust'), onSelect: () => setAdjustTarget(row) },
              ]}
            />
          )}
          emptyState={<ListEmptyState entityName={t('manufacturing.stock.title', 'Stock')} />}
          pagination={{ page, pageSize: 20, total, totalPages: Math.max(1, Math.ceil(total / 20)), onPageChange: setPage }}
          isLoading={isLoading}
        />
        {ConfirmDialogElement}

        <Dialog
          open={receiveOpen}
          onOpenChange={(next) => {
            if (next) return
            setReceiveOpen(false)
            setReceiveProduct(null)
            setReceiveVariant(null)
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('manufacturing.stock.receive.title', 'Receive stock')}</DialogTitle>
              <DialogDescription>
                {t('manufacturing.stock.receive.description', 'Record a manual goods-received movement.')}
              </DialogDescription>
            </DialogHeader>
            <CrudForm<ReceiveFormValues>
              embedded
              fields={receiveFields}
              initialValues={{ productId: '', variantId: '', qty: 0, uom: '', batchNumber: '', expiresAt: '' }}
              submitLabel={t('manufacturing.stock.receive.submit', 'Receive')}
              onSubmit={handleReceiveSubmit}
            />
          </DialogContent>
        </Dialog>

        <Dialog open={!!adjustTarget} onOpenChange={(next) => !next && setAdjustTarget(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('manufacturing.stock.adjust.title', 'Adjust stock')}</DialogTitle>
              <DialogDescription>
                {t('manufacturing.stock.adjust.description', 'Record an opening balance load or a correction. A reason is required.')}
              </DialogDescription>
            </DialogHeader>
            <CrudForm<AdjustFormValues>
              key={adjustTarget?.id ?? 'none'}
              embedded
              fields={adjustFields}
              initialValues={{ qty: 0, batchNumber: '', reason: '' }}
              submitLabel={t('manufacturing.stock.adjust.submit', 'Adjust')}
              onSubmit={handleAdjustSubmit}
            />
          </DialogContent>
        </Dialog>

        <StockImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={() => setReloadToken((tok) => tok + 1)} />

        <StockDetailsDialog
          row={detailsTarget}
          onClose={() => setDetailsTarget(null)}
          onReversed={() => {
            setReloadToken((tok) => tok + 1)
          }}
          confirmDialog={confirmDialog}
        />
      </PageBody>
    </Page>
  )
}

function StockImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean
  onClose: () => void
  onImported: () => void
}): React.ReactElement {
  const t = useT()
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const handleSubmit = React.useCallback(async () => {
    const file = fileInputRef.current?.files?.[0]
    if (!file) {
      flash(t('manufacturing.stock.import.error.no_file', 'Choose a CSV file first'), 'error')
      return
    }
    setIsSubmitting(true)
    try {
      const text = await file.text()
      const call = await apiCall<{
        imported: number
        failed: number
        capExceeded: boolean
        errors: Array<{ row: number; error: string }>
      }>('/api/manufacturing/stock/import', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: text })

      // The route always returns the real partial `{imported, failed}` counts
      // on `call.result`, even on a 413 (row cap exceeded) — batches that ran
      // before the cap tripped already created real receipts, so this is
      // never rendered as a bare failure (task 2.2 follow-up).
      if (!call.result) {
        flash(t('manufacturing.stock.import.error.failed', 'Failed to import stock CSV'), 'error')
        return
      }
      if (call.result.capExceeded) {
        flash(
          t(
            'manufacturing.stock.import.cap_exceeded',
            'Imported {imported} rows before hitting the row limit — do not re-upload the same file.',
            { imported: call.result.imported },
          ),
          'error',
        )
        onImported()
        return
      }
      if (!call.ok) {
        flash(t('manufacturing.stock.import.error.failed', 'Failed to import stock CSV'), 'error')
        return
      }
      flash(
        t('manufacturing.stock.import.success', '{imported} rows imported, {failed} failed', {
          imported: call.result.imported,
          failed: call.result.failed,
        }),
        call.result.failed > 0 ? 'error' : 'success',
      )
      onImported()
      onClose()
    } finally {
      setIsSubmitting(false)
    }
  }, [onClose, onImported, t])

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('manufacturing.stock.import.title', 'Import stock CSV')}</DialogTitle>
          <DialogDescription>
            {t(
              'manufacturing.stock.import.help',
              'Columns: product_id, variant_id, qty, uom, batch_number, expires_at.',
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <input ref={fileInputRef} type="file" accept=".csv,text/csv" />
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {t('manufacturing.stock.import.submit', 'Import')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StockDetailsDialog({
  row,
  onClose,
  onReversed,
  confirmDialog,
}: {
  row: StockRow | null
  onClose: () => void
  onReversed: () => void
  confirmDialog: (opts: { title: string; variant?: 'destructive' }) => Promise<boolean>
}): React.ReactElement | null {
  const t = useT()
  const [batches, setBatches] = React.useState<BatchRow[]>([])
  const [movements, setMovements] = React.useState<MovementRow[]>([])
  const [reloadToken, setReloadToken] = React.useState(0)

  React.useEffect(() => {
    if (!row) return
    let cancelled = false
    async function load() {
      const batchesCall = await apiCall<{ items: BatchRow[] }>(
        `/api/manufacturing/stock/batches?productId=${encodeURIComponent(row!.productId)}`,
        undefined,
        { fallback: { items: [] } },
      )
      const movementsCall = await apiCall<{ items: MovementRow[] }>(
        `/api/manufacturing/stock/movements?productId=${encodeURIComponent(row!.productId)}&pageSize=20`,
        undefined,
        { fallback: { items: [] } },
      )
      if (cancelled) return
      setBatches(batchesCall.result?.items ?? [])
      setMovements(movementsCall.result?.items ?? [])
    }
    load()
    return () => {
      cancelled = true
    }
  }, [row, reloadToken])

  const handleReverse = React.useCallback(
    async (movement: MovementRow) => {
      const confirmed = await confirmDialog({
        title: t('manufacturing.stock.movements.confirm.reverse', 'Reverse this stock movement?'),
        variant: 'destructive',
      })
      if (!confirmed) return
      const call = await apiCall(`/api/manufacturing/stock/movements/${movement.id}/reverse`, { method: 'POST' })
      if (!call.ok) {
        flash(t('manufacturing.stock.error.reverse_failed', 'Failed to reverse stock movement'), 'error')
        return
      }
      flash(t('manufacturing.stock.success.reversed', 'Movement reversed'), 'success')
      setReloadToken((tok) => tok + 1)
      onReversed()
    },
    [confirmDialog, onReversed, t],
  )

  if (!row) return null

  return (
    <Dialog open={!!row} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('manufacturing.stock.details.title', 'Stock details')}</DialogTitle>
          <DialogDescription>{row.productId}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div>
            <h4 className="mb-2 text-sm font-medium">{t('manufacturing.stock.batches.title', 'Batches')}</h4>
            {batches.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('manufacturing.stock.batches.empty', 'No batches')}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {batches.map((batch) => (
                  <li key={batch.id} className="flex justify-between">
                    <span>{batch.batchNumber}</span>
                    <span>{batch.onHand}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-sm font-medium">{t('manufacturing.stock.movements.title', 'Movements')}</h4>
            {movements.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('manufacturing.stock.movements.empty', 'No movements')}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {movements.map((movement) => (
                  <li key={movement.id} className="flex items-center justify-between gap-2">
                    <span>{t(`manufacturing.stock.movements.type.${movement.movementType}`, movement.movementType)}</span>
                    <span>{movement.qty}</span>
                    <span className="text-muted-foreground">{new Date(movement.createdAt).toLocaleString()}</span>
                    {!movement.reversesMovementId && (
                      <Button variant="ghost" size="sm" onClick={() => handleReverse(movement)}>
                        {t('manufacturing.stock.movements.action.reverse', 'Reverse')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

'use client'

import * as React from 'react'
import type { z } from 'zod'
import { useRouter } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm, type CrudField } from '@open-mercato/ui/backend/CrudForm'
import { updateCrud, deleteCrud } from '@open-mercato/ui/backend/utils/crud'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { LoadingMessage, ErrorMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { routingUpdateSchema } from '../../../../data/validators.js'
import { RoutingOperationsEditor, type RoutingOperationRow, type WorkCenterOption } from '../../components/RoutingOperationsEditor'

const routingEditSchema = routingUpdateSchema.omit({ id: true })
type RoutingEditValues = z.infer<typeof routingEditSchema>

type RoutingDetail = {
  id: string
  productId: string
  variantId: string | null
  version: number
  status: 'draft' | 'active' | 'archived'
  name: string
  updatedAt: string
  operations: RoutingOperationRow[]
}

export default function EditRoutingPage({ params }: { params?: { id?: string } }) {
  const t = useT()
  const router = useRouter()
  const [record, setRecord] = React.useState<RoutingDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [isNotFound, setIsNotFound] = React.useState(false)
  const [workCenterOptions, setWorkCenterOptions] = React.useState<WorkCenterOption[]>([])

  React.useEffect(() => {
    let cancelled = false
    async function loadWorkCenters() {
      const call = await apiCall<{ items: Array<{ id: string; name: string }> }>('/api/manufacturing/work-centers?pageSize=100')
      if (cancelled || !call.ok || !call.result) return
      setWorkCenterOptions(call.result.items.map((wc) => ({ value: wc.id, label: wc.name })))
    }
    loadWorkCenters()
    return () => {
      cancelled = true
    }
  }, [])

  const loadRecord = React.useCallback(async () => {
    if (!params?.id) return
    setLoading(true)
    try {
      const call = await apiCall<RoutingDetail>(`/api/manufacturing/routings/${params.id}`)
      if (call.ok && call.result) {
        setRecord(call.result)
      } else if (call.status === 404) {
        setIsNotFound(true)
      } else {
        setError(t('manufacturing.routings.error.load_failed', 'Failed to load routing'))
      }
    } catch {
      setError(t('manufacturing.routings.error.load_failed', 'Failed to load routing'))
    } finally {
      setLoading(false)
    }
  }, [params?.id, t])

  React.useEffect(() => {
    loadRecord()
  }, [loadRecord])

  const fields = React.useMemo<CrudField[]>(
    () => [
      { id: 'name', type: 'text', label: t('manufacturing.routings.field.name', 'Name'), required: true },
      {
        id: 'status',
        type: 'select',
        label: t('manufacturing.routings.field.status', 'Status'),
        layout: 'half',
        options: [
          { value: 'draft', label: t('manufacturing.status.draft', 'Draft') },
          { value: 'active', label: t('manufacturing.status.active', 'Active') },
          { value: 'archived', label: t('manufacturing.status.archived', 'Archived') },
        ],
      },
      {
        id: 'operations',
        type: 'custom',
        label: t('manufacturing.routings.operations.title', 'Routing operations'),
        layout: 'full',
        component: ({ value, setValue }) => (
          <RoutingOperationsEditor
            value={(value as RoutingOperationRow[]) ?? []}
            onChange={setValue}
            t={t}
            workCenterOptions={workCenterOptions}
          />
        ),
      },
    ],
    [t, workCenterOptions],
  )

  const handleDelete = React.useCallback(async () => {
    if (!record) return
    try {
      // CrudForm already wraps onDelete with withScopedApiRequestHeaders(
      // buildOptimisticLockHeader(optimisticLockUpdatedAt), ...), so no manual
      // header wrap is needed here.
      await deleteCrud('manufacturing/routings', { id: record.id })
      flash(t('manufacturing.routings.success.deleted', 'Routing deleted successfully'), 'success')
      router.push('/backend/manufacturing/routings')
    } catch (err) {
      if (surfaceRecordConflict(err, t)) return
      flash(t('manufacturing.routings.error.delete_failed', 'Failed to delete routing'), 'error')
    }
  }, [record, t, router])

  if (loading) {
    return (
      <Page>
        <PageBody>
          <LoadingMessage label={t('manufacturing.routings.loading', 'Loading routing...')} />
        </PageBody>
      </Page>
    )
  }

  if (isNotFound) {
    return (
      <Page>
        <PageBody>
          <RecordNotFoundState
            label={t('manufacturing.routings.error.not_found', 'Routing not found')}
            backHref="/backend/manufacturing/routings"
            backLabel={t('manufacturing.routings.title', 'Routings')}
          />
        </PageBody>
      </Page>
    )
  }

  if (error || !record) {
    return (
      <Page>
        <PageBody>
          <ErrorMessage label={error ?? t('manufacturing.routings.error.not_found', 'Routing not found')} />
        </PageBody>
      </Page>
    )
  }

  return (
    <Page>
      <PageBody>
        <CrudForm<RoutingEditValues>
          title={t('manufacturing.routings.edit.title', 'Edit routing')}
          backHref="/backend/manufacturing/routings"
          fields={fields}
          schema={routingEditSchema}
          optimisticLockUpdatedAt={record.updatedAt}
          initialValues={{
            name: record.name,
            status: record.status,
            operations: record.operations,
          } as unknown as Partial<RoutingEditValues>}
          submitLabel={t('manufacturing.routings.form.save', 'Save changes')}
          cancelHref="/backend/manufacturing/routings"
          onDelete={handleDelete}
          onSubmit={async (values) => {
            try {
              await updateCrud('manufacturing/routings', { id: record.id, ...values })
            } catch (err) {
              if (surfaceRecordConflict(err, t)) return
              throw err
            }
            flash(t('manufacturing.routings.success.updated', 'Routing updated successfully'), 'success')
            router.push('/backend/manufacturing/routings')
          }}
        />
      </PageBody>
    </Page>
  )
}

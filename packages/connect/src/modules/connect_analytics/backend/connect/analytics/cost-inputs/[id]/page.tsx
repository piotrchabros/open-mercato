"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { deleteCrud, updateCrud } from '@open-mercato/ui/backend/utils/crud'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { ErrorMessage, LoadingMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import {
  translateCostInputError,
  useCostInputFormLayout,
  validateCostInputValues,
  type CostInputFormValues,
} from '../../../../../components/costInputForm'

const LIST_HREF = '/backend/connect/analytics/cost-inputs'

type CostInputRecord = {
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
  description: string | null
  updatedAt: string | null
}

type CostInputDetailResponse = { items?: CostInputRecord[] }

/**
 * `datetime-local` inputs speak local wall-clock time with no zone. The stored
 * period is half-open UTC, so the value is rendered from its UTC parts and read
 * back the same way — formatting it through the browser's zone would silently
 * shift every boundary on save.
 */
function toDateTimeLocalUtc(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 16)
}

export default function EditConnectCostInputPage({ params }: { params?: { id?: string } }) {
  const translate = useT()
  const router = useRouter()
  const recordId = typeof params?.id === 'string' ? params.id : ''
  const { fields, groups, currency } = useCostInputFormLayout(translate)

  const [record, setRecord] = React.useState<CostInputRecord | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [notFound, setNotFound] = React.useState(false)
  const [loadFailed, setLoadFailed] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      if (!recordId) {
        setLoadFailed(true)
        setLoading(false)
        return
      }
      setLoading(true)
      const call = await apiCall<CostInputDetailResponse>(
        `/api/connect_analytics/cost-inputs?id=${encodeURIComponent(recordId)}`,
        undefined,
        { fallback: { items: [] } },
      )
      if (cancelled) return
      if (!call.ok) {
        setLoadFailed(true)
        setLoading(false)
        return
      }
      const found = Array.isArray(call.result?.items) ? call.result.items[0] ?? null : null
      if (!found) setNotFound(true)
      setRecord(found)
      setLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [recordId])

  const initialValues = React.useMemo<CostInputFormValues | null>(() => {
    if (!record) return null
    return {
      id: record.id,
      periodStart: toDateTimeLocalUtc(record.periodStart),
      periodEnd: toDateTimeLocalUtc(record.periodEnd),
      costType: record.costType ?? 'channel',
      userId: record.userId ?? '',
      channelId: record.channelId ?? '',
      amountMinor: record.amountMinor ?? '',
      currencyCode: record.currencyCode ?? '',
      source: record.source ?? 'manual',
      providerInvoiceRef: record.providerInvoiceRef ?? '',
      providerLineRef: record.providerLineRef ?? '',
      description: record.description ?? '',
      updatedAt: record.updatedAt ?? undefined,
    }
  }, [record])

  if (loading) {
    return (
      <Page>
        <PageBody>
          <LoadingMessage label={translate('connect_analytics.costInputs.form.loading')} />
        </PageBody>
      </Page>
    )
  }

  if (notFound) {
    return (
      <Page>
        <PageBody>
          <RecordNotFoundState
            label={translate('connect_analytics.costInputs.form.notFound')}
            backHref={LIST_HREF}
            backLabel={translate('connect_analytics.costInputs.form.backToList')}
          />
        </PageBody>
      </Page>
    )
  }

  if (loadFailed || !record || !initialValues) {
    return (
      <Page>
        <PageBody>
          <ErrorMessage label={translate('connect_analytics.costInputs.form.loadError')} />
        </PageBody>
      </Page>
    )
  }

  return (
    <Page>
      <PageBody>
        <CrudForm<CostInputFormValues>
          title={translate('connect_analytics.costInputs.edit.title')}
          backHref={LIST_HREF}
          cancelHref={LIST_HREF}
          deleteRedirect={LIST_HREF}
          submitLabel={translate('connect_analytics.costInputs.form.submitUpdate')}
          fields={fields}
          groups={groups}
          initialValues={initialValues}
          onSubmit={async (values) => {
            const payload = validateCostInputValues(values, currency, translate)
            await updateCrud('connect_analytics/cost-inputs', { id: record.id, ...payload }, {
              errorMessage: translate('connect_analytics.costInputs.form.updateError'),
            }).catch((err) => {
              throw translateCostInputError(err, translate)
            })
            flash(translate('connect_analytics.costInputs.form.updateSuccess'), 'success')
            router.push(LIST_HREF)
          }}
          onDelete={async () => {
            await deleteCrud('connect_analytics/cost-inputs', record.id, {
              errorMessage: translate('connect_analytics.costInputs.form.deleteError'),
            }).catch((err) => {
              throw translateCostInputError(err, translate)
            })
          }}
        />
      </PageBody>
    </Page>
  )
}

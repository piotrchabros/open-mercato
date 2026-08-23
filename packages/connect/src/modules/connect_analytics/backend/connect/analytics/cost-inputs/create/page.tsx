"use client"

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm } from '@open-mercato/ui/backend/CrudForm'
import { createCrud } from '@open-mercato/ui/backend/utils/crud'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import {
  translateCostInputError,
  useCostInputFormLayout,
  validateCostInputValues,
  type CostInputFormValues,
} from '../../../../../components/costInputForm'

const LIST_HREF = '/backend/connect/analytics/cost-inputs'

export default function CreateConnectCostInputPage() {
  const translate = useT()
  const router = useRouter()
  const { fields, groups, currency } = useCostInputFormLayout(translate)

  return (
    <Page>
      <PageBody>
        <CrudForm<CostInputFormValues>
          title={translate('connect_analytics.costInputs.create.title')}
          backHref={LIST_HREF}
          cancelHref={LIST_HREF}
          submitLabel={translate('connect_analytics.costInputs.form.submitCreate')}
          fields={fields}
          groups={groups}
          initialValues={{
            periodStart: '',
            periodEnd: '',
            costType: 'channel',
            userId: '',
            channelId: '',
            amountMinor: '',
            currencyCode: '',
            source: 'manual',
            providerInvoiceRef: '',
            providerLineRef: '',
            description: '',
          }}
          onSubmit={async (values) => {
            const payload = validateCostInputValues(values, currency, translate)
            await createCrud('connect_analytics/cost-inputs', payload, {
              errorMessage: translate('connect_analytics.costInputs.form.createError'),
            }).catch((err) => {
              throw translateCostInputError(err, translate)
            })
            flash(translate('connect_analytics.costInputs.form.createSuccess'), 'success')
            router.push(LIST_HREF)
          }}
        />
      </PageBody>
    </Page>
  )
}

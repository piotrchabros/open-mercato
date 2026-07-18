'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm, type CrudField } from '@open-mercato/ui/backend/CrudForm'
import { createCrud } from '@open-mercato/ui/backend/utils/crud'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { orderCreateSchema, type OrderCreateInput } from '../../../../data/validators.js'

export default function CreateManufacturingOrderPage() {
  const t = useT()
  const router = useRouter()

  const fields = React.useMemo<CrudField[]>(
    () => [
      { id: 'productId', type: 'text', label: t('manufacturing.orders.field.product_id', 'Product ID'), required: true, layout: 'half' },
      { id: 'variantId', type: 'text', label: t('manufacturing.orders.field.variant_id', 'Variant ID'), layout: 'half' },
      { id: 'qtyPlanned', type: 'number', label: t('manufacturing.orders.field.qty_planned', 'Quantity planned'), required: true, layout: 'half' },
      { id: 'uom', type: 'text', label: t('manufacturing.orders.field.uom', 'UoM'), required: true, layout: 'half' },
      { id: 'dueDate', type: 'date', label: t('manufacturing.orders.field.due_date', 'Due date'), layout: 'half' },
      { id: 'priority', type: 'number', label: t('manufacturing.orders.field.priority', 'Priority'), layout: 'half' },
      {
        id: 'sourceType',
        type: 'select',
        label: t('manufacturing.orders.field.source_type', 'Source'),
        layout: 'half',
        options: [
          { value: 'manual', label: t('manufacturing.orders.source_type.manual', 'Manual') },
          { value: 'sales_order', label: t('manufacturing.orders.source_type.sales_order', 'Sales order') },
          { value: 'mrp', label: t('manufacturing.orders.source_type.mrp', 'MRP') },
        ],
      },
    ],
    [t],
  )

  return (
    <Page>
      <PageBody>
        <CrudForm<OrderCreateInput>
          title={t('manufacturing.orders.create.title', 'Create manufacturing order')}
          backHref="/backend/manufacturing/orders"
          fields={fields}
          schema={orderCreateSchema}
          initialValues={{ priority: 0, sourceType: 'manual' }}
          submitLabel={t('manufacturing.orders.form.submit', 'Create manufacturing order')}
          cancelHref="/backend/manufacturing/orders"
          onSubmit={async (values) => {
            const call = await createCrud<{ id: string }>('manufacturing/orders', values)
            flash(t('manufacturing.orders.success.created', 'Manufacturing order created successfully'), 'success')
            const id = call.result?.id
            router.push(id ? `/backend/manufacturing/orders/${id}` : '/backend/manufacturing/orders')
          }}
        />
      </PageBody>
    </Page>
  )
}

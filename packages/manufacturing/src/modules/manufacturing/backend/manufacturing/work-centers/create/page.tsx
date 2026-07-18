'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { CrudForm, type CrudField } from '@open-mercato/ui/backend/CrudForm'
import { createCrud } from '@open-mercato/ui/backend/utils/crud'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { workCenterCreateSchema, type WorkCenterCreateInput } from '../../../../data/validators.js'

export default function CreateWorkCenterPage() {
  const t = useT()
  const router = useRouter()

  const fields = React.useMemo<CrudField[]>(
    () => [
      {
        id: 'name',
        type: 'text',
        label: t('manufacturing.work_centers.field.name', 'Name'),
        required: true,
      },
      {
        id: 'kind',
        type: 'select',
        label: t('manufacturing.work_centers.field.kind', 'Kind'),
        required: true,
        options: [
          { value: 'machine', label: t('manufacturing.work_centers.kind.machine', 'Machine') },
          { value: 'manual', label: t('manufacturing.work_centers.kind.manual', 'Manual') },
          { value: 'line', label: t('manufacturing.work_centers.kind.line', 'Line') },
          { value: 'subcontractor', label: t('manufacturing.work_centers.kind.subcontractor', 'Subcontractor') },
        ],
      },
      {
        id: 'costRatePerHour',
        type: 'number',
        label: t('manufacturing.work_centers.field.cost_rate_per_hour', 'Cost rate / hour'),
        required: true,
        layout: 'half',
      },
      {
        id: 'parallelStations',
        type: 'number',
        label: t('manufacturing.work_centers.field.parallel_stations', 'Parallel stations'),
        layout: 'half',
      },
      {
        id: 'efficiencyFactor',
        type: 'number',
        label: t('manufacturing.work_centers.field.efficiency_factor', 'Efficiency factor'),
        layout: 'half',
      },
      {
        id: 'availabilityRuleSetId',
        type: 'text',
        label: t('manufacturing.work_centers.field.availability_rule_set_id', 'Availability rule set ID'),
        description: t('manufacturing.work_centers.note.availability_rule_set', 'Optional; a picker for availability rule sets is a planned enhancement.'),
        layout: 'half',
      },
      {
        id: 'isActive',
        type: 'checkbox',
        label: t('manufacturing.work_centers.field.is_active', 'Active'),
      },
    ],
    [t],
  )

  return (
    <Page>
      <PageBody>
        <CrudForm<WorkCenterCreateInput>
          title={t('manufacturing.work_centers.create.title', 'Create work center')}
          backHref="/backend/manufacturing/work-centers"
          fields={fields}
          schema={workCenterCreateSchema}
          initialValues={{
            kind: 'machine',
            parallelStations: 1,
            efficiencyFactor: 1,
            isActive: true,
          }}
          submitLabel={t('manufacturing.work_centers.form.submit', 'Create work center')}
          cancelHref="/backend/manufacturing/work-centers"
          onSubmit={async (values) => {
            await createCrud('manufacturing/work-centers', values)
            flash(t('manufacturing.work_centers.success.created', 'Work center created successfully'), 'success')
            router.push('/backend/manufacturing/work-centers')
          }}
        />
      </PageBody>
    </Page>
  )
}

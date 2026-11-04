'use client'

import * as React from 'react'
import Link from 'next/link'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Button } from '@open-mercato/ui/primitives/button'

const BACKEND_PATH = '/backend/meta-lead-ads'

export default function IntegrationDetailWidget(
  _props: InjectionWidgetComponentProps<Record<string, unknown>, Record<string, unknown>>,
) {
  const t = useT()

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">
          {t('meta_lead_ads.widgets.integrationDetail.title', 'Meta Lead Ads')}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t(
            'meta_lead_ads.widgets.integrationDetail.description',
            'Manage Facebook pages, lead forms and imported leads for this organization.',
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href={BACKEND_PATH}>
            {t('meta_lead_ads.widgets.integrationDetail.manage', 'Manage connections and forms')}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`${BACKEND_PATH}/leads`}>
            {t('meta_lead_ads.widgets.integrationDetail.leads', 'Lead log')}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`${BACKEND_PATH}/settings`}>
            {t('meta_lead_ads.widgets.integrationDetail.settings', 'Settings')}
          </Link>
        </Button>
      </div>
    </div>
  )
}

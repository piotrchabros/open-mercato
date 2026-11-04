'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'

const STEPS: ReadonlyArray<{ key: string; fallback: string }> = [
  {
    key: 'meta_lead_ads.help.leadsAccess.step1',
    fallback: 'Open Meta Business Suite and select the business that owns the Page.',
  },
  {
    key: 'meta_lead_ads.help.leadsAccess.step2',
    fallback: 'Go to Settings, then Integrations, then Leads Access.',
  },
  {
    key: 'meta_lead_ads.help.leadsAccess.step3',
    fallback: 'Select the Page and open the CRM tab, then assign this app and the connecting user to the Page.',
  },
  {
    key: 'meta_lead_ads.help.leadsAccess.step4',
    fallback: 'Return here and run the Page check again to confirm that Leads Access is granted.',
  },
]

export function LeadsAccessHelp() {
  const t = useT()
  return (
    <div className="space-y-2 rounded-md border border-status-info-border bg-status-info-bg p-4 text-sm text-foreground">
      <p className="font-medium">
        {t('meta_lead_ads.help.leadsAccess.title', 'How to grant Leads Access')}
      </p>
      <ol className="list-decimal space-y-1 pl-5">
        {STEPS.map((step) => (
          <li key={step.key}>{t(step.key, step.fallback)}</li>
        ))}
      </ol>
    </div>
  )
}

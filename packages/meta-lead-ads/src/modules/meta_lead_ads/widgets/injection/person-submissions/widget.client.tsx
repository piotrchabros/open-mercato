'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { formatDateTime } from '@open-mercato/shared/lib/time'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { LeadEventStatusBadge } from '../../../components/StatusBadges'
import type { SubmissionsResponse } from '../../../components/types'

type PersonSubmissionsContext = {
  resourceKind: string
  resourceId: string
}

const PLATFORM_LABELS: Record<string, string> = {
  fb: 'Facebook',
  ig: 'Instagram',
}

function isValidContext(ctx: unknown): ctx is PersonSubmissionsContext {
  if (!ctx || typeof ctx !== 'object') return false
  const candidate = ctx as { resourceKind?: unknown; resourceId?: unknown }
  if (candidate.resourceKind !== 'customers.person') return false
  return typeof candidate.resourceId === 'string' && candidate.resourceId.trim().length > 0
}

export default function PersonSubmissionsWidget({
  context,
}: InjectionWidgetComponentProps<PersonSubmissionsContext, unknown>) {
  const t = useT()
  const personId = isValidContext(context) ? context.resourceId : null

  const [data, setData] = React.useState<SubmissionsResponse | null>(null)
  const [loading, setLoading] = React.useState(personId !== null)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    if (!personId) return undefined
    let cancelled = false
    setLoading(true)
    setFailed(false)
    readApiResultOrThrow<SubmissionsResponse>(`/api/meta_lead_ads/people/${encodeURIComponent(personId)}/submissions`)
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [personId])

  if (!personId) return null

  if (loading) {
    return <LoadingMessage label={t('meta_lead_ads.widgets.personSubmissions.loading', 'Loading submissions...')} />
  }

  if (failed || !data) {
    return <ErrorMessage label={t('meta_lead_ads.widgets.personSubmissions.error', 'Failed to load submissions.')} />
  }

  const { items, consents } = data

  if (!items.length && !consents.length) {
    return (
      <EmptyState
        title={t('meta_lead_ads.widgets.personSubmissions.empty.title', 'No lead form submissions')}
        description={t(
          'meta_lead_ads.widgets.personSubmissions.empty.description',
          'This person has not submitted a Meta lead form.',
        )}
      />
    )
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">
          {t('meta_lead_ads.widgets.personSubmissions.submissions', 'Submissions')}
        </h3>
        <ul className="divide-y rounded-lg border">
          {items.map((item) => (
            <li key={item.leadEventId} className="flex flex-wrap items-center justify-between gap-3 p-3">
              <div className="space-y-1">
                <div className="text-sm font-medium">
                  {item.formName ?? t('meta_lead_ads.widgets.personSubmissions.unknownForm', 'Unknown form')}
                </div>
                <div className="text-sm text-muted-foreground">
                  {[
                    formatDateTime(item.submittedAt),
                    item.campaignName,
                    item.platform ? PLATFORM_LABELS[item.platform] ?? item.platform : null,
                  ]
                    .filter((part): part is string => Boolean(part))
                    .join(' · ')}
                </div>
              </div>
              <LeadEventStatusBadge status={item.status} />
            </li>
          ))}
        </ul>
      </section>
      {consents.length ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">
            {t('meta_lead_ads.widgets.personSubmissions.consents', 'Consents')}
          </h3>
          <ul className="divide-y rounded-lg border">
            {consents.map((consent) => (
              <li
                key={`${consent.leadEventId}:${consent.consentKey}`}
                className="flex flex-wrap items-center justify-between gap-3 p-3"
              >
                <div className="space-y-1">
                  <div className="text-sm">{consent.consentText ?? consent.consentKey}</div>
                  <div className="text-sm text-muted-foreground">{formatDateTime(consent.givenAt) ?? ''}</div>
                </div>
                <span className="text-sm font-medium">
                  {consent.isChecked
                    ? t('meta_lead_ads.widgets.personSubmissions.consentGiven', 'Given')
                    : t('meta_lead_ads.widgets.personSubmissions.consentNotGiven', 'Not given')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

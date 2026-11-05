'use client'

import * as React from 'react'
import Link from 'next/link'
import { useLocale, useT } from '@open-mercato/shared/lib/i18n/context'
import { formatDateTime } from '@open-mercato/shared/lib/time'
import { hasFeature } from '@open-mercato/shared/security/features'
import type { InjectionWidgetComponentProps } from '@open-mercato/shared/modules/widgets/injection'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { ErrorMessage, LoadingMessage } from '@open-mercato/ui/backend/detail'
import { useBackendChrome } from '@open-mercato/ui/backend/BackendChromeProvider'
import { Button } from '@open-mercato/ui/primitives/button'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { formatCurrency } from '@open-mercato/ui/utils/format'
import { OfferStatusBadge } from '../../../components/OfferStatusBadge'
import type { OfferDto, PagedResponse } from '../../../components/types'

type CrmOffersContext = {
  resourceKind: string
  resourceId: string
}

type CrmOffersResourceKind = 'customers.person' | 'customers.company' | 'customers.deal'

const RESOURCE_KINDS: CrmOffersResourceKind[] = ['customers.person', 'customers.company', 'customers.deal']

function isValidContext(ctx: unknown): ctx is CrmOffersContext {
  if (!ctx || typeof ctx !== 'object') return false
  const candidate = ctx as { resourceKind?: unknown; resourceId?: unknown }
  if (typeof candidate.resourceKind !== 'string') return false
  if (!RESOURCE_KINDS.includes(candidate.resourceKind as CrmOffersResourceKind)) return false
  return typeof candidate.resourceId === 'string' && candidate.resourceId.trim().length > 0
}

function buildListUrl(kind: CrmOffersResourceKind, resourceId: string): string {
  const params = new URLSearchParams({ pageSize: '100', sortField: 'updatedAt', sortDir: 'desc' })
  params.set(kind === 'customers.deal' ? 'dealId' : 'customerEntityId', resourceId)
  return `/api/offer_generator/offers?${params.toString()}`
}

function buildCreateUrl(kind: CrmOffersResourceKind, resourceId: string): string {
  const params = new URLSearchParams()
  if (kind === 'customers.deal') {
    params.set('dealId', resourceId)
  } else {
    params.set('customerEntityId', resourceId)
    params.set('customerKind', kind === 'customers.company' ? 'company' : 'person')
  }
  return `/backend/offer-generator/create?${params.toString()}`
}

export default function CrmOffersWidget({
  context,
}: InjectionWidgetComponentProps<CrmOffersContext, unknown>) {
  const t = useT()
  const locale = useLocale()
  const { payload } = useBackendChrome()
  const canManage = hasFeature(payload?.grantedFeatures, 'offer_generator.manage')
  const validContext = isValidContext(context) ? context : null
  const kind = validContext ? (validContext.resourceKind as CrmOffersResourceKind) : null
  const resourceId = validContext ? validContext.resourceId : null

  const [items, setItems] = React.useState<OfferDto[] | null>(null)
  const [loading, setLoading] = React.useState(validContext !== null)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    if (!kind || !resourceId) return undefined
    let cancelled = false
    setLoading(true)
    setFailed(false)
    readApiResultOrThrow<PagedResponse<OfferDto>>(buildListUrl(kind, resourceId))
      .then((result) => {
        if (!cancelled) setItems(result.items)
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
  }, [kind, resourceId])

  if (!kind || !resourceId) return null

  const newOfferButton = canManage ? (
    <Button asChild size="sm">
      <Link href={buildCreateUrl(kind, resourceId)}>
        {t('offer_generator.widgets.crmOffers.new', 'New offer')}
      </Link>
    </Button>
  ) : null

  if (loading) {
    return <LoadingMessage label={t('offer_generator.widgets.crmOffers.loading', 'Loading offers...')} />
  }

  if (failed || !items) {
    return <ErrorMessage label={t('offer_generator.widgets.crmOffers.error', 'Failed to load offers.')} />
  }

  if (!items.length) {
    return (
      <EmptyState
        title={t('offer_generator.widgets.crmOffers.empty.title', 'No offers yet')}
        description={t(
          'offer_generator.widgets.crmOffers.empty.description',
          'No offers have been created for this record.',
        )}
        actions={newOfferButton ?? undefined}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t('offer_generator.widgets.crmOffers.title', 'Offers')}</h3>
        {newOfferButton}
      </div>
      <ul className="divide-y rounded-lg border">
        {items.map((offer) => {
          const value = formatCurrency(offer.valueAmount, offer.currencyCode, locale)
          const updated = offer.updatedAt ? formatDateTime(offer.updatedAt) : null
          return (
            <li key={offer.id}>
              <Link
                href={`/backend/offer-generator/${encodeURIComponent(offer.id)}`}
                className="flex flex-wrap items-center justify-between gap-3 p-3 hover:bg-muted"
              >
                <div className="space-y-1">
                  <div className="text-sm font-medium">{offer.title}</div>
                  <div className="text-sm text-muted-foreground">
                    {[
                      value,
                      t('offer_generator.widgets.crmOffers.views', '{count} views', { count: offer.viewCount }),
                      updated
                        ? t('offer_generator.widgets.crmOffers.updated', 'Updated {date}', { date: updated })
                        : null,
                    ]
                      .filter((part): part is string => Boolean(part))
                      .join(' · ')}
                  </div>
                </div>
                <OfferStatusBadge status={offer.status} />
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

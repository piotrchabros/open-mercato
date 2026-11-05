'use client'

import * as React from 'react'
import { StatusBadge, type StatusMap } from '@open-mercato/ui/primitives/status-badge'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { OfferStatus } from './types'

export const OFFER_STATUSES: OfferStatus[] = ['draft', 'sent', 'viewed', 'accepted', 'rejected']

const OFFER_STATUS_VARIANTS: StatusMap<OfferStatus> = {
  draft: 'neutral',
  sent: 'info',
  viewed: 'warning',
  accepted: 'success',
  rejected: 'error',
}

const OFFER_STATUS_FALLBACKS: Record<OfferStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  accepted: 'Accepted',
  rejected: 'Rejected',
}

export function useOfferStatusLabel(): (status: OfferStatus) => string {
  const t = useT()
  return React.useCallback(
    (status: OfferStatus) => t(`offer_generator.statuses.${status}`, OFFER_STATUS_FALLBACKS[status] ?? status),
    [t],
  )
}

export function OfferStatusBadge({ status }: { status: OfferStatus }) {
  const label = useOfferStatusLabel()
  return (
    <StatusBadge variant={OFFER_STATUS_VARIANTS[status] ?? 'neutral'} dot>
      {label(status)}
    </StatusBadge>
  )
}

export default OfferStatusBadge

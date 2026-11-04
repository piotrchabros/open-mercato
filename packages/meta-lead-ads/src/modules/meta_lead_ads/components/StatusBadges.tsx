'use client'

import * as React from 'react'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type {
  ConnectionStatus,
  LeadEventStatus,
  PageSubscriptionStatus,
  SyncRunStatus,
} from './types'

const CONNECTION_VARIANTS: Record<ConnectionStatus, StatusBadgeVariant> = {
  active: 'success',
  token_expired: 'warning',
  invalid: 'error',
  disconnected: 'neutral',
}

const PAGE_VARIANTS: Record<PageSubscriptionStatus, StatusBadgeVariant> = {
  active: 'success',
  missing_permissions: 'error',
  token_expired: 'warning',
  no_leads_access: 'error',
  unsubscribed: 'neutral',
}

const LEAD_EVENT_VARIANTS: Record<LeadEventStatus, StatusBadgeVariant> = {
  received: 'info',
  processing: 'info',
  processed: 'success',
  duplicate: 'neutral',
  skipped: 'neutral',
  retrying: 'warning',
  failed: 'error',
  dead_lettered: 'error',
  unrouted: 'warning',
}

const SYNC_RUN_VARIANTS: Record<SyncRunStatus, StatusBadgeVariant> = {
  running: 'info',
  completed: 'success',
  failed: 'error',
}

const LABEL_FALLBACKS: Record<string, string> = {
  active: 'Active',
  token_expired: 'Token expired',
  invalid: 'Invalid',
  disconnected: 'Disconnected',
  missing_permissions: 'Missing permissions',
  no_leads_access: 'No Leads Access',
  unsubscribed: 'Unsubscribed',
  received: 'Received',
  processing: 'Processing',
  processed: 'Processed',
  duplicate: 'Duplicate',
  skipped: 'Skipped',
  retrying: 'Retrying',
  failed: 'Failed',
  dead_lettered: 'Dead-lettered',
  unrouted: 'Unrouted',
  running: 'Running',
  completed: 'Completed',
}

function useStatusLabel(kind: string, status: string): string {
  const t = useT()
  return t(`meta_lead_ads.statuses.${kind}.${status}`, LABEL_FALLBACKS[status] ?? status)
}

export function ConnectionStatusBadge({ status }: { status: ConnectionStatus }) {
  const label = useStatusLabel('connection', status)
  return <StatusBadge variant={CONNECTION_VARIANTS[status] ?? 'neutral'} dot>{label}</StatusBadge>
}

export function PageStatusBadge({ status }: { status: PageSubscriptionStatus }) {
  const label = useStatusLabel('page', status)
  return <StatusBadge variant={PAGE_VARIANTS[status] ?? 'neutral'} dot>{label}</StatusBadge>
}

export function LeadEventStatusBadge({ status }: { status: LeadEventStatus }) {
  const label = useStatusLabel('leadEvent', status)
  return <StatusBadge variant={LEAD_EVENT_VARIANTS[status] ?? 'neutral'} dot>{label}</StatusBadge>
}

export function SyncRunStatusBadge({ status }: { status: SyncRunStatus }) {
  const label = useStatusLabel('syncRun', status)
  return <StatusBadge variant={SYNC_RUN_VARIANTS[status] ?? 'neutral'} dot>{label}</StatusBadge>
}

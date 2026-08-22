'use client'

import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { InboxCaseRow, InboxFilter } from './types'

/**
 * The triage pane.
 *
 * The default filter is UNASSIGNED plus MINE. That is the whole reason this
 * pane exists as it does: filtering an agent to their own Cases alone leaves a
 * new agent staring at an empty Inbox with no way to pick up work.
 */

const STATUS_VARIANT: Record<string, StatusBadgeVariant> = {
  new: 'info',
  in_progress: 'warning',
  waiting_customer: 'neutral',
  resolved: 'success',
  closed: 'neutral',
}

type Props = {
  rows: InboxCaseRow[]
  filter: InboxFilter
  onFilterChange: (filter: InboxFilter) => void
  selectedId: string | null
  onSelect: (caseId: string) => void
  onClaim: (caseId: string) => void
  isLoading: boolean
  error: string | null
  stale: boolean
  onRetry: () => void
  canSeeAll: boolean
  currentUserId: string
}

export function CaseListPane({
  rows,
  filter,
  onFilterChange,
  selectedId,
  onSelect,
  onClaim,
  isLoading,
  error,
  stale,
  onRetry,
  canSeeAll,
  currentUserId,
}: Props) {
  const t = useT()

  const filters: Array<{ id: InboxFilter; label: string }> = [
    { id: 'triage', label: t('connect.inbox.filters.triage', 'Triage') },
    { id: 'mine', label: t('connect.inbox.filters.mine', 'Mine') },
    { id: 'unassigned', label: t('connect.inbox.filters.unassigned', 'Unassigned') },
    ...(canSeeAll ? [{ id: 'all' as const, label: t('connect.inbox.filters.all', 'All') }] : []),
  ]

  return (
    <section
      aria-label={t('connect.inbox.list.aria', 'Cases')}
      className="flex h-full min-h-0 flex-col border-r border-border"
    >
      <div className="flex flex-wrap gap-1 border-b border-border p-2" role="tablist">
        {filters.map((entry) => (
          <Button
            key={entry.id}
            variant={filter === entry.id ? 'default' : 'outline'}
            role="tab"
            aria-selected={filter === entry.id}
            onClick={() => onFilterChange(entry.id)}
          >
            {entry.label}
          </Button>
        ))}
      </div>

      {stale ? (
        <div className="border-b border-border bg-status-warning-lighter px-3 py-2 text-xs text-status-warning-base">
          {t('connect.inbox.list.stale', 'Showing the last loaded list. Refresh to try again.')}{' '}
          <Button variant="link" onClick={onRetry}>
            {t('connect.inbox.list.refresh', 'Refresh')}
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && rows.length === 0 ? (
          <div className="p-3">
            <LoadingMessage label={t('connect.inbox.list.loading', 'Loading cases...')} />
          </div>
        ) : error && rows.length === 0 ? (
          <div className="p-3">
            <ErrorMessage label={error} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-3">
            <EmptyState
              title={t('connect.inbox.list.emptyTitle', 'Nothing to triage')}
              description={t(
                'connect.inbox.list.emptyDescription',
                'New customer messages appear here as soon as they arrive.',
              )}
            />
          </div>
        ) : (
          <ul>
            {rows.map((row) => {
              const isSelected = row.id === selectedId
              const isMine = row.assigneeUserId === currentUserId
              return (
                <li key={row.id}>
                  <div
                    className={`flex items-start justify-between gap-2 border-b border-border p-3 ${
                      isSelected ? 'bg-muted' : ''
                    }`}
                  >
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      aria-current={isSelected ? 'true' : undefined}
                      onClick={() => onSelect(row.id)}
                    >
                      <p className="flex items-center gap-2 truncate text-sm font-medium">
                        {row.unread ? (
                          <span
                            className="inline-block h-2 w-2 shrink-0 rounded-full bg-status-info-icon"
                            aria-label={t('connect.inbox.list.unread', 'Unread')}
                          />
                        ) : null}
                        <span className="truncate">#{row.number}</span>
                        <span className="truncate text-muted-foreground">{row.displayLabel ?? '—'}</span>
                      </p>
                      <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <StatusBadge variant={STATUS_VARIANT[row.status] ?? 'neutral'}>
                          {t(`connect.case.status.${row.status}`, row.status)}
                        </StatusBadge>
                        {row.assigneeUserId ? (
                          <span>
                            {isMine
                              ? t('connect.inbox.list.assignedToYou', 'Assigned to you')
                              : t('connect.inbox.list.assigned', 'Assigned')}
                          </span>
                        ) : (
                          <span>{t('connect.inbox.list.unassigned', 'Unassigned')}</span>
                        )}
                      </p>
                    </button>
                    {!row.assigneeUserId ? (
                      <Button variant="outline" onClick={() => onClaim(row.id)}>
                        {t('connect.inbox.list.claim', 'Claim')}
                      </Button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}

export default CaseListPane

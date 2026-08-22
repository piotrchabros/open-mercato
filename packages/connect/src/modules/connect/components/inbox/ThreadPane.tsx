'use client'

import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { ThreadItem } from './types'

/**
 * The conversation pane.
 *
 * Every item comes from the hub's authorized thread reader, so this component
 * renders a bounded plain-text projection and nothing else: no HTML, no
 * attachment download affordance (Phase 1 exposes no URL at all), and a
 * stable-position placeholder where an item could not be rendered — one
 * unreadable message must not blank the conversation around it.
 */

type Props = {
  items: ThreadItem[]
  isLoading: boolean
  error: string | null
  binding: 'bound' | 'missing' | null
  readOnlyReason: string | null
  hasMore: boolean
  onLoadMore: () => void
  onRetryItem: () => void
  headingRef?: React.Ref<HTMLHeadingElement>
}

export function ThreadPane({
  items,
  isLoading,
  error,
  binding,
  readOnlyReason,
  hasMore,
  onLoadMore,
  onRetryItem,
  headingRef,
}: Props) {
  const t = useT()

  return (
    <section
      aria-label={t('connect.inbox.thread.aria', 'Conversation')}
      className="flex h-full min-h-0 flex-col border-r border-border"
    >
      <h2 ref={headingRef} tabIndex={-1} className="border-b border-border p-3 text-sm font-semibold">
        {t('connect.inbox.thread.title', 'Conversation')}
      </h2>

      {readOnlyReason ? (
        <Alert status="warning" className="m-3">
          <AlertDescription>{readOnlyReason}</AlertDescription>
        </Alert>
      ) : null}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3" aria-live="polite">
        {isLoading && items.length === 0 ? (
          <LoadingMessage label={t('connect.inbox.thread.loading', 'Loading conversation...')} />
        ) : error ? (
          <ErrorMessage label={error} />
        ) : binding === 'missing' ? (
          // A Case with no bound conversation is a real state (a successor
          // before its first inbound), distinct from a thread that is empty.
          <EmptyState
            title={t('connect.inbox.thread.unboundTitle', 'No conversation yet')}
            description={t(
              'connect.inbox.thread.unboundDescription',
              'This case has no linked conversation. It will appear as soon as the customer writes.',
            )}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={t('connect.inbox.thread.emptyTitle', 'No messages yet')}
            description={t('connect.inbox.thread.emptyDescription', 'This conversation is empty.')}
          />
        ) : (
          items.map((item) =>
            item.kind === 'message' ? (
              <article
                key={item.id}
                className={`rounded-md border border-border p-3 ${
                  item.direction === 'outbound' ? 'bg-muted' : ''
                }`}
              >
                <p className="mb-1 text-xs text-muted-foreground">
                  {item.direction === 'inbound'
                    ? t('connect.inbox.thread.fromCustomer', 'From the customer')
                    : t('connect.inbox.thread.fromAgent', 'Sent by your team')}{' '}
                  · {new Date(item.occurredAt).toLocaleString()}
                </p>
                <p className="whitespace-pre-wrap text-sm">{item.text}</p>
                {item.truncated ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('connect.inbox.thread.truncated', 'This message was shortened.')}
                  </p>
                ) : null}
                {item.attachments.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {item.attachments.map((attachment) => (
                      <li key={attachment.fileName} className="text-xs text-muted-foreground">
                        {/* Metadata only — Phase 1 exposes no download URL. */}
                        {attachment.fileName} · {attachment.mimeType}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ) : (
              <article key={item.id} className="rounded-md border border-dashed border-border p-3">
                <p className="text-sm text-muted-foreground">
                  {t('connect.inbox.thread.unavailable', 'This message could not be displayed.')}
                </p>
                {item.retryable ? (
                  <Button variant="outline" className="mt-2" onClick={onRetryItem}>
                    {t('connect.inbox.thread.retryItem', 'Try again')}
                  </Button>
                ) : null}
              </article>
            ),
          )
        )}
      </div>

      {hasMore ? (
        <div className="border-t border-border p-2">
          <Button variant="outline" onClick={onLoadMore} disabled={isLoading}>
            {t('connect.inbox.thread.loadMore', 'Load earlier messages')}
          </Button>
        </div>
      ) : null}
    </section>
  )
}

export default ThreadPane

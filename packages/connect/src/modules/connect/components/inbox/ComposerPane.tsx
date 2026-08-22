'use client'

import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { StatusBadge, type StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { InboxCaseRow, OutboundStatus } from './types'

/**
 * Context and composer.
 *
 * Two details here are safety features rather than polish:
 *
 *   - The destination is shown MASKED and is never editable. The real address
 *     is resolved server-side from the conversation's Contract D reference, so
 *     the browser cannot choose who a reply goes to.
 *   - `unknown` disables retry and says why. The message may already have
 *     reached the customer, so offering a retry there would be offering a
 *     duplicate.
 */

const DELIVERY_VARIANT: Record<OutboundStatus, StatusBadgeVariant> = {
  queued: 'neutral',
  sending: 'info',
  sent: 'success',
  failed: 'error',
  unknown: 'warning',
}

type Props = {
  selected: InboxCaseRow | null
  maskedRecipientLabel: string | null
  canSend: boolean
  disabledReason: string | null
  draft: string
  onDraftChange: (value: string) => void
  onSend: () => void
  isSending: boolean
  lastStatus: OutboundStatus | null
  lastError: string | null
  canRetry: boolean
  onRetry: () => void
  onResolve: () => void
  onReopen: () => void
  onClose: () => void
  canClose: boolean
}

export function ComposerPane({
  selected,
  maskedRecipientLabel,
  canSend,
  disabledReason,
  draft,
  onDraftChange,
  onSend,
  isSending,
  lastStatus,
  lastError,
  canRetry,
  onRetry,
  onResolve,
  onReopen,
  onClose,
  canClose,
}: Props) {
  const t = useT()

  if (!selected) {
    return (
      <section aria-label={t('connect.inbox.composer.aria', 'Reply')} className="p-3">
        <p className="text-sm text-muted-foreground">
          {t('connect.inbox.composer.noSelection', 'Select a case to see its details.')}
        </p>
      </section>
    )
  }

  return (
    <section
      aria-label={t('connect.inbox.composer.aria', 'Reply')}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="border-b border-border p-3">
        <h2 className="text-sm font-semibold">
          {t('connect.inbox.composer.caseHeading', 'Case')} #{selected.number}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{selected.displayLabel ?? '—'}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {selected.status !== 'closed' ? (
            <Button variant="outline" onClick={onResolve} disabled={!canSend}>
              {t('connect.inbox.actions.resolve', 'Resolve')}
            </Button>
          ) : null}
          {selected.status === 'resolved' ? (
            <Button variant="outline" onClick={onReopen} disabled={!canSend}>
              {t('connect.inbox.actions.reopen', 'Reopen')}
            </Button>
          ) : null}
          {canClose && selected.status !== 'closed' ? (
            <Button variant="outline" onClick={onClose}>
              {t('connect.inbox.actions.close', 'Close')}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {lastStatus ? (
          <div className="mb-3 flex items-center gap-2">
            <StatusBadge variant={DELIVERY_VARIANT[lastStatus]} dot>
              {t(`connect.delivery.status.${lastStatus}`, lastStatus)}
            </StatusBadge>
            {lastStatus === 'unknown' ? (
              <span className="text-xs text-muted-foreground">
                {t(
                  'connect.delivery.unknownExplainer',
                  'We are still checking whether this reached the customer. It cannot be retried until we know.',
                )}
              </span>
            ) : null}
          </div>
        ) : null}

        {lastStatus === 'failed' && canRetry ? (
          <Alert status="error" className="mb-3">
            <AlertDescription>
              {t(
                'connect.delivery.failedExplainer',
                'The provider rejected this message, so nothing reached the customer. Retrying sends it again as a new attempt.',
              )}
              <Button variant="outline" className="mt-2" onClick={onRetry}>
                {t('connect.delivery.retry', 'Retry sending')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {lastError ? (
          <Alert status="error" className="mb-3">
            <AlertDescription>{lastError}</AlertDescription>
          </Alert>
        ) : null}

        {disabledReason ? (
          <Alert status="warning" className="mb-3">
            <AlertDescription>{disabledReason}</AlertDescription>
          </Alert>
        ) : null}

        <label className="mb-1 block text-sm font-medium" htmlFor="connect-composer">
          {t('connect.inbox.composer.label', 'Reply to')}{' '}
          <span className="font-mono text-xs">{maskedRecipientLabel ?? '—'}</span>
        </label>
        <textarea
          id="connect-composer"
          className="h-40 w-full rounded-md border border-input bg-background p-2 text-sm"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          disabled={!canSend}
          onKeyDown={(event) => {
            // Cmd/Ctrl+Enter submits, matching every other dialog in the app.
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSend) {
              event.preventDefault()
              onSend()
            }
          }}
        />
        <Button
          className="mt-2"
          onClick={onSend}
          disabled={!canSend || isSending || draft.trim().length === 0}
        >
          {t('connect.inbox.composer.send', 'Send reply')}
        </Button>
      </div>
    </section>
  )
}

export default ComposerPane

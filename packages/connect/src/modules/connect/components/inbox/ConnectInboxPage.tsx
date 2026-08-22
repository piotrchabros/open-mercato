'use client'

import * as React from 'react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { CaseListPane } from './CaseListPane'
import { ThreadPane } from './ThreadPane'
import { ComposerPane } from './ComposerPane'
import type {
  ComposerSubmission,
  InboxCaseRow,
  InboxFilter,
  InboxListResponse,
  OutboundStatus,
  ThreadItem,
  ThreadResponse,
} from './types'

/**
 * The Connect Inbox.
 *
 * Three panes on a wide screen; on a narrow one the same state renders as
 * list → thread → composer with browser-back semantics, so an agent on a phone
 * keeps their filters, selection and draft.
 *
 * The composer's `clientCommandKey` is the important piece of client state. It
 * is minted when a draft first becomes dirty and kept until a confirmed 202 —
 * never rotated on a timeout — so a lost response is retried with the same key
 * and resolves to the original message instead of sending the customer a second
 * reply.
 */

const POLL_INTERVAL_MS = 30_000

type Props = {
  currentUserId: string
  canSeeAll: boolean
  canClose: boolean
}

export function ConnectInboxPage({ currentUserId, canSeeAll, canClose }: Props) {
  const t = useT()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const headingRef = React.useRef<HTMLHeadingElement>(null)

  const [filter, setFilter] = React.useState<InboxFilter>('triage')
  const [rows, setRows] = React.useState<InboxCaseRow[]>([])
  const [listLoading, setListLoading] = React.useState(true)
  const [listError, setListError] = React.useState<string | null>(null)
  const [listStale, setListStale] = React.useState(false)
  const [reloadToken, setReloadToken] = React.useState(0)

  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [threadItems, setThreadItems] = React.useState<ThreadItem[]>([])
  const [threadCursor, setThreadCursor] = React.useState<string | null>(null)
  const [threadLoading, setThreadLoading] = React.useState(false)
  const [threadError, setThreadError] = React.useState<string | null>(null)
  const [threadBinding, setThreadBinding] = React.useState<'bound' | 'missing' | null>(null)
  const [readOnlyReason, setReadOnlyReason] = React.useState<string | null>(null)

  const [draft, setDraft] = React.useState('')
  const [commandKey, setCommandKey] = React.useState<string | null>(null)
  const [isSending, setIsSending] = React.useState(false)
  const [lastStatus, setLastStatus] = React.useState<OutboundStatus | null>(null)
  const [lastAttemptId, setLastAttemptId] = React.useState<string | null>(null)
  const [maskedRecipientLabel, setMaskedRecipientLabel] = React.useState<string | null>(null)
  const [composerError, setComposerError] = React.useState<string | null>(null)

  const { runMutation, retryLastMutation } = useGuardedMutation({ contextId: 'connect.inbox' })

  const reload = React.useCallback(() => setReloadToken((token) => token + 1), [])

  // ── Case list ────────────────────────────────────────────
  React.useEffect(() => {
    let cancelled = false
    async function load() {
      setListLoading(true)
      const response = await apiCall<InboxListResponse>(
        `/api/connect/inbox?filter=${filter}`,
      ).catch(() => null)
      if (cancelled) return
      if (!response || !response.ok) {
        // Keep the last-good list and mark it stale rather than blanking the
        // pane — an agent mid-triage should not lose their queue to one failed
        // poll.
        setListError(t('connect.inbox.errors.loadList', 'Could not load cases'))
        setListStale(true)
      } else {
        setRows(response.result?.items ?? [])
        setListError(null)
        setListStale(false)
      }
      setListLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [filter, reloadToken, t])

  // Poll on an interval and on focus. No SSE contract in this phase.
  React.useEffect(() => {
    const timer = window.setInterval(reload, POLL_INTERVAL_MS)
    const onFocus = () => reload()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [reload])

  const selected = React.useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId],
  )

  // If polling removed or reassigned the selected Case, the detail becomes
  // read-only with a reason rather than silently continuing to accept a reply.
  React.useEffect(() => {
    if (!selectedId) {
      setReadOnlyReason(null)
      return
    }
    if (!listLoading && rows.length > 0 && !rows.some((row) => row.id === selectedId)) {
      setReadOnlyReason(
        t(
          'connect.inbox.thread.noLongerAvailable',
          'This case is no longer in your list. It may have been reassigned or closed.',
        ),
      )
    }
  }, [rows, selectedId, listLoading, t])

  // ── Thread ───────────────────────────────────────────────
  const loadThread = React.useCallback(
    async (caseId: string, cursor: string | null) => {
      setThreadLoading(true)
      setThreadError(null)
      const url = cursor
        ? `/api/connect/cases/${caseId}/thread?cursor=${encodeURIComponent(cursor)}`
        : `/api/connect/cases/${caseId}/thread`
      const response = await apiCall<ThreadResponse>(url).catch(() => null)
      if (!response || !response.ok) {
        setThreadError(t('connect.inbox.errors.loadThread', 'Could not load the conversation'))
        setThreadLoading(false)
        return
      }
      const result = response.result ?? {}
      setThreadItems((previous) => (cursor ? [...(result.items ?? []), ...previous] : result.items ?? []))
      setThreadCursor(result.nextCursor ?? null)
      setThreadBinding(result.binding ?? null)
      setThreadLoading(false)
    },
    [t],
  )

  const selectCase = React.useCallback(
    (caseId: string) => {
      setSelectedId(caseId)
      setThreadItems([])
      setThreadCursor(null)
      setReadOnlyReason(null)
      setComposerError(null)
      setLastStatus(null)
      setLastAttemptId(null)
      // A draft belongs to its Case, so switching away keeps neither the text
      // nor the command key of the previous one.
      setDraft('')
      setCommandKey(null)
      void loadThread(caseId, null)
      void apiCall(`/api/connect/cases/${caseId}/read`, { method: 'POST' }).catch(() => null)
      // Move focus to the conversation so keyboard users land where the content
      // changed rather than at the top of the page.
      window.setTimeout(() => headingRef.current?.focus(), 0)
    },
    [loadThread],
  )

  // ── Actions ──────────────────────────────────────────────
  const claim = React.useCallback(
    async (caseId: string) => {
      const row = rows.find((candidate) => candidate.id === caseId)
      try {
        await runMutation({
          context: { caseId, retryLastMutation },
          mutationPayload: { caseId },
          operation: async () => {
            const response = await apiCall<{ error?: string }>(
              `/api/connect/cases/${caseId}/assign`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  assigneeUserId: currentUserId,
                  expectedUpdatedAt: row?.updatedAt,
                }),
              },
            )
            if (!response.ok) {
              throw new Error(
                response.result?.error ?? t('connect.inbox.errors.claim', 'Could not claim this case'),
              )
            }
            return response.result
          },
        })
        reload()
      } catch (err) {
        setListError(err instanceof Error ? err.message : t('connect.inbox.errors.claim', 'Could not claim this case'))
      }
    },
    [currentUserId, reload, retryLastMutation, rows, runMutation, t],
  )

  const send = React.useCallback(async () => {
    if (!selected || !threadItems) return
    const conversationId = threadItems.find((item) => item.externalConversationId)?.externalConversationId
    if (!conversationId) {
      setComposerError(
        t('connect.inbox.errors.noConversation', 'This case has no conversation to reply to yet.'),
      )
      return
    }
    // Minted once per draft and NEVER rotated on a timeout: that is what makes
    // a lost 202 resolvable without sending twice.
    const key = commandKey ?? crypto.randomUUID()
    if (!commandKey) setCommandKey(key)

    setIsSending(true)
    setComposerError(null)
    try {
      const submission = await runMutation<ComposerSubmission>({
        context: { caseId: selected.id, retryLastMutation },
        mutationPayload: { caseId: selected.id },
        operation: async () => {
          const response = await apiCall<ComposerSubmission & { error?: string }>(
            `/api/connect/cases/${selected.id}/messages`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ conversationId, clientCommandKey: key, body: draft }),
            },
          )
          if (!response.ok || !response.result) {
            throw new Error(
              response.result?.error ?? t('connect.inbox.errors.send', 'Could not queue the reply'),
            )
          }
          return response.result
        },
      })
      setLastStatus('queued')
      setLastAttemptId(submission.attemptId)
      setMaskedRecipientLabel(submission.maskedRecipientLabel)
      // Only a confirmed 202 clears the draft and its key.
      setDraft('')
      setCommandKey(null)
    } catch (err) {
      setComposerError(err instanceof Error ? err.message : t('connect.inbox.errors.send', 'Could not queue the reply'))
    } finally {
      setIsSending(false)
    }
  }, [commandKey, draft, retryLastMutation, runMutation, selected, t, threadItems])

  const retrySend = React.useCallback(async () => {
    if (!selected || !lastAttemptId) return
    const confirmed = await confirm({
      title: t('connect.delivery.retryTitle', 'Send this reply again?'),
      description: t(
        'connect.delivery.retryDescription',
        'The provider rejected the previous attempt, so nothing reached the customer. This creates a new attempt.',
      ),
      confirmText: t('connect.delivery.retry', 'Retry sending'),
    })
    if (!confirmed) return
    const response = await apiCall<{ error?: string }>(
      `/api/connect/cases/${selected.id}/messages/${lastAttemptId}/retry`,
      { method: 'POST' },
    ).catch(() => null)
    if (!response || !response.ok) {
      setComposerError(
        response?.result?.error ?? t('connect.inbox.errors.retry', 'Could not retry this delivery'),
      )
      return
    }
    setLastStatus('queued')
  }, [confirm, lastAttemptId, selected, t])

  const runLifecycle = React.useCallback(
    async (action: 'resolve' | 'reopen' | 'close', wrapUp?: string) => {
      if (!selected) return
      const response = await apiCall<{ error?: string }>(
        `/api/connect/cases/${selected.id}/${action}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ wrapUp, expectedUpdatedAt: selected.updatedAt }),
        },
      ).catch(() => null)
      if (!response || !response.ok) {
        setComposerError(
          response?.result?.error ?? t('connect.inbox.errors.lifecycle', 'Could not change the case'),
        )
        return
      }
      reload()
    },
    [reload, selected, t],
  )

  const resolve = React.useCallback(async () => {
    // A resolution with no wrap-up is unreviewable, so the note is collected
    // before the request rather than surfacing a server error.
    const note = window.prompt(t('connect.inbox.actions.wrapUpPrompt', 'Add a wrap-up note'))
    if (!note || !note.trim()) return
    await runLifecycle('resolve', note)
  }, [runLifecycle, t])

  const closeCase = React.useCallback(async () => {
    const confirmed = await confirm({
      title: t('connect.inbox.actions.closeTitle', 'Close this case?'),
      description: t(
        'connect.inbox.actions.closeDescription',
        'Closing is final. A new message from the customer opens a new case instead of reopening this one.',
      ),
      variant: 'destructive',
      confirmText: t('connect.inbox.actions.close', 'Close'),
    })
    if (confirmed) await runLifecycle('close')
  }, [confirm, runLifecycle, t])

  const isOwner = selected?.assigneeUserId === currentUserId
  const canSend = Boolean(selected) && isOwner && selected?.status !== 'closed' && !readOnlyReason
  const disabledReason = !selected
    ? null
    : readOnlyReason
      ? null
      : selected.status === 'closed'
        ? t('connect.inbox.composer.closed', 'This case is closed.')
        : !isOwner
          ? t('connect.inbox.composer.notOwner', 'Claim this case before replying.')
          : null

  return (
    <div className="grid h-[calc(100vh-12rem)] grid-cols-1 gap-0 lg:grid-cols-[minmax(18rem,1fr)_minmax(0,2fr)_minmax(20rem,1fr)]">
      <CaseListPane
        rows={rows}
        filter={filter}
        onFilterChange={setFilter}
        selectedId={selectedId}
        onSelect={selectCase}
        onClaim={(caseId) => void claim(caseId)}
        isLoading={listLoading}
        error={listError}
        stale={listStale}
        onRetry={reload}
        canSeeAll={canSeeAll}
        currentUserId={currentUserId}
      />
      <ThreadPane
        items={threadItems}
        isLoading={threadLoading}
        error={threadError}
        binding={threadBinding}
        readOnlyReason={readOnlyReason}
        hasMore={Boolean(threadCursor)}
        onLoadMore={() => selectedId && void loadThread(selectedId, threadCursor)}
        onRetryItem={() => selectedId && void loadThread(selectedId, null)}
        headingRef={headingRef}
      />
      <ComposerPane
        selected={selected}
        maskedRecipientLabel={maskedRecipientLabel}
        canSend={canSend}
        disabledReason={disabledReason}
        draft={draft}
        onDraftChange={setDraft}
        onSend={() => void send()}
        isSending={isSending}
        lastStatus={lastStatus}
        lastError={composerError}
        canRetry={lastStatus === 'failed'}
        onRetry={() => void retrySend()}
        onResolve={() => void resolve()}
        onReopen={() => void runLifecycle('reopen')}
        onClose={() => void closeCase()}
        canClose={canClose}
      />
      {ConfirmDialogElement}
    </div>
  )
}

export default ConnectInboxPage

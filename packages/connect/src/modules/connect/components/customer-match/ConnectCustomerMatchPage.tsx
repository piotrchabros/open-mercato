'use client'

import * as React from 'react'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { Button } from '@open-mercato/ui/primitives/button'
import { EmptyState } from '@open-mercato/ui/primitives/empty-state'
import { LoadingMessage, ErrorMessage } from '@open-mercato/ui/backend/detail'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { CandidateSearchPane } from './CandidateSearchPane'
import { UnlinkDialog } from './UnlinkDialog'
import type {
  CandidateKind,
  CandidateRow,
  ManualMatchListResponse,
  ManualMatchRow,
  UnlinkStatus,
} from './types'

/**
 * The manual customer-matching workflow.
 *
 * Queue on the left, candidate search on the right, one explicit confirmation
 * in between. Everything an agent sees about the unmatched contact is the
 * MASKED handle — the real value is encrypted and is not something a matching
 * screen needs in order to pick the right customer.
 *
 * While an unlink is undecided, the link controls for that identity are
 * disabled and the row shows resumable progress. That is not decoration: the
 * command rejects a link taken mid-unlink, so offering the control would only
 * produce a confusing failure. A lost response is recovered by polling
 * `unlink-status`; reloading the page resumes the same state.
 */

const UNLINK_POLL_MS = 4000

type Props = {
  canLink: boolean
  canUnlink: boolean
  canRecover: boolean
}

export function ConnectCustomerMatchPage({ canLink, canUnlink, canRecover }: Props) {
  const t = useT()
  const headingRef = React.useRef<HTMLHeadingElement>(null)

  const [rows, setRows] = React.useState<ManualMatchRow[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [listError, setListError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)

  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [kind, setKind] = React.useState<CandidateKind>('person')
  const [candidate, setCandidate] = React.useState<CandidateRow | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  const [unlinkOpen, setUnlinkOpen] = React.useState(false)
  const [unlinkStatus, setUnlinkStatus] = React.useState<UnlinkStatus | null>(null)

  const { runMutation, retryLastMutation } = useGuardedMutation({ contextId: 'connect.customer-match' })
  const reload = React.useCallback(() => setReloadToken((token) => token + 1), [])

  React.useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    void (async () => {
      const response = await apiCall<ManualMatchListResponse>(
        '/api/connect/manual-matches?status=open&pageSize=50',
      ).catch(() => null)
      if (cancelled) return
      if (!response || !response.ok) {
        setListError(t('connect.customerMatch.errors.loadQueue', 'Could not load the matching queue'))
      } else {
        setRows(response.result?.items ?? [])
        setListError(null)
      }
      setIsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [reloadToken, t])

  const selected = React.useMemo(
    () => rows.find((row) => row.identityId === selectedId) ?? null,
    [rows, selectedId],
  )

  // Poll only while this identity's unlink is undecided. A decided saga cannot
  // change again, so continuing to poll would be pure noise.
  React.useEffect(() => {
    if (!canRecover || !selected?.unlinkInProgress) {
      setUnlinkStatus(null)
      return
    }
    let cancelled = false
    const identityId = selected.identityId
    async function poll() {
      const response = await apiCall<UnlinkStatus>(
        `/api/connect/contact-identities/${identityId}/unlink-status`,
      ).catch(() => null)
      if (cancelled || !response?.ok || !response.result) return
      setUnlinkStatus(response.result)
      if (!response.result.unlinkInProgress) reload()
    }
    void poll()
    const timer = window.setInterval(poll, UNLINK_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [canRecover, reload, selected])

  const restoreFocus = React.useCallback(() => {
    headingRef.current?.focus()
  }, [])

  const link = React.useCallback(async () => {
    if (!selected || !candidate) return
    setIsSubmitting(true)
    setActionError(null)
    try {
      await runMutation({
        context: { identityId: selected.identityId, retryLastMutation },
        mutationPayload: { identityId: selected.identityId, customerKind: kind },
        operation: async () => {
          const response = await apiCall<{ error?: string }>(
            `/api/connect/contact-identities/${selected.identityId}/link`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                customerKind: kind,
                customerId: candidate.id,
                // Own-row version: the identity, not the queue task, is what the
                // link command mutates.
                expectedUpdatedAt: selected.identityUpdatedAt ?? undefined,
              }),
            },
          )
          if (!response.ok) {
            throw new Error(
              response.result?.error ?? t('connect.customerMatch.errors.link', 'Could not link this contact'),
            )
          }
          return response.result
        },
      })
      setCandidate(null)
      setSelectedId(null)
      reload()
      restoreFocus()
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t('connect.customerMatch.errors.link', 'Could not link this contact'),
      )
      restoreFocus()
    } finally {
      setIsSubmitting(false)
    }
  }, [candidate, kind, reload, restoreFocus, retryLastMutation, runMutation, selected, t])

  const unlink = React.useCallback(
    async (reason: string) => {
      if (!selected) return
      setIsSubmitting(true)
      setActionError(null)
      try {
        await runMutation({
          context: { identityId: selected.identityId, retryLastMutation },
          mutationPayload: { identityId: selected.identityId, action: 'unlink' },
          operation: async () => {
            const response = await apiCall<{ error?: string }>(
              `/api/connect/contact-identities/${selected.identityId}/unlink`,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  reason,
                  expectedUpdatedAt: selected.identityUpdatedAt ?? undefined,
                }),
              },
            )
            if (!response.ok) {
              throw new Error(
                response.result?.error ??
                  t('connect.customerMatch.errors.unlink', 'Could not unlink this contact'),
              )
            }
            return response.result
          },
        })
        setUnlinkOpen(false)
        reload()
        restoreFocus()
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : t('connect.customerMatch.errors.unlink', 'Could not unlink this contact'),
        )
      } finally {
        setIsSubmitting(false)
      }
    },
    [reload, restoreFocus, retryLastMutation, runMutation, selected, t],
  )

  const linkDisabled = !canLink || !candidate || isSubmitting || Boolean(selected?.unlinkInProgress)

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section aria-label={t('connect.customerMatch.queue.aria', 'Matching queue')} className="min-h-0">
        <h2 ref={headingRef} tabIndex={-1} className="mb-2 text-sm font-medium">
          {t('connect.customerMatch.queue.title', 'Contacts awaiting a match')}
        </h2>
        {isLoading ? (
          <LoadingMessage label={t('connect.customerMatch.queue.loading', 'Loading queue...')} />
        ) : listError ? (
          <ErrorMessage
            label={listError}
            action={
              <Button type="button" size="sm" variant="outline" onClick={reload}>
                {t('connect.customerMatch.actions.retry', 'Retry')}
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={t('connect.customerMatch.queue.emptyTitle', 'Nothing to match')}
            description={t(
              'connect.customerMatch.queue.emptyDescription',
              'Contacts appear here when Connect cannot match them to a customer on its own.',
            )}
          />
        ) : (
          <ul>
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  aria-current={row.identityId === selectedId}
                  onClick={() => {
                    setSelectedId(row.identityId)
                    setCandidate(null)
                    setActionError(null)
                  }}
                  className={`flex w-full flex-col items-start gap-0.5 border-b border-border p-3 text-left text-sm ${
                    row.identityId === selectedId ? 'bg-accent' : 'hover:bg-accent'
                  }`}
                >
                  <span className="font-medium">
                    {row.handleDisplayLabel ?? t('connect.customerMatch.queue.unknownHandle', 'Unknown contact')}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {row.handleType ?? '—'} · {new Date(row.createdAt).toLocaleString()}
                  </span>
                  {row.unlinkInProgress ? (
                    <span className="text-xs text-status-warning-base">
                      {t('connect.customerMatch.unlink.inProgress', 'Unlink in progress')}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={t('connect.customerMatch.match.aria', 'Match a customer')} className="min-h-0">
        {!selected ? (
          <EmptyState title={t('connect.customerMatch.match.noSelection', 'Select a contact to match')} />
        ) : (
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">
              {t('connect.customerMatch.match.title', 'Match {handle}').replace(
                '{handle}',
                selected.handleDisplayLabel ?? t('connect.customerMatch.queue.unknownHandle', 'Unknown contact'),
              )}
            </h2>

            {selected.unlinkInProgress ? (
              <div
                role="status"
                aria-live="polite"
                className="rounded-md border border-border bg-status-warning-lighter p-3 text-xs text-status-warning-base"
              >
                {t(
                  'connect.customerMatch.unlink.pending',
                  'An unlink is still running for this contact. Linking is unavailable until it settles.',
                )}
                {unlinkStatus ? (
                  <>
                    {' '}
                    {t('connect.customerMatch.unlink.state', 'State: {state}').replace(
                      '{state}',
                      t(`connect.customerMatch.unlink.states.${unlinkStatus.state}`, unlinkStatus.state),
                    )}
                    {unlinkStatus.failedFinalizeCount ? (
                      <>
                        {' '}
                        {t(
                          'connect.customerMatch.unlink.finalizeFailed',
                          '{count} retractions need operator attention.',
                        ).replace('{count}', String(unlinkStatus.failedFinalizeCount))}
                      </>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}

            {actionError ? <ErrorMessage label={actionError} /> : null}

            <CandidateSearchPane
              kind={kind}
              onKindChange={setKind}
              selectedId={candidate?.id ?? null}
              onSelect={setCandidate}
              disabled={!canLink || isSubmitting || selected.unlinkInProgress}
            />

            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={linkDisabled} onClick={() => void link()}>
                {t('connect.customerMatch.actions.link', 'Link customer')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCandidate(null)
                  restoreFocus()
                }}
                disabled={isSubmitting}
              >
                {t('connect.customerMatch.actions.cancel', 'Cancel')}
              </Button>
              {canUnlink ? (
                <Button
                  type="button"
                  variant="destructive"
                  disabled={isSubmitting || selected.unlinkInProgress}
                  onClick={() => setUnlinkOpen(true)}
                >
                  {t('connect.customerMatch.actions.unlink', 'Unlink')}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </section>

      <UnlinkDialog
        open={unlinkOpen}
        onOpenChange={(open) => {
          setUnlinkOpen(open)
          if (!open) restoreFocus()
        }}
        onConfirm={unlink}
        isSubmitting={isSubmitting}
        maskedHandle={selected?.handleDisplayLabel ?? null}
      />
    </div>
  )
}

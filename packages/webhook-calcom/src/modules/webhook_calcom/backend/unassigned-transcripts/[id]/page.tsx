"use client"

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { ErrorMessage, LoadingMessage, RecordNotFoundState } from '@open-mercato/ui/backend/detail'
import { FormHeader } from '@open-mercato/ui/backend/forms'
import { apiCall, apiCallOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { Alert, AlertDescription, AlertTitle } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { AssignTranscriptDialog } from '../../../components/AssignTranscriptDialog'
import { useTranscriptInboxAccess } from '../../../components/useTranscriptInboxAccess'
import {
  UNASSIGNED_TRANSCRIPTS_API_PATH,
  UNASSIGNED_TRANSCRIPTS_BACKEND_PATH,
  UNASSIGNED_TRANSCRIPT_RESOURCE_KIND,
  buildPersonHref,
  formatParticipant,
  formatTranscriptDateTime,
  transcriptStatusVariant,
  translateTranscriptReason,
  translateTranscriptSource,
  translateTranscriptStatus,
  type UnassignedTranscriptDetail,
} from '../../../components/transcriptInbox'

type DismissMutationContext = {
  formId: string
  resourceKind: string
  resourceId: string
  retryLastMutation: () => Promise<boolean>
}

type FactProps = {
  label: string
  children: React.ReactNode
}

function Fact({ label, children }: FactProps) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium uppercase text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  )
}

export default function UnassignedTranscriptDetailPage({ params }: { params?: { id?: string } }) {
  const t = useT()
  const router = useRouter()
  const id = params?.id ?? ''
  const access = useTranscriptInboxAccess()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [transcript, setTranscript] = React.useState<UnassignedTranscriptDetail | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [isNotFound, setIsNotFound] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [reloadToken, setReloadToken] = React.useState(0)
  const [assignOpen, setAssignOpen] = React.useState(false)
  const [isDismissing, setIsDismissing] = React.useState(false)

  const mutationContextId = 'webhook_calcom-unassigned-transcript:dismiss'
  const { runMutation, retryLastMutation } = useGuardedMutation<DismissMutationContext>({
    contextId: mutationContextId,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  React.useEffect(() => {
    let cancelled = false
    async function load() {
      if (!id) {
        setIsNotFound(true)
        setIsLoading(false)
        return
      }
      setIsLoading(true)
      try {
        const call = await apiCall<UnassignedTranscriptDetail>(
          `${UNASSIGNED_TRANSCRIPTS_API_PATH}/${encodeURIComponent(id)}`,
          undefined,
          { fallback: null },
        )
        if (cancelled) return
        if (call.status === 404) {
          setIsNotFound(true)
          setTranscript(null)
          return
        }
        if (!call.ok || !call.result) {
          const errorPayload = call.result as { error?: string } | null
          setError(
            typeof errorPayload?.error === 'string'
              ? errorPayload.error
              : t('webhook_calcom.inbox.detail.loadError', 'Failed to load the transcript'),
          )
          return
        }
        setError(null)
        setIsNotFound(false)
        setTranscript(call.result)
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error && err.message
              ? err.message
              : t('webhook_calcom.inbox.detail.loadError', 'Failed to load the transcript'),
          )
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [id, reloadToken, t])

  const handleDismiss = React.useCallback(async () => {
    if (!transcript) return
    const confirmed = await confirm({
      title: t('webhook_calcom.inbox.dismiss.confirmTitle', 'Dismiss this transcript?'),
      text: t(
        'webhook_calcom.inbox.dismiss.confirmDescription',
        'The transcript is removed from the inbox and is not attached to any person.',
      ),
      confirmText: t('webhook_calcom.inbox.actions.dismiss', 'Dismiss'),
      variant: 'destructive',
    })
    if (!confirmed) return
    setIsDismissing(true)
    try {
      await runMutation({
        operation: () =>
          withScopedApiRequestHeaders(buildOptimisticLockHeader(transcript.updatedAt), () =>
            apiCallOrThrow(
              `${UNASSIGNED_TRANSCRIPTS_API_PATH}?id=${encodeURIComponent(transcript.id)}`,
              { method: 'DELETE' },
              { errorMessage: t('webhook_calcom.inbox.dismiss.error', 'Failed to dismiss the transcript') },
            ),
          ),
        context: {
          formId: mutationContextId,
          resourceKind: UNASSIGNED_TRANSCRIPT_RESOURCE_KIND,
          resourceId: transcript.id,
          retryLastMutation,
        },
        mutationPayload: { id: transcript.id },
      })
      flash(t('webhook_calcom.inbox.dismiss.success', 'Transcript dismissed'), 'success')
      router.push(UNASSIGNED_TRANSCRIPTS_BACKEND_PATH)
    } catch (err) {
      if (!surfaceRecordConflict(err, t, { onRefresh: () => setReloadToken((token) => token + 1) })) {
        flash(
          err instanceof Error && err.message
            ? err.message
            : t('webhook_calcom.inbox.dismiss.error', 'Failed to dismiss the transcript'),
          'error',
        )
      }
    } finally {
      setIsDismissing(false)
    }
  }, [confirm, retryLastMutation, router, runMutation, t, transcript])

  if (isLoading) {
    return (
      <Page>
        <PageBody>
          <LoadingMessage label={t('webhook_calcom.inbox.detail.loading', 'Loading transcript…')} />
        </PageBody>
      </Page>
    )
  }
  if (isNotFound) {
    return (
      <Page>
        <PageBody>
          <RecordNotFoundState
            label={t('webhook_calcom.inbox.errors.notFound', 'Transcript not found')}
            backHref={UNASSIGNED_TRANSCRIPTS_BACKEND_PATH}
            backLabel={t('webhook_calcom.inbox.detail.backToList', 'Back to unassigned transcripts')}
          />
        </PageBody>
      </Page>
    )
  }
  if (error || !transcript) {
    return (
      <Page>
        <PageBody>
          <ErrorMessage label={error ?? t('webhook_calcom.inbox.detail.loadError', 'Failed to load the transcript')} />
        </PageBody>
      </Page>
    )
  }

  const isPending = transcript.status === 'pending'
  const startedAt = formatTranscriptDateTime(transcript.meetingStartedAt)
  const endedAt = formatTranscriptDateTime(transcript.meetingEndedAt)
  const meetingTime = startedAt && endedAt ? `${startedAt} – ${endedAt}` : startedAt ?? '—'
  const resolvedPersonId = transcript.resolvedEntityId

  const headerActions = isPending && (access.canAssign || access.canManage) ? (
    <div className="flex items-center gap-2">
      {access.canManage ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void handleDismiss()
          }}
          disabled={isDismissing}
        >
          {t('webhook_calcom.inbox.actions.dismiss', 'Dismiss')}
        </Button>
      ) : null}
      {access.canAssign ? (
        <Button type="button" onClick={() => setAssignOpen(true)} disabled={isDismissing}>
          {t('webhook_calcom.inbox.actions.assign', 'Assign to person')}
        </Button>
      ) : null}
    </div>
  ) : undefined

  return (
    <Page>
      <PageBody className="space-y-6">
        <FormHeader
          mode="detail"
          title={transcript.title || t('webhook_calcom.inbox.untitled', 'Untitled meeting')}
          entityTypeLabel={t('webhook_calcom.inbox.detail.title', 'Unassigned transcript')}
          statusBadge={
            <StatusBadge variant={transcriptStatusVariant(transcript.status)} dot>
              {translateTranscriptStatus(t, transcript.status)}
            </StatusBadge>
          }
          backHref={UNASSIGNED_TRANSCRIPTS_BACKEND_PATH}
          actionsContent={headerActions}
        />

        {transcript.status === 'resolved' ? (
          <Alert status="success">
            <AlertTitle>{t('webhook_calcom.inbox.detail.resolvedTitle', 'Transcript assigned')}</AlertTitle>
            <AlertDescription>
              <span>
                {t(
                  'webhook_calcom.inbox.detail.resolvedDescription',
                  'The transcript was attached to the meeting in the person\'s activity history.',
                )}
              </span>
              {resolvedPersonId && access.canViewPeople ? (
                <>
                  {' '}
                  <Link href={buildPersonHref(resolvedPersonId)} className="font-medium underline">
                    {t('webhook_calcom.inbox.detail.openPersonMeeting', 'Open the person and meeting')}
                  </Link>
                </>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <section className="rounded-lg border border-border bg-card p-4">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label={t('webhook_calcom.inbox.detail.meetingTime', 'Meeting time')}>{meetingTime}</Fact>
            <Fact label={t('webhook_calcom.inbox.columns.source', 'Source')}>
              {translateTranscriptSource(t, transcript.source)}
            </Fact>
            <Fact label={t('webhook_calcom.inbox.columns.reason', 'Reason')}>
              {translateTranscriptReason(t, transcript.reason)}
            </Fact>
            <Fact label={t('webhook_calcom.inbox.detail.organizer', 'Organizer')}>
              {transcript.organizerEmail ?? '—'}
            </Fact>
            <Fact label={t('webhook_calcom.inbox.columns.received', 'Received')}>
              {formatTranscriptDateTime(transcript.createdAt) ?? '—'}
            </Fact>
            <Fact label={t('webhook_calcom.inbox.columns.participants', 'Participants')}>
              {transcript.participants.length > 0 ? (
                <ul className="space-y-0.5">
                  {transcript.participants.map((participant) => (
                    <li key={participant.email} className="break-all">
                      {formatParticipant(participant)}
                    </li>
                  ))}
                </ul>
              ) : (
                t('webhook_calcom.inbox.detail.noParticipants', 'No participants besides the organizer')
              )}
            </Fact>
          </dl>
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold">{t('webhook_calcom.inbox.detail.summary', 'Summary')}</h2>
          {transcript.summaryText ? (
            <p className="whitespace-pre-wrap text-sm text-foreground">{transcript.summaryText}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('webhook_calcom.inbox.detail.noSummary', 'No summary is available for this meeting.')}
            </p>
          )}
        </section>

        <section className="space-y-2">
          <h2 className="text-base font-semibold">{t('webhook_calcom.inbox.detail.transcript', 'Transcript preview')}</h2>
          {transcript.transcriptPreview ? (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-4 font-mono text-xs text-foreground">
              {transcript.transcriptPreview}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('webhook_calcom.inbox.detail.noTranscript', 'The transcript has no passages.')}
            </p>
          )}
          {transcript.transcriptPreviewTruncated ? (
            <p className="text-xs text-muted-foreground">
              {t(
                'webhook_calcom.inbox.detail.truncated',
                'Only the beginning of the transcript is shown. The full transcript is attached to the meeting after assignment.',
              )}
            </p>
          ) : null}
        </section>
      </PageBody>
      {ConfirmDialogElement}
      <AssignTranscriptDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        transcript={transcript}
        onAssigned={() => {
          setAssignOpen(false)
          setReloadToken((token) => token + 1)
        }}
      />
    </Page>
  )
}

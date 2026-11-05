'use client'

import * as React from 'react'
import { History, RotateCcw } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { Tag } from '@open-mercato/ui/primitives/tag'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall, apiCallOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useConfirmDialog } from '@open-mercato/ui/backend/confirm-dialog'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import type { OfferDto, OfferRevisionSource, RevisionDto } from './types'

const RESTORE_MUTATION_CONTEXT_ID = 'offer_generator-offer-detail:restore'

const SOURCE_FALLBACKS: Record<OfferRevisionSource, string> = {
  generate: 'AI generation',
  refine: 'AI refinement',
  manual_edit: 'Manual edit',
  restore: 'Restore',
}

type RestoreMutationContext = {
  formId: string
  resourceKind: string
  resourceId: string
  retryLastMutation: () => Promise<boolean>
}

export type RevisionsListProps = {
  offer: OfferDto
  canManage: boolean
  locked: boolean
  onRestored: () => void | Promise<void>
  onConflict?: () => void
}

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : ''
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function RevisionsList({ offer, canManage, locked, onRestored, onConflict }: RevisionsListProps) {
  const t = useT()
  const { confirm, ConfirmDialogElement } = useConfirmDialog()
  const [revisions, setRevisions] = React.useState<RevisionDto[]>([])
  const [loading, setLoading] = React.useState(true)
  const [failed, setFailed] = React.useState(false)
  const [restoringId, setRestoringId] = React.useState<string | null>(null)
  const { runMutation, retryLastMutation } = useGuardedMutation<RestoreMutationContext>({
    contextId: RESTORE_MUTATION_CONTEXT_ID,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    apiCall<{ items: RevisionDto[] }>(
      `/api/offer_generator/offers/${encodeURIComponent(offer.id)}/revisions`,
      undefined,
      { fallback: null },
    )
      .then((call) => {
        if (cancelled) return
        if (call.ok && call.result) {
          setRevisions(call.result.items ?? [])
          setFailed(false)
        } else {
          setFailed(true)
        }
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
  }, [offer.htmlUpdatedAt, offer.id])

  const sourceLabel = React.useCallback(
    (source: OfferRevisionSource) => t(`offer_generator.revisions.sources.${source}`, SOURCE_FALLBACKS[source] ?? source),
    [t],
  )

  const handleRestore = React.useCallback(
    async (revision: RevisionDto) => {
      if (restoringId) return
      const confirmed = await confirm({
        title: t('offer_generator.revisions.restoreConfirmTitle', 'Restore this version?'),
        text: t(
          'offer_generator.revisions.restoreConfirmText',
          'The current content is kept as a new revision, so you can undo this later.',
        ),
        confirmText: t('offer_generator.revisions.restore', 'Restore'),
      })
      if (!confirmed) return
      setRestoringId(revision.id)
      const payload = { revisionId: revision.id }
      try {
        await runMutation({
          operation: () =>
            withScopedApiRequestHeaders(buildOptimisticLockHeader(offer.updatedAt), () =>
              apiCallOrThrow(
                `/api/offer_generator/offers/${encodeURIComponent(offer.id)}/revisions`,
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(payload),
                },
                { errorMessage: t('offer_generator.revisions.restoreError', 'Failed to restore the version.') },
              ),
            ),
          context: {
            formId: RESTORE_MUTATION_CONTEXT_ID,
            resourceKind: 'offer_generator.offer',
            resourceId: offer.id,
            retryLastMutation,
          },
          mutationPayload: payload,
        })
        flash(t('offer_generator.revisions.restored', 'Version restored.'), 'success')
        await onRestored()
      } catch (err) {
        if (surfaceRecordConflict(err, t, { onRefresh: onConflict })) return
        const message =
          err instanceof Error && err.message
            ? err.message
            : t('offer_generator.revisions.restoreError', 'Failed to restore the version.')
        flash(message, 'error')
      } finally {
        setRestoringId(null)
      }
    },
    [confirm, offer.id, offer.updatedAt, onConflict, onRestored, restoringId, retryLastMutation, runMutation, t],
  )

  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <History className="size-4" />
        {t('offer_generator.revisions.title', 'Revision history')}
      </h2>
      {loading && revisions.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="sm" />
          {t('offer_generator.revisions.loading', 'Loading revisions...')}
        </div>
      ) : failed ? (
        <p className="text-sm text-status-error-text">
          {t('offer_generator.revisions.loadError', 'Failed to load revisions.')}
        </p>
      ) : revisions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('offer_generator.revisions.empty', 'No earlier versions yet. Each AI run and manual edit keeps the previous version here.')}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {revisions.map((revision) => (
            <li key={revision.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Tag>{sourceLabel(revision.source)}</Tag>
                  <span className="text-sm">{formatDateTime(revision.createdAt)}</span>
                  <span className="text-xs text-muted-foreground">{formatSize(revision.sizeBytes)}</span>
                </div>
                {revision.feedback ? (
                  <p className="line-clamp-2 text-xs text-muted-foreground">{revision.feedback}</p>
                ) : null}
              </div>
              {canManage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleRestore(revision)}
                  disabled={locked || restoringId !== null}
                >
                  <RotateCcw />
                  {restoringId === revision.id
                    ? t('offer_generator.revisions.restoring', 'Restoring...')
                    : t('offer_generator.revisions.restore', 'Restore')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {ConfirmDialogElement}
    </section>
  )
}

export default RevisionsList

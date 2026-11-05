'use client'

import * as React from 'react'
import { ExternalLink, Pencil, Save, X } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCallOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { OfferPreviewFrame, buildOfferPreviewUrl } from './OfferPreviewFrame'
import {
  applyEditMode,
  countEditedElementsInDocument,
  disableEditMode,
  extractEditedHtml,
  type InlineEditLabels,
} from './inline-edit'
import type { OfferDto } from './types'

const SAVE_MUTATION_CONTEXT_ID = 'offer_generator-offer-detail:html'

type SaveMutationContext = {
  formId: string
  resourceKind: string
  resourceId: string
  retryLastMutation: () => Promise<boolean>
}

export type OfferContentEditorProps = {
  offer: OfferDto
  canManage: boolean
  locked: boolean
  onSaved: () => void | Promise<void>
  onConflict?: () => void
}

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

export function OfferContentEditor({ offer, canManage, locked, onSaved, onConflict }: OfferContentEditorProps) {
  const t = useT()
  const frameRef = React.useRef<HTMLIFrameElement | null>(null)
  const [editing, setEditing] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [reloadKey, setReloadKey] = React.useState(0)
  const [editedCount, setEditedCount] = React.useState(0)
  const { runMutation, retryLastMutation } = useGuardedMutation<SaveMutationContext>({
    contextId: SAVE_MUTATION_CONTEXT_ID,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  const labels = React.useMemo<InlineEditLabels>(() => ({
    bold: t('offer_generator.detail.editor.toolbar.bold', 'Bold (Ctrl+B)'),
    italic: t('offer_generator.detail.editor.toolbar.italic', 'Italic (Ctrl+I)'),
    underline: t('offer_generator.detail.editor.toolbar.underline', 'Underline (Ctrl+U)'),
    link: t('offer_generator.detail.editor.toolbar.link', 'Insert link'),
    unlink: t('offer_generator.detail.editor.toolbar.unlink', 'Remove link'),
    clearFormatting: t('offer_generator.detail.editor.toolbar.clearFormatting', 'Clear formatting'),
    linkPrompt: t('offer_generator.detail.editor.toolbar.linkPrompt', 'Link URL:'),
  }), [t])

  const readEditedCount = React.useCallback(() => {
    const doc = frameRef.current?.contentDocument
    setEditedCount(doc ? countEditedElementsInDocument(doc) : 0)
  }, [])

  const handleFrameLoad = React.useCallback(() => {
    setEditing(false)
    readEditedCount()
  }, [readEditedCount])

  React.useEffect(() => {
    if (locked && editing) {
      const doc = frameRef.current?.contentDocument
      if (doc) disableEditMode(doc)
      setEditing(false)
      setReloadKey((key) => key + 1)
    }
  }, [editing, locked])

  const startEditing = React.useCallback(() => {
    const doc = frameRef.current?.contentDocument
    if (!doc) return
    applyEditMode(doc, labels)
    setEditing(true)
  }, [labels])

  const cancelEditing = React.useCallback(() => {
    const doc = frameRef.current?.contentDocument
    if (doc) disableEditMode(doc)
    setEditing(false)
    setReloadKey((key) => key + 1)
  }, [])

  const saveEdits = React.useCallback(async () => {
    const doc = frameRef.current?.contentDocument
    if (!doc || saving) return
    const html = extractEditedHtml(doc)
    setSaving(true)
    try {
      await runMutation({
        operation: () =>
          withScopedApiRequestHeaders(buildOptimisticLockHeader(offer.updatedAt), () =>
            apiCallOrThrow(
              `/api/offer_generator/offers/${encodeURIComponent(offer.id)}/html`,
              {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ html }),
              },
              { errorMessage: t('offer_generator.detail.editor.saveError', 'Failed to save the changes.') },
            ),
          ),
        context: {
          formId: SAVE_MUTATION_CONTEXT_ID,
          resourceKind: 'offer_generator.offer',
          resourceId: offer.id,
          retryLastMutation,
        },
        mutationPayload: { html },
      })
      disableEditMode(doc)
      setEditing(false)
      flash(t('offer_generator.detail.editor.saved', 'Changes saved.'), 'success')
      await onSaved()
    } catch (err) {
      if (surfaceRecordConflict(err, t, { onRefresh: onConflict })) return
      const code = readErrorCode(err)
      const message =
        code === 'incomplete_html'
          ? t('offer_generator.detail.editor.incompleteHtml', 'The edited offer is incomplete and was not saved.')
          : err instanceof Error && err.message
            ? err.message
            : t('offer_generator.detail.editor.saveError', 'Failed to save the changes.')
      flash(message, 'error')
    } finally {
      setSaving(false)
    }
  }, [offer.id, offer.updatedAt, onConflict, onSaved, retryLastMutation, runMutation, saving, t])

  const openInNewTab = React.useCallback(() => {
    window.open(buildOfferPreviewUrl(offer.id, offer.htmlUpdatedAt), '_blank', 'noopener,noreferrer')
  }, [offer.htmlUpdatedAt, offer.id])

  if (!offer.hasHtml) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted p-6 text-sm text-muted-foreground">
        {t('offer_generator.detail.editor.empty', 'This offer has no content yet. Generate it with AI below.')}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          {editing
            ? t(
                'offer_generator.detail.editor.editingHint',
                'Click any text in the preview to change it. Select text to format it. Edited fragments are kept when the AI refines the offer.',
              )
            : editedCount > 0
              ? t('offer_generator.detail.editor.editedCount', '{count} manually edited fragments are locked for AI refinement.', {
                  count: editedCount,
                })
              : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <Button type="button" onClick={() => void saveEdits()} disabled={saving}>
                <Save />
                {saving
                  ? t('offer_generator.detail.editor.saving', 'Saving...')
                  : t('offer_generator.detail.editor.save', 'Save changes')}
              </Button>
              <Button type="button" variant="outline" onClick={cancelEditing} disabled={saving}>
                <X />
                {t('offer_generator.detail.editor.cancel', 'Discard changes')}
              </Button>
            </>
          ) : (
            <>
              {canManage ? (
                <Button type="button" variant="outline" onClick={startEditing} disabled={locked}>
                  <Pencil />
                  {t('offer_generator.detail.editor.edit', 'Edit text')}
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={openInNewTab}>
                <ExternalLink />
                {t('offer_generator.detail.editor.openPreview', 'Open preview in new tab')}
              </Button>
            </>
          )}
        </div>
      </div>
      <OfferPreviewFrame
        offerId={offer.id}
        version={offer.htmlUpdatedAt}
        reloadKey={reloadKey}
        title={offer.title}
        frameRef={frameRef}
        onFrameLoad={handleFrameLoad}
      />
    </div>
  )
}

export default OfferContentEditor

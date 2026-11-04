"use client"

import * as React from 'react'
import { Users } from 'lucide-react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { apiCallOrThrow, withScopedApiRequestHeaders } from '@open-mercato/ui/backend/utils/apiCall'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import { surfaceRecordConflict } from '@open-mercato/ui/backend/conflicts'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import {
  LinkEntityDialog,
  type LinkEntityConfirmInput,
} from '@open-mercato/core/modules/customers/components/linking/LinkEntityDialog'
import {
  createPersonLinkAdapter,
  type PersonLinkSettings,
} from '@open-mercato/core/modules/customers/components/linking/adapters/personAdapter'
import {
  UNASSIGNED_TRANSCRIPTS_API_PATH,
  UNASSIGNED_TRANSCRIPT_RESOURCE_KIND,
  type AssignTranscriptResult,
} from './transcriptInbox'

export type AssignTranscriptTarget = {
  id: string
  title: string
  updatedAt: string | null
}

export type AssignTranscriptDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  transcript: AssignTranscriptTarget | null
  onAssigned?: (result: AssignTranscriptResult, personLabel: string | null) => void
}

type AssignMutationContext = {
  formId: string
  resourceKind: string
  resourceId: string
  retryLastMutation: () => Promise<boolean>
}

const NO_INITIAL_SELECTION: string[] = []

export function AssignTranscriptDialog({ open, onOpenChange, transcript, onAssigned }: AssignTranscriptDialogProps) {
  const t = useT()
  const mutationContextId = 'webhook_calcom-unassigned-transcript:assign'
  const { runMutation, retryLastMutation } = useGuardedMutation<AssignMutationContext>({
    contextId: mutationContextId,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  const adapter = React.useMemo(
    () =>
      createPersonLinkAdapter({
        dialogTitle: t('webhook_calcom.inbox.assign.dialogTitle', 'Assign transcript to a person'),
        dialogSubtitle: transcript?.title
          ? t('webhook_calcom.inbox.assign.dialogSubtitleFor', 'Attach "{title}" to the meeting history of one person', {
              title: transcript.title,
            })
          : t('webhook_calcom.inbox.assign.dialogSubtitle', 'Attach the transcript to the meeting history of one person'),
        sectionLabel: t('webhook_calcom.inbox.assign.sectionLabel', 'MATCHING PEOPLE'),
        searchPlaceholder: t('webhook_calcom.inbox.assign.searchPlaceholder', 'Search people…'),
        searchEmptyHint: t('webhook_calcom.inbox.assign.searchEmpty', 'No matching people found.'),
        selectedEmptyHint: t('webhook_calcom.inbox.assign.selectedEmpty', 'Select one person.'),
        confirmButtonLabel: t('webhook_calcom.inbox.assign.confirm', 'Assign'),
        defaultAvatarIcon: <Users className="size-4" />,
      }),
    [t, transcript?.title],
  )

  const handleConfirm = React.useCallback(
    async ({ nextSelectedIds, optionsById }: LinkEntityConfirmInput<PersonLinkSettings>) => {
      if (!transcript) return
      if (nextSelectedIds.length !== 1) {
        flash(t('webhook_calcom.inbox.assign.selectOne', 'Select exactly one person to assign the transcript to.'), 'error')
        throw new Error('[internal] exactly one person must be selected')
      }
      const personId = nextSelectedIds[0]
      const personLabel = optionsById[personId]?.label ?? null
      try {
        const call = await runMutation({
          operation: () =>
            withScopedApiRequestHeaders(buildOptimisticLockHeader(transcript.updatedAt), () =>
              apiCallOrThrow<AssignTranscriptResult>(
                `${UNASSIGNED_TRANSCRIPTS_API_PATH}/${encodeURIComponent(transcript.id)}/assign`,
                {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ personId }),
                },
                { errorMessage: t('webhook_calcom.inbox.errors.assignFailed', 'Failed to assign the transcript') },
              ),
            ),
          context: {
            formId: mutationContextId,
            resourceKind: UNASSIGNED_TRANSCRIPT_RESOURCE_KIND,
            resourceId: transcript.id,
            retryLastMutation,
          },
          mutationPayload: { id: transcript.id, personId },
        })
        const result = call.result
        if (!result) throw new Error(t('webhook_calcom.inbox.errors.assignFailed', 'Failed to assign the transcript'))
        if (result.assignedToDifferentPerson) {
          flash(
            t(
              'webhook_calcom.inbox.assign.successDifferentPerson',
              'This meeting was already linked to another contact, so the transcript was attached to that meeting instead.',
            ),
            'warning',
          )
        } else {
          flash(
            personLabel
              ? t('webhook_calcom.inbox.assign.successNamed', 'Transcript assigned to {name}', { name: personLabel })
              : t('webhook_calcom.inbox.assign.success', 'Transcript assigned'),
            'success',
          )
        }
        onAssigned?.(result, result.assignedToDifferentPerson ? null : personLabel)
      } catch (err) {
        if (!surfaceRecordConflict(err, t)) {
          const message =
            err instanceof Error && err.message
              ? err.message
              : t('webhook_calcom.inbox.errors.assignFailed', 'Failed to assign the transcript')
          flash(message, 'error')
        }
        throw err
      }
    },
    [onAssigned, retryLastMutation, runMutation, t, transcript],
  )

  if (!transcript) return null

  return (
    <LinkEntityDialog
      open={open}
      onOpenChange={onOpenChange}
      adapter={adapter}
      initialSelectedIds={NO_INITIAL_SELECTION}
      onConfirm={handleConfirm}
    />
  )
}

export default AssignTranscriptDialog

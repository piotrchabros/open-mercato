'use client'

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@open-mercato/ui/primitives/dialog'
import { Button } from '@open-mercato/ui/primitives/button'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { useT } from '@open-mercato/shared/lib/i18n/context'

/**
 * Unlink confirmation.
 *
 * Not a plain confirm dialog, because the reason is REQUIRED: an unlink hides
 * interactions from a customer's timeline, and a reviewer later needs to know
 * on whose judgement. The copy states the consequence in those terms rather
 * than as "are you sure".
 */

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (reason: string) => void | Promise<void>
  isSubmitting: boolean
  maskedHandle: string | null
}

export function UnlinkDialog({ open, onOpenChange, onConfirm, isSubmitting, maskedHandle }: Props) {
  const t = useT()
  const [reason, setReason] = React.useState('')
  const trimmed = reason.trim()

  React.useEffect(() => {
    if (!open) setReason('')
  }, [open])

  const submit = React.useCallback(() => {
    if (!trimmed || isSubmitting) return
    void onConfirm(trimmed)
  }, [isSubmitting, onConfirm, trimmed])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('connect.customerMatch.unlink.title', 'Unlink this contact')}</DialogTitle>
          <DialogDescription>
            {t(
              'connect.customerMatch.unlink.description',
              'Customer context and every conversation projected onto this customer’s timeline will be removed. Conversations stay in Connect; only the customer association is retracted.',
            )}
          </DialogDescription>
        </DialogHeader>

        {maskedHandle ? (
          <p className="text-sm text-muted-foreground">
            {t('connect.customerMatch.unlink.handle', 'Contact: {handle}').replace('{handle}', maskedHandle)}
          </p>
        ) : null}

        <Textarea
          value={reason}
          disabled={isSubmitting}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
          placeholder={t('connect.customerMatch.unlink.reasonPlaceholder', 'Why is this link wrong?')}
          aria-label={t('connect.customerMatch.unlink.reasonLabel', 'Reason (required)')}
        />

        <DialogFooter>
          <Button type="button" variant="outline" disabled={isSubmitting} onClick={() => onOpenChange(false)}>
            {t('connect.customerMatch.actions.cancel', 'Cancel')}
          </Button>
          <Button type="button" variant="destructive" disabled={!trimmed || isSubmitting} onClick={submit}>
            {t('connect.customerMatch.unlink.confirm', 'Unlink and retract')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

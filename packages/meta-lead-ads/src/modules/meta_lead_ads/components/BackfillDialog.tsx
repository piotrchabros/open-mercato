"use client"

import * as React from 'react'
import { Button } from '@open-mercato/ui/primitives/button'
import { DatePicker } from '@open-mercato/ui/primitives/date-picker'
import { Label } from '@open-mercato/ui/primitives/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@open-mercato/ui/primitives/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@open-mercato/ui/primitives/select'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { raiseCrudError } from '@open-mercato/ui/backend/utils/serverErrors'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import type { BackfillInput, BackfillResponse, FormDto, PagedResponse } from './types'

const BACKFILL_MAX_RANGE_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000
const CONTEXT_ID = 'meta-lead-ads-backfill'

type BackfillDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStarted: () => void
}

type BackfillValidationError = 'rangeRequired' | 'rangeOrder' | 'rangeTooLong' | null

function startOfDay(date: Date): Date {
  const result = new Date(date)
  result.setHours(0, 0, 0, 0)
  return result
}

function endOfRange(date: Date, now: Date): Date {
  const result = new Date(date)
  result.setHours(23, 59, 59, 999)
  return result.getTime() > now.getTime() ? now : result
}

function validateRange(from: Date | null, to: Date | null, now: Date): BackfillValidationError {
  if (!from || !to) return 'rangeRequired'
  const fromTime = startOfDay(from).getTime()
  const toTime = endOfRange(to, now).getTime()
  if (fromTime >= toTime) return 'rangeOrder'
  if (toTime - fromTime > BACKFILL_MAX_RANGE_DAYS * DAY_MS) return 'rangeTooLong'
  return null
}

export function BackfillDialog({ open, onOpenChange, onStarted }: BackfillDialogProps) {
  const t = useT()
  const [forms, setForms] = React.useState<FormDto[]>([])
  const onClose = React.useCallback(() => onOpenChange(false), [onOpenChange])
  const [formId, setFormId] = React.useState<string>('')
  const [from, setFrom] = React.useState<Date | null>(null)
  const [to, setTo] = React.useState<Date | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [started, setStarted] = React.useState<BackfillResponse | null>(null)
  const [touched, setTouched] = React.useState(false)

  const { runMutation, retryLastMutation } = useGuardedMutation<{
    formId: string
    resourceKind: string
    retryLastMutation: () => Promise<boolean>
  }>({
    contextId: CONTEXT_ID,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  const mutationContext = React.useMemo(
    () => ({
      formId: CONTEXT_ID,
      resourceKind: 'meta_lead_ads.sync_run',
      retryLastMutation,
    }),
    [retryLastMutation],
  )

  React.useEffect(() => {
    if (!open) return
    setFormId('')
    setFrom(null)
    setTo(null)
    setStarted(null)
    setTouched(false)
    let cancelled = false
    readApiResultOrThrow<PagedResponse<FormDto>>(
      '/api/meta_lead_ads/forms?page=1&pageSize=100',
      undefined,
      { errorMessage: t('meta_lead_ads.backfill.errors.loadForms', 'Failed to load forms.') },
    )
      .then((result) => { if (!cancelled) setForms(result.items) })
      .catch((err) => {
        flash(err instanceof Error && err.message ? err.message : t('meta_lead_ads.backfill.errors.loadForms', 'Failed to load forms.'), 'error')
      })
    return () => { cancelled = true }
  }, [open, t])

  const now = React.useMemo(() => new Date(), [open])
  const validationError = validateRange(from, to, now)
  const validationMessage = React.useMemo(() => {
    if (!touched || !validationError) return null
    if (validationError === 'rangeRequired') return t('meta_lead_ads.backfill.errors.rangeRequired', 'Choose a start and end date.')
    if (validationError === 'rangeOrder') return t('meta_lead_ads.backfill.errors.rangeOrder', 'The start date must be before the end date.')
    return t('meta_lead_ads.backfill.errors.rangeTooLong', 'The range cannot be longer than 90 days.')
  }, [touched, validationError, t])

  const canSubmit = Boolean(formId) && !submitting && !started

  const handleSubmit = React.useCallback(async () => {
    if (!canSubmit || !from || !to) {
      setTouched(true)
      return
    }
    setTouched(true)
    if (validateRange(from, to, new Date())) return
    const submitNow = new Date()
    const input: BackfillInput = {
      formId,
      from: startOfDay(from).toISOString(),
      to: endOfRange(to, submitNow).toISOString(),
    }
    setSubmitting(true)
    try {
      let response: BackfillResponse | null = null
      await runMutation({
        operation: async () => {
          const result = await apiCall<BackfillResponse>('/api/meta_lead_ads/backfill', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
          })
          if (!result.ok) {
            await raiseCrudError(result.response, t('meta_lead_ads.backfill.errors.startFailed', 'Failed to start the backfill.'))
          }
          response = result.result ?? null
        },
        context: mutationContext,
        mutationPayload: input,
      })
      if (response) {
        setStarted(response)
        onStarted()
      }
      flash(t('meta_lead_ads.backfill.flash.started', 'Backfill started.'), 'success')
    } catch (err) {
      const message = err instanceof Error && err.message
        ? err.message
        : t('meta_lead_ads.backfill.errors.startFailed', 'Failed to start the backfill.')
      flash(message, 'error')
    } finally {
      setSubmitting(false)
    }
  }, [canSubmit, from, to, formId, runMutation, mutationContext, onStarted, t])

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        void handleSubmit()
      }
    },
    [handleSubmit],
  )

  const selectedForm = forms.find((form) => form.id === formId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onKeyDown={handleKeyDown}>
        <DialogHeader>
          <DialogTitle>{t('meta_lead_ads.backfill.title', 'Import past leads')}</DialogTitle>
          <DialogDescription>
            {t('meta_lead_ads.backfill.description', 'Fetch leads from Meta for a date range and import the ones that are missing. Leads already imported are skipped.')}
          </DialogDescription>
        </DialogHeader>
        {started ? (
          <div className="space-y-2 text-sm">
            <p>{t('meta_lead_ads.backfill.started', 'The backfill is running in the background. Follow its progress in the top bar and in the sync runs list.')}</p>
            {started.progressJobId ? (
              <p className="text-muted-foreground">
                {t('meta_lead_ads.backfill.progressJob', 'Progress job: {id}', { id: started.progressJobId })}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="meta-lead-ads-backfill-form">{t('meta_lead_ads.backfill.fields.form', 'Form')}</Label>
              <Select value={formId} onValueChange={setFormId} disabled={submitting}>
                <SelectTrigger id="meta-lead-ads-backfill-form" data-crud-focus-target="">
                  <SelectValue placeholder={t('meta_lead_ads.backfill.fields.formPlaceholder', 'Select a form')}>
                    {selectedForm?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {forms.map((form) => (
                    <SelectItem key={form.id} value={form.id}>{form.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t('meta_lead_ads.backfill.fields.from', 'From')}</Label>
                <DatePicker
                  value={from}
                  onChange={setFrom}
                  maxDate={now}
                  disabled={submitting}
                  aria-label={t('meta_lead_ads.backfill.fields.from', 'From')}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('meta_lead_ads.backfill.fields.to', 'To')}</Label>
                <DatePicker
                  value={to}
                  onChange={setTo}
                  maxDate={now}
                  disabled={submitting}
                  aria-label={t('meta_lead_ads.backfill.fields.to', 'To')}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('meta_lead_ads.backfill.hint', 'The range can span at most 90 days.')}
            </p>
            {validationMessage ? (
              <p role="alert" className="text-sm text-destructive">{validationMessage}</p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {started ? t('meta_lead_ads.backfill.close', 'Close') : t('meta_lead_ads.backfill.cancel', 'Cancel')}
          </Button>
          {started ? null : (
            <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
              {submitting
                ? t('meta_lead_ads.backfill.starting', 'Starting…')
                : t('meta_lead_ads.backfill.start', 'Start import')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default BackfillDialog

'use client'

import * as React from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Label } from '@open-mercato/ui/primitives/label'
import { Textarea } from '@open-mercato/ui/primitives/textarea'
import { Spinner } from '@open-mercato/ui/primitives/spinner'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { SegmentedControl, SegmentedControlItem } from '@open-mercato/ui/primitives/segmented-control'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@open-mercato/ui/primitives/select'
import { flash } from '@open-mercato/ui/backend/FlashMessages'
import { apiCall, apiCallOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { useAppEvent } from '@open-mercato/ui/backend/injection/useAppEvent'
import { useGuardedMutation } from '@open-mercato/ui/backend/injection/useGuardedMutation'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import {
  offerGenerationRunKindSchema,
  offerLanguageSchema,
} from '../data/validators'
import type {
  GenerationRunDto,
  GenerationStartResponse,
  OfferDto,
  OfferGenerationRunKind,
  OfferLanguage,
  SettingsDto,
} from './types'

const GENERATE_MUTATION_CONTEXT_ID = 'offer_generator-offer-detail:generate'
const GENERATION_EVENT_PATTERN = 'offer_generator.generation.*'
const GENERATION_STARTED_EVENT = 'offer_generator.generation.started'
const GENERATION_COMPLETED_EVENT = 'offer_generator.generation.completed'
const GENERATION_FAILED_EVENT = 'offer_generator.generation.failed'
const DEFAULT_MODEL_VALUE = '__default__'
const MIN_PROMPT_LENGTH = 10
const MIN_FEEDBACK_LENGTH = 5
const ELAPSED_TICK_MS = 1000

type GenerateMutationContext = {
  formId: string
  resourceKind: string
  resourceId: string
  retryLastMutation: () => Promise<boolean>
}

type ActiveRun = {
  runId: string
  kind: OfferGenerationRunKind
  startedAt: number
}

type ModelOptions = {
  defaultModel: string | null
  alternateModels: string[]
}

export type GenerationPanelProps = {
  offer: OfferDto
  canGenerate: boolean
  canReadSettings: boolean
  onRunFinished: () => void | Promise<void>
  onActiveChange?: (active: boolean) => void
}

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function parseTimestamp(...values: Array<string | null>): number {
  for (const value of values) {
    if (!value) continue
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

export function GenerationPanel({
  offer,
  canGenerate,
  canReadSettings,
  onRunFinished,
  onActiveChange,
}: GenerationPanelProps) {
  const t = useT()
  const [activeRun, setActiveRun] = React.useState<ActiveRun | null>(null)
  const [lastErrorCode, setLastErrorCode] = React.useState<string | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0)
  const [mode, setMode] = React.useState<OfferGenerationRunKind>(offer.hasHtml ? 'refine' : 'generate')
  const [prompt, setPrompt] = React.useState(offer.prompt ?? '')
  const [feedback, setFeedback] = React.useState('')
  const [language, setLanguage] = React.useState<OfferLanguage>(offer.language)
  const [model, setModel] = React.useState(DEFAULT_MODEL_VALUE)
  const [models, setModels] = React.useState<ModelOptions | null>(null)
  const [inputError, setInputError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const checkedRunKeysRef = React.useRef<Set<string>>(new Set())
  const onRunFinishedRef = React.useRef(onRunFinished)
  onRunFinishedRef.current = onRunFinished

  const { runMutation, retryLastMutation } = useGuardedMutation<GenerateMutationContext>({
    contextId: GENERATE_MUTATION_CONTEXT_ID,
    blockedMessage: t('ui.forms.flash.saveBlocked', 'Save blocked by validation'),
  })

  const translateErrorCode = React.useCallback(
    (code: string | null, fallback?: string) =>
      code
        ? t(`offer_generator.generation.errors.${code}`, fallback ?? t('offer_generator.generation.errors.provider_error', 'The AI provider returned an error.'))
        : fallback ?? t('offer_generator.generation.errors.provider_error', 'The AI provider returned an error.'),
    [t],
  )

  React.useEffect(() => {
    if (!offer.hasHtml) setMode('generate')
  }, [offer.hasHtml])

  React.useEffect(() => {
    onActiveChange?.(activeRun !== null)
  }, [activeRun, onActiveChange])

  React.useEffect(() => () => onActiveChange?.(false), [onActiveChange])

  React.useEffect(() => {
    if (!canGenerate || !canReadSettings) return undefined
    let cancelled = false
    apiCall<SettingsDto>('/api/offer_generator/settings', undefined, { fallback: null })
      .then((call) => {
        if (cancelled || !call.ok || !call.result) return
        setModels({ defaultModel: call.result.defaultModel, alternateModels: call.result.alternateModels ?? [] })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [canGenerate, canReadSettings])

  React.useEffect(() => {
    const runId = offer.lastGenerationRunId
    const status = offer.generationStatus
    if (!runId || (status !== 'queued' && status !== 'running' && status !== 'failed')) return undefined
    const key = `${runId}:${status}`
    if (checkedRunKeysRef.current.has(key)) return undefined
    checkedRunKeysRef.current.add(key)
    let cancelled = false
    apiCall<GenerationRunDto>(`/api/offer_generator/generation-runs/${encodeURIComponent(runId)}`, undefined, {
      fallback: null,
    })
      .then((call) => {
        const run = call.result
        if (cancelled || !call.ok || !run) return
        if (run.status === 'queued' || run.status === 'running') {
          setActiveRun((current) =>
            current?.runId === run.id
              ? current
              : { runId: run.id, kind: run.kind, startedAt: parseTimestamp(run.startedAt, run.createdAt) },
          )
          return
        }
        setActiveRun((current) => (current?.runId === run.id ? null : current))
        if (run.status === 'failed') {
          setLastErrorCode(run.errorCode ?? 'provider_error')
          return
        }
        void onRunFinishedRef.current()
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [offer.generationStatus, offer.lastGenerationRunId])

  React.useEffect(() => {
    if (!activeRun) {
      setElapsedSeconds(0)
      return undefined
    }
    const tick = () => setElapsedSeconds(Math.max(0, Math.round((Date.now() - activeRun.startedAt) / 1000)))
    tick()
    const interval = window.setInterval(tick, ELAPSED_TICK_MS)
    return () => window.clearInterval(interval)
  }, [activeRun])

  useAppEvent(
    GENERATION_EVENT_PATTERN,
    (event) => {
      const runId = readString(event.payload.runId)
      if (!runId) return
      if (event.id === GENERATION_STARTED_EVENT) {
        if (readString(event.payload.offerId) !== offer.id) return
        const kind = offerGenerationRunKindSchema.safeParse(event.payload.kind)
        setActiveRun((current) =>
          current?.runId === runId
            ? current
            : { runId, kind: kind.success ? kind.data : 'generate', startedAt: Date.now() },
        )
        return
      }
      if (event.id !== GENERATION_COMPLETED_EVENT && event.id !== GENERATION_FAILED_EVENT) return
      if (!activeRun || activeRun.runId !== runId) return
      const finishedKind = activeRun.kind
      setActiveRun(null)
      if (event.id === GENERATION_COMPLETED_EVENT) {
        setLastErrorCode(null)
        if (finishedKind === 'refine') setFeedback('')
        flash(
          finishedKind === 'refine'
            ? t('offer_generator.generation.refineCompleted', 'The offer was refined.')
            : t('offer_generator.generation.completed', 'The offer was generated.'),
          'success',
        )
      } else {
        flash(t('offer_generator.generation.failed', 'Offer generation failed.'), 'error')
      }
      void onRunFinishedRef.current()
    },
    [activeRun, offer.id, t],
  )

  const modelOptions = React.useMemo(() => {
    if (!models) return []
    const values = [models.defaultModel, ...models.alternateModels].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    )
    return Array.from(new Set(values))
  }, [models])

  const handleSubmit = React.useCallback(async () => {
    if (submitting || activeRun) return
    const text = mode === 'refine' ? feedback.trim() : prompt.trim()
    const minLength = mode === 'refine' ? MIN_FEEDBACK_LENGTH : MIN_PROMPT_LENGTH
    if (text.length < minLength) {
      setInputError(
        mode === 'refine'
          ? t('offer_generator.generation.feedbackTooShort', 'Describe what to change in at least {min} characters.', { min: minLength })
          : t('offer_generator.generation.promptTooShort', 'Write a brief of at least {min} characters.', { min: minLength }),
      )
      return
    }
    setInputError(null)
    const body = {
      kind: mode,
      ...(mode === 'refine' ? { feedback: text } : { prompt: text }),
      language,
      ...(model !== DEFAULT_MODEL_VALUE ? { model } : {}),
    }
    setSubmitting(true)
    try {
      const call = await runMutation({
        operation: () =>
          apiCallOrThrow<GenerationStartResponse>(
            `/api/offer_generator/offers/${encodeURIComponent(offer.id)}/generate`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
            { errorMessage: t('offer_generator.generation.startError', 'Could not start the generation.') },
          ),
        context: {
          formId: GENERATE_MUTATION_CONTEXT_ID,
          resourceKind: 'offer_generator.offer',
          resourceId: offer.id,
          retryLastMutation,
        },
        mutationPayload: body,
      })
      const runId = call.result?.runId
      setLastErrorCode(null)
      if (runId) {
        setActiveRun((current) =>
          current?.runId === runId ? current : { runId, kind: mode, startedAt: Date.now() },
        )
      }
      flash(t('offer_generator.generation.started', 'Generation started.'), 'success')
    } catch (err) {
      const code = readErrorCode(err)
      const fallback =
        err instanceof Error && err.message
          ? err.message
          : t('offer_generator.generation.startError', 'Could not start the generation.')
      flash(code ? translateErrorCode(code, fallback) : fallback, 'error')
      if (code === 'generation_active') void onRunFinishedRef.current()
    } finally {
      setSubmitting(false)
    }
  }, [activeRun, feedback, language, mode, model, offer.id, prompt, retryLastMutation, runMutation, submitting, t, translateErrorCode])

  const handleTextareaKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        void handleSubmit()
      }
    },
    [handleSubmit],
  )

  const busy = submitting || activeRun !== null
  const textValue = mode === 'refine' ? feedback : prompt
  const textareaId = `offer-generation-${mode}-${offer.id}`

  return (
    <section className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{t('offer_generator.generation.title', 'AI generation')}</h2>
        {canGenerate && offer.hasHtml ? (
          <SegmentedControl
            value={mode}
            onValueChange={(value) => {
              const parsed = offerGenerationRunKindSchema.safeParse(value)
              if (parsed.success) {
                setMode(parsed.data)
                setInputError(null)
              }
            }}
            disabled={busy}
            aria-label={t('offer_generator.generation.modeLabel', 'Generation mode')}
          >
            <SegmentedControlItem value="refine">{t('offer_generator.generation.modes.refine', 'Refine')}</SegmentedControlItem>
            <SegmentedControlItem value="generate">{t('offer_generator.generation.modes.generate', 'Regenerate')}</SegmentedControlItem>
          </SegmentedControl>
        ) : null}
      </div>

      {activeRun ? (
        <div className="flex items-start gap-3 rounded-md border border-status-info-border bg-status-info-bg p-3 text-sm text-status-info-text">
          <Spinner size="sm" />
          <div className="space-y-1">
            <p className="font-medium">
              {activeRun.kind === 'refine'
                ? t('offer_generator.generation.refining', 'Refining the offer... {seconds} s', { seconds: elapsedSeconds })
                : t('offer_generator.generation.generating', 'Generating the offer... {seconds} s', { seconds: elapsedSeconds })}
            </p>
            <p className="text-xs">
              {t(
                'offer_generator.generation.runningHint',
                'This usually takes 30 to 90 seconds. You can leave this page; progress is shown in the top bar.',
              )}
            </p>
          </div>
        </div>
      ) : null}

      {!activeRun && lastErrorCode ? (
        <Alert status="error">
          <AlertDescription>
            {t('offer_generator.generation.lastFailed', 'The last generation failed: {reason}', {
              reason: translateErrorCode(lastErrorCode),
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      {canGenerate ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={textareaId}>
              {mode === 'refine'
                ? t('offer_generator.generation.feedbackLabel', 'What should change?')
                : t('offer_generator.generation.promptLabel', 'Brief for the AI')}
            </Label>
            <Textarea
              id={textareaId}
              value={textValue}
              onChange={(event) => {
                if (mode === 'refine') setFeedback(event.target.value)
                else setPrompt(event.target.value)
              }}
              onKeyDown={handleTextareaKeyDown}
              rows={mode === 'refine' ? 4 : 8}
              maxLength={mode === 'refine' ? 10000 : 50000}
              disabled={busy}
              placeholder={
                mode === 'refine'
                  ? t('offer_generator.generation.feedbackPlaceholder', 'For example: shorten the introduction and add a payment schedule.')
                  : t('offer_generator.generation.promptPlaceholder', 'Describe the client, the scope, prices and anything the offer must include.')
              }
            />
            {inputError ? <p className="text-xs text-status-error-text">{inputError}</p> : null}
            <p className="text-xs text-muted-foreground">
              {mode === 'refine'
                ? t(
                    'offer_generator.generation.refineHint',
                    'The AI changes the current offer and keeps manually edited fragments. The public link stays the same.',
                  )
                : offer.hasHtml
                  ? t(
                      'offer_generator.generation.regenerateHint',
                      'Writes the offer from scratch. The current version is kept in the revision history.',
                    )
                  : t('offer_generator.generation.generateHint', 'The AI writes the offer from this brief and the template from settings.')}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`offer-generation-language-${offer.id}`}>
                {t('offer_generator.fields.language', 'Language')}
              </Label>
              <Select
                value={language}
                onValueChange={(value) => {
                  const parsed = offerLanguageSchema.safeParse(value)
                  if (parsed.success) setLanguage(parsed.data)
                }}
                disabled={busy}
              >
                <SelectTrigger id={`offer-generation-language-${offer.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {offerLanguageSchema.options.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`offer_generator.languages.${option}`, option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {modelOptions.length > 0 ? (
              <div className="space-y-1.5">
                <Label htmlFor={`offer-generation-model-${offer.id}`}>
                  {t('offer_generator.generation.modelLabel', 'Model')}
                </Label>
                <Select value={model} onValueChange={setModel} disabled={busy}>
                  <SelectTrigger id={`offer-generation-model-${offer.id}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_MODEL_VALUE}>
                      {t('offer_generator.generation.defaultModel', 'Default model')}
                    </SelectItem>
                    {modelOptions.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          <div className="flex justify-end">
            <Button type="button" onClick={() => void handleSubmit()} disabled={busy}>
              <Sparkles />
              {mode === 'refine'
                ? t('offer_generator.generation.submitRefine', 'Refine with AI')
                : offer.hasHtml
                  ? t('offer_generator.generation.submitRegenerate', 'Regenerate with AI')
                  : t('offer_generator.generation.submitGenerate', 'Generate with AI')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export default GenerationPanel

import { randomUUID } from 'crypto'
import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { ProgressService, ProgressServiceContext } from '@open-mercato/core/modules/progress/lib/progressService'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import { CrudHttpError, isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { OFFER_COMMAND_IDS, type OfferHtmlCommandInput, type OfferHtmlCommandResult } from '../commands/offers'
import { Offer, OfferGenerationRun } from '../data/entities'
import type {
  GenerateOfferJob,
  GenerationStartInput,
  OfferGenerationErrorCode,
  OfferGenerationRunKind,
  OfferLanguage,
} from '../data/validators'
import { emitOfferGeneratorEvent, type OfferGenerationEventPayload } from '../events'
import {
  isOfferAiNotConfiguredError,
  OfferGenerationError,
  readOfferAiLimits,
  resolveOfferHtmlGenerator,
  resolveOfferModel,
  type OfferHtmlGenerator,
  type OfferHtmlStreamSource,
  type OfferModelResolution,
} from './ai-client'
import { MODULE_ID, PROGRESS_JOB_TYPE } from './constants'
import { stripCodeFence, stripDataUris } from './html-utils'
import { checkOfferHtmlComplete, checkRefineNotShrunk } from './html-validate'
import {
  buildGenerateSystemPrompt,
  buildGenerateUserPrompt,
  buildRefineSystemPrompt,
  buildRefineUserPrompt,
} from './prompts'
import { enqueueGenerateOffer } from './queue'
import { getOfferGeneratorSettings, type OfferGeneratorScope, type OfferGeneratorSettingsValues } from './settings'

const logger = createLogger('offer_generator').child({ component: 'generation' })

export const GENERATION_EXPECTED_BYTES = 60000
export const GENERATION_MAX_RUNNING_PERCENT = 95
export const GENERATION_FLUSH_INTERVAL_MS = 2000
export const MIN_GENERATED_TEXT_LENGTH = 200
const ACTIVE_RUN_STALE_MARGIN_MS = 30 * 60_000
const ACTIVE_RUN_STATUSES = ['queued', 'running'] as const

type Resolver = { resolve: <T = unknown>(name: string) => T }

export type GenerationRuntime = Resolver

export type StartGenerationRunParams = {
  container: AwilixContainer
  em: EntityManager
  scope: OfferGeneratorScope
  userId: string | null
  offerId: string
  input: GenerationStartInput
}

export type StartGenerationRunResult = {
  runId: string
  progressJobId: string
}

export type ExecuteGenerationRunResult =
  | { status: 'completed'; runId: string; revisionId: string | null }
  | { status: 'failed'; runId: string; errorCode: OfferGenerationErrorCode }
  | { status: 'skipped'; runId: string }

const errorFallbacks = {
  notFound: 'Offer not found',
  generationActive: 'A generation is already running for this offer',
  promptRequired: 'Describe the offer before generating it',
  refineWithoutHtml: 'Generate the offer before refining it',
  modelNotAllowed: 'This model is not available for offer generation',
  aiNotConfigured: 'AI is not configured. Ask an administrator to set up an AI provider.',
  progressGenerate: 'Generating offer',
  progressRefine: 'Refining offer',
} as const

function tryResolve<T>(container: Resolver, name: string): T | null {
  try {
    return container.resolve<T>(name) ?? null
  } catch {
    return null
  }
}

function buildEventPayload(
  run: Pick<OfferGenerationRun, 'id' | 'offerId' | 'kind' | 'tenantId' | 'organizationId'>,
): OfferGenerationEventPayload {
  return {
    offerId: run.offerId,
    runId: run.id,
    kind: run.kind,
    tenantId: run.tenantId,
    organizationId: run.organizationId,
  }
}

async function emitGenerationEvent(
  eventId: 'offer_generator.generation.started' | 'offer_generator.generation.completed' | 'offer_generator.generation.failed',
  payload: OfferGenerationEventPayload,
): Promise<void> {
  try {
    await emitOfferGeneratorEvent(eventId, payload, {
      persistent: true,
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
    })
  } catch (error) {
    logger.warn('Failed to emit offer generation event', { eventId, runId: payload.runId, err: error })
  }
}

function reportGenerationError(error: unknown, code: string, attributes: Record<string, string>): void {
  getTelemetryRuntime()?.reportError(error, { module: MODULE_ID, code, attributes })
}

export function allowedSettingsModels(settings: Pick<OfferGeneratorSettingsValues, 'defaultModel' | 'alternateModels'>): string[] {
  const values = [settings.defaultModel, ...settings.alternateModels]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value) => value.length > 0)
  return Array.from(new Set(values))
}

export function computeGenerationPercent(bytesReceived: number): number {
  const percent = Math.round((bytesReceived / GENERATION_EXPECTED_BYTES) * 100)
  return Math.max(0, Math.min(GENERATION_MAX_RUNNING_PERCENT, percent))
}

function findScopedOffer(em: EntityManager, offerId: string, scope: OfferGeneratorScope): Promise<Offer | null> {
  return findOneWithDecryption(
    em,
    Offer,
    { id: offerId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
    undefined,
    scope,
  )
}

async function failStaleRuns(em: EntityManager, offerId: string, scope: OfferGeneratorScope, now: Date): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - readOfferAiLimits().timeoutMs - ACTIVE_RUN_STALE_MARGIN_MS)
  const activeRuns = await em.find(
    OfferGenerationRun,
    { offerId, tenantId: scope.tenantId, organizationId: scope.organizationId, status: { $in: [...ACTIVE_RUN_STATUSES] } },
    { fields: ['id', 'updatedAt'] },
  )
  if (activeRuns.some((run) => run.updatedAt >= staleBefore)) return false
  const staleIds = activeRuns.map((run) => run.id)
  if (staleIds.length > 0) {
    await em.nativeUpdate(
      OfferGenerationRun,
      { id: { $in: staleIds }, status: { $in: [...ACTIVE_RUN_STATUSES] } },
      { status: 'failed', errorCode: 'timeout', finishedAt: now, updatedAt: now },
    )
    await em.nativeUpdate(
      Offer,
      { id: offerId, tenantId: scope.tenantId, organizationId: scope.organizationId, generationStatus: { $in: [...ACTIVE_RUN_STATUSES] } },
      { generationStatus: 'failed' },
    )
  }
  return true
}

export async function startGenerationRun(params: StartGenerationRunParams): Promise<StartGenerationRunResult> {
  const { container, em, scope, userId, offerId, input } = params
  const { translate } = await resolveTranslations()

  const offer = await findScopedOffer(em, offerId, scope)
  if (!offer) {
    throw new CrudHttpError(404, { error: translate('offer_generator.errors.notFound', errorFallbacks.notFound) })
  }

  const kind: OfferGenerationRunKind = input.kind
  const language: OfferLanguage = input.language ?? offer.language
  const inputText = kind === 'refine' ? input.feedback?.trim() ?? '' : (input.prompt ?? offer.prompt ?? '').trim()
  if (kind === 'generate' && inputText.length === 0) {
    throw new CrudHttpError(400, {
      error: translate('offer_generator.errors.promptRequired', errorFallbacks.promptRequired),
      code: 'prompt_required',
    })
  }
  if (kind === 'refine' && !offer.html) {
    throw new CrudHttpError(400, {
      error: translate('offer_generator.errors.refineWithoutHtml', errorFallbacks.refineWithoutHtml),
      code: 'refine_without_html',
    })
  }

  const settings = await getOfferGeneratorSettings(em, scope)
  const requestedModel = input.model?.trim() || null
  if (requestedModel && !allowedSettingsModels(settings).includes(requestedModel)) {
    throw new CrudHttpError(400, {
      error: translate('offer_generator.errors.modelNotAllowed', errorFallbacks.modelNotAllowed),
      code: 'model_not_allowed',
    })
  }

  const generator = resolveOfferHtmlGenerator(container)
  let resolution: OfferModelResolution | null = null
  if (generator.requiresModel) {
    try {
      resolution = await resolveOfferModel(container, em, scope, {
        modelOverride: requestedModel,
        settingsDefaultModel: settings.defaultModel,
      })
    } catch (error) {
      if (!isOfferAiNotConfiguredError(error)) throw error
      throw new CrudHttpError(503, {
        error: translate('offer_generator.generation.errors.ai_not_configured', errorFallbacks.aiNotConfigured),
        code: 'ai_not_configured',
      })
    }
  }

  const now = new Date()
  const generationActive = () =>
    new CrudHttpError(409, {
      error: translate('offer_generator.errors.generationActive', errorFallbacks.generationActive),
      code: 'generation_active',
    })
  if (!(await failStaleRuns(em, offer.id, scope, now))) throw generationActive()

  const runId = randomUUID()
  const previousGenerationStatus = offer.generationStatus === 'failed' ? 'failed' : 'idle'
  const previousRunId = offer.lastGenerationRunId ?? null
  const claimed = await em.nativeUpdate(
    Offer,
    {
      id: offer.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
      generationStatus: { $nin: [...ACTIVE_RUN_STATUSES] },
    },
    { generationStatus: 'queued', lastGenerationRunId: runId },
  )
  if (claimed === 0) throw generationActive()

  const progressService = container.resolve<ProgressService>('progressService')
  const progressCtx: ProgressServiceContext = { ...scope, userId }
  let runCreated = false
  let progressJobId: string | null = null
  try {
    const run = em.create(OfferGenerationRun, {
      id: runId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      offerId: offer.id,
      kind,
      inputText,
      language,
      status: 'queued',
      providerId: resolution?.providerId ?? null,
      modelId: resolution?.modelId ?? null,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    })
    em.persist(run)
    await em.flush()
    runCreated = true

    const job = await progressService.createJob(
      {
        jobType: PROGRESS_JOB_TYPE,
        name:
          kind === 'refine'
            ? translate('offer_generator.generation.progress.refine', errorFallbacks.progressRefine)
            : translate('offer_generator.generation.progress.generate', errorFallbacks.progressGenerate),
        description: offer.title,
        cancellable: false,
        meta: { offerId: offer.id, runId, kind },
      },
      progressCtx,
    )
    progressJobId = job.id
    await em.nativeUpdate(OfferGenerationRun, { id: runId }, { progressJobId: job.id })

    const payload: GenerateOfferJob = {
      runId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      userId,
    }
    await enqueueGenerateOffer(payload)
  } catch (error) {
    reportGenerationError(error, 'offer_generator.generation_start_failed', { offerId: offer.id, runId })
    await rollbackStart(em, {
      offerId: offer.id,
      runId,
      scope,
      runCreated,
      progressJobId,
      previousGenerationStatus,
      previousRunId,
      progressService,
      progressCtx,
    })
    throw error
  }

  await emitGenerationEvent('offer_generator.generation.started', {
    offerId: offer.id,
    runId,
    kind,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })

  return { runId, progressJobId }
}

async function rollbackStart(
  em: EntityManager,
  input: {
    offerId: string
    runId: string
    scope: OfferGeneratorScope
    runCreated: boolean
    progressJobId: string | null
    previousGenerationStatus: 'idle' | 'failed'
    previousRunId: string | null
    progressService: ProgressService
    progressCtx: ProgressServiceContext
  },
): Promise<void> {
  const now = new Date()
  try {
    if (input.runCreated) {
      await em.nativeUpdate(
        OfferGenerationRun,
        { id: input.runId, status: 'queued' },
        { status: 'failed', errorCode: 'provider_error', finishedAt: now, updatedAt: now },
      )
    }
    await em.nativeUpdate(
      Offer,
      { id: input.offerId, tenantId: input.scope.tenantId, organizationId: input.scope.organizationId, lastGenerationRunId: input.runId },
      {
        generationStatus: input.runCreated ? 'failed' : input.previousGenerationStatus,
        lastGenerationRunId: input.runCreated ? input.runId : input.previousRunId,
      },
    )
    if (input.progressJobId) {
      await input.progressService.failJob(input.progressJobId, { errorMessage: 'provider_error' }, input.progressCtx)
    }
  } catch (rollbackError) {
    logger.error('Failed to roll back offer generation start', { runId: input.runId, err: rollbackError })
  }
}

function buildSystemCommandContext(container: Resolver, scope: OfferGeneratorScope): CommandRuntimeContext {
  return {
    container: container as AwilixContainer,
    auth: null,
    organizationScope: {
      selectedId: scope.organizationId,
      filterIds: [scope.organizationId],
      allowedIds: [scope.organizationId],
      tenantId: scope.tenantId,
    },
    selectedOrganizationId: scope.organizationId,
    organizationIds: [scope.organizationId],
    systemActor: true,
  }
}

function toErrorCode(error: unknown): OfferGenerationErrorCode {
  if (error instanceof OfferGenerationError) return error.code
  if (isOfferAiNotConfiguredError(error)) return 'ai_not_configured'
  if (isCrudHttpError(error) && error.status === 400 && error.body?.code === 'incomplete_html') return 'incomplete_html'
  return 'provider_error'
}

function isExpectedFailure(error: unknown): boolean {
  if (error instanceof OfferGenerationError) return error.code !== 'provider_error' || error.cause === undefined
  if (isOfferAiNotConfiguredError(error)) return true
  return isCrudHttpError(error) && error.status === 400 && error.body?.code === 'incomplete_html'
}

type ProgressTracker = {
  record: (totalLength: number) => void
  flush: () => Promise<void>
  stop: () => Promise<void>
  snapshot: () => { bytesReceived: number; chunks: number }
}

function createProgressTracker(input: {
  em: EntityManager
  runId: string
  progressService: ProgressService | null
  progressJobId: string | null
  progressCtx: ProgressServiceContext
}): ProgressTracker {
  let bytesReceived = 0
  let chunks = 0
  let flushedBytes = 0
  let inFlight: Promise<void> | null = null

  const write = async (): Promise<void> => {
    const bytes = bytesReceived
    const chunkCount = chunks
    try {
      if (bytes !== flushedBytes) {
        await input.em.nativeUpdate(
          OfferGenerationRun,
          { id: input.runId, status: 'running' },
          { bytesReceived: bytes, chunks: chunkCount, updatedAt: new Date() },
        )
        flushedBytes = bytes
        if (input.progressService && input.progressJobId) {
          await input.progressService.updateProgress(
            input.progressJobId,
            { progressPercent: computeGenerationPercent(bytes), meta: { bytesReceived: bytes } },
            input.progressCtx,
          )
        }
      } else if (input.progressService && input.progressJobId) {
        await input.progressService.touchJobHeartbeat?.(input.progressJobId, input.progressCtx)
      }
    } catch (error) {
      logger.warn('Failed to record offer generation progress', { runId: input.runId, err: error })
    }
  }

  const flush = (): Promise<void> => {
    if (inFlight) return inFlight
    inFlight = write().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const timer = setInterval(() => {
    void flush()
  }, GENERATION_FLUSH_INTERVAL_MS)
  timer.unref?.()

  return {
    record(totalLength) {
      bytesReceived = totalLength
      chunks += 1
    },
    flush,
    async stop() {
      clearInterval(timer)
      if (inFlight) await inFlight
    },
    snapshot: () => ({ bytesReceived, chunks }),
  }
}

function buildStreamPrompts(
  run: Pick<OfferGenerationRun, 'kind' | 'inputText' | 'language'>,
  settings: OfferGeneratorSettingsValues,
  baseStripped: string | null,
): { system: string; prompt: string; source: OfferHtmlStreamSource } {
  const shared = { language: run.language, companyName: settings.companyName, extraInstructions: settings.extraInstructions }
  if (run.kind === 'refine') {
    const strippedHtml = baseStripped ?? ''
    return {
      system: buildRefineSystemPrompt(shared),
      prompt: buildRefineUserPrompt(strippedHtml, run.inputText, run.language),
      source: { kind: 'refine', strippedHtml, feedback: run.inputText },
    }
  }
  return {
    system: buildGenerateSystemPrompt({ ...shared, template: settings.templateHtml }),
    prompt: buildGenerateUserPrompt(run.inputText, run.language),
    source: { kind: 'generate', brief: run.inputText, template: settings.templateHtml },
  }
}

export async function executeGenerationRun(
  runtime: GenerationRuntime,
  job: GenerateOfferJob,
): Promise<ExecuteGenerationRunResult> {
  const scope: OfferGeneratorScope = { tenantId: job.tenantId, organizationId: job.organizationId }
  const em = runtime.resolve<EntityManager>('em').fork()
  const run = await findOneWithDecryption(
    em,
    OfferGenerationRun,
    { id: job.runId, tenantId: scope.tenantId, organizationId: scope.organizationId },
    undefined,
    scope,
  )
  if (!run || run.status !== 'queued') return { status: 'skipped', runId: job.runId }

  const startedAt = new Date()
  const claimed = await em.nativeUpdate(
    OfferGenerationRun,
    { id: run.id, status: 'queued' },
    { status: 'running', startedAt, updatedAt: startedAt },
  )
  if (claimed === 0) return { status: 'skipped', runId: run.id }
  await em.nativeUpdate(
    Offer,
    { id: run.offerId, tenantId: scope.tenantId, organizationId: scope.organizationId, lastGenerationRunId: run.id },
    { generationStatus: 'running' },
  )

  const progressService = tryResolve<ProgressService>(runtime, 'progressService')
  const progressCtx: ProgressServiceContext = { ...scope, userId: job.userId }
  const progressJobId = run.progressJobId ?? null
  if (progressService && progressJobId) {
    try {
      await progressService.startJob(progressJobId, progressCtx)
    } catch (error) {
      logger.warn('Failed to start offer generation progress job', { runId: run.id, err: error })
    }
  }

  const tracker = createProgressTracker({ em, runId: run.id, progressService, progressJobId, progressCtx })
  const eventPayload = buildEventPayload(run)

  try {
    const offer = await findScopedOffer(em, run.offerId, scope)
    if (!offer) throw new OfferGenerationError('provider_error', '[internal] offer_generator offer disappeared before generation')
    const settings = await getOfferGeneratorSettings(em, scope)
    const generator: OfferHtmlGenerator = resolveOfferHtmlGenerator(runtime)

    let baseStripped: string | null = null
    let restore: (value: string) => string = (value) => value
    if (run.kind === 'refine') {
      if (!offer.html) throw new OfferGenerationError('incomplete_html', '[internal] offer_generator refine without base HTML')
      const stripped = stripDataUris(offer.html)
      baseStripped = stripped.stripped
      restore = stripped.restore
    }

    let resolution: OfferModelResolution | null = null
    if (generator.requiresModel) {
      resolution = await resolveOfferModel(runtime as AwilixContainer, em, scope, {
        modelOverride: run.modelId ?? null,
        providerOverride: run.modelId ? run.providerId ?? null : null,
        settingsDefaultModel: settings.defaultModel,
      })
      await em.nativeUpdate(
        OfferGenerationRun,
        { id: run.id },
        { providerId: resolution.providerId, modelId: resolution.modelId, updatedAt: new Date() },
      )
    }

    const limits = readOfferAiLimits()
    const prompts = buildStreamPrompts(run, settings, baseStripped)
    const streamed = await generator.stream({
      resolution,
      system: prompts.system,
      prompt: prompts.prompt,
      language: run.language,
      source: prompts.source,
      maxOutputTokens: limits.maxOutputTokens,
      timeoutMs: limits.timeoutMs,
      onText: (_delta, totalLength) => tracker.record(totalLength),
    })
    await tracker.stop()

    const output = stripCodeFence(streamed.text)
    if (output.length < MIN_GENERATED_TEXT_LENGTH) throw new OfferGenerationError('empty_response')
    const completeness = checkOfferHtmlComplete(output)
    if (!completeness.ok) throw new OfferGenerationError('incomplete_html', `[internal] offer_generator ${completeness.issue}`)
    if (run.kind === 'refine' && baseStripped !== null) {
      const shrink = checkRefineNotShrunk(baseStripped, output)
      if (!shrink.ok) throw new OfferGenerationError('refine_shrunk', `[internal] offer_generator output shrank ${shrink.shrinkPercent}%`)
    }
    const html = run.kind === 'refine' ? restore(output) : output

    const commandBus = runtime.resolve<CommandBus>('commandBus')
    const commandInput: OfferHtmlCommandInput = {
      id: offer.id,
      html,
      source: run.kind,
      feedback: run.kind === 'refine' ? run.inputText : null,
      generationRunId: run.id,
    }
    const { result } = await commandBus.execute<OfferHtmlCommandInput, OfferHtmlCommandResult>(
      OFFER_COMMAND_IDS.updateHtml,
      { input: commandInput, ctx: buildSystemCommandContext(runtime, scope) },
    )

    const finishedAt = new Date()
    const snapshot = tracker.snapshot()
    await em.nativeUpdate(
      OfferGenerationRun,
      { id: run.id },
      {
        status: 'completed',
        resultRevisionId: result.revisionId,
        bytesReceived: snapshot.bytesReceived,
        chunks: snapshot.chunks,
        errorCode: null,
        finishedAt,
        updatedAt: finishedAt,
      },
    )
    await em.nativeUpdate(
      Offer,
      { id: offer.id, tenantId: scope.tenantId, organizationId: scope.organizationId, lastGenerationRunId: run.id },
      { generationStatus: 'idle' },
    )
    if (progressService && progressJobId) {
      try {
        await progressService.completeJob(
          progressJobId,
          { resultSummary: { offerId: offer.id, runId: run.id, revisionId: result.revisionId } },
          progressCtx,
        )
      } catch (error) {
        logger.warn('Failed to complete offer generation progress job', { runId: run.id, err: error })
      }
    }
    await emitGenerationEvent('offer_generator.generation.completed', eventPayload)
    return { status: 'completed', runId: run.id, revisionId: result.revisionId }
  } catch (error) {
    await tracker.stop()
    const errorCode = toErrorCode(error)
    const expected = isExpectedFailure(error)
    if (!expected) {
      reportGenerationError(error, 'offer_generator.generation_failed', { runId: run.id, offerId: run.offerId, errorCode })
    }
    logger.warn('Offer generation failed', { runId: run.id, offerId: run.offerId, errorCode })
    await markRunFailed(em, { run, scope, errorCode, snapshot: tracker.snapshot() })
    if (progressService && progressJobId) {
      try {
        await progressService.failJob(progressJobId, { errorMessage: errorCode }, progressCtx)
      } catch (progressError) {
        logger.warn('Failed to fail offer generation progress job', { runId: run.id, err: progressError })
      }
    }
    await emitGenerationEvent('offer_generator.generation.failed', eventPayload)
    if (!expected) throw error
    return { status: 'failed', runId: run.id, errorCode }
  }
}

async function markRunFailed(
  em: EntityManager,
  input: {
    run: OfferGenerationRun
    scope: OfferGeneratorScope
    errorCode: OfferGenerationErrorCode
    snapshot: { bytesReceived: number; chunks: number }
  },
): Promise<void> {
  const finishedAt = new Date()
  try {
    await em.nativeUpdate(
      OfferGenerationRun,
      { id: input.run.id },
      {
        status: 'failed',
        errorCode: input.errorCode,
        bytesReceived: input.snapshot.bytesReceived,
        chunks: input.snapshot.chunks,
        finishedAt,
        updatedAt: finishedAt,
      },
    )
    await em.nativeUpdate(
      Offer,
      {
        id: input.run.offerId,
        tenantId: input.scope.tenantId,
        organizationId: input.scope.organizationId,
        lastGenerationRunId: input.run.id,
      },
      { generationStatus: 'failed' },
    )
  } catch (error) {
    reportGenerationError(error, 'offer_generator.generation_mark_failed', { runId: input.run.id })
    logger.error('Failed to mark offer generation run as failed', { runId: input.run.id, err: error })
  }
}

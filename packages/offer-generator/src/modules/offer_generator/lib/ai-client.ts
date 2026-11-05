import { streamText } from 'ai'
import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  AiModelFactoryError,
  createModelFactory,
  type AiModelFactory,
} from '@open-mercato/ai-assistant/modules/ai_assistant/lib/model-factory'
import {
  AiTenantModelAllowlistRepository,
  type AiTenantModelAllowlistSnapshot,
} from '@open-mercato/ai-assistant/modules/ai_assistant/data/repositories/AiTenantModelAllowlistRepository'
import { parseBooleanToken } from '@open-mercato/shared/lib/boolean'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { OfferGenerationErrorCode, OfferLanguage } from '../data/validators'
import { AI_DEFAULT_MAX_OUTPUT_TOKENS, AI_DEFAULT_TIMEOUT_MS, MODULE_ID } from './constants'
import type { OfferGeneratorScope } from './settings'

const logger = createLogger('offer_generator').child({ component: 'ai-client' })

export const FAKE_INCOMPLETE_MARKER = '__FAKE_INCOMPLETE__'

export type OfferLanguageModel = Parameters<typeof streamText>[0]['model']
type OfferProviderOptions = Parameters<typeof streamText>[0]['providerOptions']

export type OfferModelResolution = {
  model: OfferLanguageModel
  providerId: string
  modelId: string
  providerOptions?: Record<string, unknown>
}

export type ResolveOfferModelOptions = {
  modelOverride?: string | null
  providerOverride?: string | null
  settingsDefaultModel?: string | null
}

export type OfferHtmlStreamSource =
  | { kind: 'generate'; brief: string; template: string }
  | { kind: 'refine'; strippedHtml: string; feedback: string }

export type OfferHtmlStreamInput = {
  resolution: OfferModelResolution | null
  system: string
  prompt: string
  language: OfferLanguage
  source: OfferHtmlStreamSource
  maxOutputTokens?: number
  timeoutMs?: number
  abortSignal?: AbortSignal
  onText?: (delta: string, totalLength: number) => void
}

export type OfferHtmlStreamResult = {
  text: string
  finishReason: string
}

export interface OfferHtmlGenerator {
  readonly id: string
  readonly requiresModel: boolean
  stream(input: OfferHtmlStreamInput): Promise<OfferHtmlStreamResult>
}

export class OfferAiNotConfiguredError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('[internal] offer_generator AI model is not configured', options)
    this.name = 'OfferAiNotConfiguredError'
  }
}

export class OfferGenerationError extends Error {
  readonly code: OfferGenerationErrorCode

  constructor(code: OfferGenerationErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? `[internal] offer_generator generation failed: ${code}`, options)
    this.name = 'OfferGenerationError'
    this.code = code
  }
}

export function isOfferAiNotConfiguredError(error: unknown): error is OfferAiNotConfiguredError {
  if (error instanceof OfferAiNotConfiguredError) return true
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'OfferAiNotConfiguredError'
}

function isAiModelFactoryError(error: unknown): boolean {
  if (error instanceof AiModelFactoryError) return true
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AiModelFactoryError'
}

function normalizeOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function readOfferAiLimits(env: Record<string, string | undefined> = process.env): {
  maxOutputTokens: number
  timeoutMs: number
} {
  return {
    maxOutputTokens: readPositiveInt(env.OM_OFFER_GENERATOR_MAX_OUTPUT_TOKENS, AI_DEFAULT_MAX_OUTPUT_TOKENS),
    timeoutMs: readPositiveInt(env.OM_OFFER_GENERATOR_AI_TIMEOUT_MS, AI_DEFAULT_TIMEOUT_MS),
  }
}

export async function resolveOfferTenantAllowlist(
  em: EntityManager,
  scope: OfferGeneratorScope,
): Promise<AiTenantModelAllowlistSnapshot | null> {
  try {
    return await new AiTenantModelAllowlistRepository(em).getSnapshot({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    })
  } catch (error) {
    logger.warn('Tenant AI allowlist lookup failed; falling back to env-only enforcement', { err: error })
    return null
  }
}

export async function resolveOfferModel(
  container: AwilixContainer,
  em: EntityManager,
  scope: OfferGeneratorScope,
  options: ResolveOfferModelOptions = {},
): Promise<OfferModelResolution> {
  let factory: AiModelFactory
  try {
    factory = createModelFactory(container)
  } catch (error) {
    throw new OfferAiNotConfiguredError({ cause: error })
  }
  const tenantAllowlist = await resolveOfferTenantAllowlist(em, scope)
  try {
    const resolution = factory.resolveModel({
      moduleId: MODULE_ID,
      callerOverride: normalizeOptional(options.modelOverride),
      providerOverride: normalizeOptional(options.providerOverride),
      agentDefaultModel: normalizeOptional(options.settingsDefaultModel),
      tenantAllowlist,
    })
    return {
      model: resolution.model as OfferLanguageModel,
      providerId: resolution.providerId,
      modelId: resolution.modelId,
      providerOptions: resolution.providerOptions,
    }
  } catch (error) {
    if (isAiModelFactoryError(error)) throw new OfferAiNotConfiguredError({ cause: error })
    throw error
  }
}

function mapFinishReason(finishReason: string): OfferGenerationErrorCode | null {
  if (finishReason === 'stop') return null
  if (finishReason === 'length') return 'max_tokens'
  return 'provider_error'
}

function createTimeoutController(timeoutMs: number, parent?: AbortSignal): {
  signal: AbortSignal
  timedOut: () => boolean
  dispose: () => void
} {
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, timeoutMs)
  const onParentAbort = () => controller.abort()
  if (parent) {
    if (parent.aborted) controller.abort()
    else parent.addEventListener('abort', onParentAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => expired,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    },
  }
}

export function createAiOfferHtmlGenerator(): OfferHtmlGenerator {
  return {
    id: 'ai',
    requiresModel: true,
    async stream(input) {
      if (!input.resolution) throw new OfferAiNotConfiguredError()
      const limits = readOfferAiLimits()
      const timeout = createTimeoutController(input.timeoutMs ?? limits.timeoutMs, input.abortSignal)
      let streamError: unknown = null
      let text = ''
      try {
        const result = streamText({
          model: input.resolution.model,
          system: input.system,
          prompt: input.prompt,
          maxOutputTokens: input.maxOutputTokens ?? limits.maxOutputTokens,
          abortSignal: timeout.signal,
          ...(input.resolution.providerOptions
            ? { providerOptions: input.resolution.providerOptions as OfferProviderOptions }
            : {}),
          onError: ({ error }) => {
            streamError = error
          },
        })
        for await (const delta of result.textStream) {
          text += delta
          input.onText?.(delta, text.length)
        }
        if (timeout.timedOut()) throw new OfferGenerationError('timeout')
        if (streamError) throw new OfferGenerationError('provider_error', undefined, { cause: streamError })
        const finishReason = await result.finishReason
        const failure = mapFinishReason(finishReason)
        if (failure) throw new OfferGenerationError(failure, `[internal] offer_generator stream finished with ${finishReason}`)
        return { text, finishReason }
      } catch (error) {
        if (error instanceof OfferGenerationError) throw error
        if (timeout.timedOut()) throw new OfferGenerationError('timeout', undefined, { cause: error })
        throw new OfferGenerationError('provider_error', undefined, { cause: error })
      } finally {
        timeout.dispose()
      }
    },
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)
  return line ?? ''
}

function withHtmlLang(html: string, language: OfferLanguage): string {
  if (/<html\b[^>]*\blang\s*=/i.test(html)) {
    return html.replace(/(<html\b[^>]*\blang\s*=\s*)(["']?)[^"'\s>]*\2/i, `$1"${language}"`)
  }
  if (/<html\b/i.test(html)) return html.replace(/<html\b/i, `<html lang="${language}"`)
  return `<!DOCTYPE html><html lang="${language}"><head><meta charset="utf-8"></head><body>${html}</body></html>`
}

function insertBeforeBodyClose(html: string, fragment: string): string {
  const index = html.toLowerCase().lastIndexOf('</body>')
  if (index === -1) return `${html}${fragment}`
  return `${html.slice(0, index)}${fragment}${html.slice(index)}`
}

function insertAfterBodyOpen(html: string, fragment: string): string {
  const open = /<body(?:\s[^>]*)?>/i.exec(html)
  if (!open) return `${fragment}${html}`
  const end = open.index + open[0].length
  return `${html.slice(0, end)}${fragment}${html.slice(end)}`
}

function buildFakeOutput(input: OfferHtmlStreamInput): string {
  if (input.source.kind === 'generate') {
    const heading = `<h1 data-fake-generate>${escapeHtml(firstLine(input.source.brief))}</h1>`
    const html = insertAfterBodyOpen(withHtmlLang(input.source.template, input.language), heading)
    if (input.source.brief.includes(FAKE_INCOMPLETE_MARKER)) return html.replace(/<\/html\s*>/gi, '')
    return html
  }
  const paragraph = `<p data-fake-refine>${escapeHtml(input.source.feedback)}</p>`
  const html = insertBeforeBodyClose(input.source.strippedHtml, paragraph)
  if (input.source.feedback.includes(FAKE_INCOMPLETE_MARKER)) return html.replace(/<\/html\s*>/gi, '')
  return html
}

export function createFakeOfferHtmlGenerator(): OfferHtmlGenerator {
  return {
    id: 'fake',
    requiresModel: false,
    async stream(input) {
      const text = buildFakeOutput(input)
      const chunkSize = 4096
      for (let offset = 0; offset < text.length; offset += chunkSize) {
        const delta = text.slice(offset, offset + chunkSize)
        input.onText?.(delta, Math.min(text.length, offset + chunkSize))
      }
      return { text, finishReason: 'stop' }
    },
  }
}

export function shouldUseFakeOfferGenerator(env: Record<string, string | undefined> = process.env): boolean {
  return parseBooleanToken(env.OM_INTEGRATION_TEST) === true && env.OM_OFFER_GENERATOR_REAL_AI !== '1'
}

export function getOfferHtmlGenerator(env: Record<string, string | undefined> = process.env): OfferHtmlGenerator {
  return shouldUseFakeOfferGenerator(env) ? createFakeOfferHtmlGenerator() : createAiOfferHtmlGenerator()
}

export function resolveOfferHtmlGenerator(container: { resolve: <T = unknown>(name: string) => T }): OfferHtmlGenerator {
  try {
    const registered = container.resolve<OfferHtmlGenerator | null>('offerHtmlGenerator')
    if (registered && typeof registered.stream === 'function') return registered
  } catch {
    return getOfferHtmlGenerator()
  }
  return getOfferHtmlGenerator()
}

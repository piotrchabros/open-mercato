import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import { streamText } from 'ai'
import {
  AiModelFactoryError,
  createModelFactory,
} from '@open-mercato/ai-assistant/modules/ai_assistant/lib/model-factory'
import {
  createAiOfferHtmlGenerator,
  createFakeOfferHtmlGenerator,
  FAKE_INCOMPLETE_MARKER,
  getOfferHtmlGenerator,
  OfferAiNotConfiguredError,
  OfferGenerationError,
  readOfferAiLimits,
  resolveOfferHtmlGenerator,
  resolveOfferModel,
  shouldUseFakeOfferGenerator,
  type OfferHtmlStreamInput,
  type OfferModelResolution,
} from '../lib/ai-client'
import { checkOfferHtmlComplete } from '../lib/html-validate'

jest.mock('ai', () => ({ streamText: jest.fn() }))
jest.mock('@open-mercato/ai-assistant/modules/ai_assistant/lib/model-factory', () => {
  class MockAiModelFactoryError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.name = 'AiModelFactoryError'
      this.code = code
    }
  }
  return { AiModelFactoryError: MockAiModelFactoryError, createModelFactory: jest.fn() }
})
jest.mock(
  '@open-mercato/ai-assistant/modules/ai_assistant/data/repositories/AiTenantModelAllowlistRepository',
  () => ({
    AiTenantModelAllowlistRepository: jest.fn().mockImplementation(() => ({
      getSnapshot: jest.fn(async () => ({ allowedProviders: ['google'], allowedModelsByProvider: {} })),
    })),
  }),
)

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}

const template = `<!DOCTYPE html><html lang="en"><head><title>T</title></head><body><section class="card"><p>${'Template content for the offer body. '.repeat(10)}</p></section></body></html>`

function baseInput(overrides: Partial<OfferHtmlStreamInput> = {}): OfferHtmlStreamInput {
  return {
    resolution: null,
    system: 'system',
    prompt: 'prompt',
    language: 'pl',
    source: { kind: 'generate', brief: 'Website for Acme\nMore details', template },
    ...overrides,
  }
}

function fakeResolution(): OfferModelResolution {
  return { model: {} as OfferModelResolution['model'], providerId: 'google', modelId: 'gemini-test' }
}

function mockStream(chunks: string[], finishReason: string, error?: unknown): void {
  ;(streamText as jest.Mock).mockImplementation((options: { onError?: (event: { error: unknown }) => void }) => ({
    textStream: (async function* () {
      for (const chunk of chunks) yield chunk
      if (error) options.onError?.({ error })
    })(),
    finishReason: Promise.resolve(finishReason),
  }))
}

describe('offer generator selection', () => {
  it('uses the fake generator only in integration tests without the real-AI opt-in', () => {
    expect(shouldUseFakeOfferGenerator({ OM_INTEGRATION_TEST: 'true' })).toBe(true)
    expect(shouldUseFakeOfferGenerator({ OM_INTEGRATION_TEST: 'true', OM_OFFER_GENERATOR_REAL_AI: '1' })).toBe(false)
    expect(shouldUseFakeOfferGenerator({ OM_INTEGRATION_TEST: 'false' })).toBe(false)
    expect(shouldUseFakeOfferGenerator({})).toBe(false)
    expect(getOfferHtmlGenerator({ OM_INTEGRATION_TEST: '1' }).id).toBe('fake')
    expect(getOfferHtmlGenerator({}).id).toBe('ai')
    expect(getOfferHtmlGenerator({}).requiresModel).toBe(true)
  })

  it('prefers a DI-registered generator and falls back when none is registered', () => {
    const registered = createFakeOfferHtmlGenerator()
    expect(resolveOfferHtmlGenerator({ resolve: <T,>() => registered as T })).toBe(registered)
    const missing = resolveOfferHtmlGenerator({
      resolve: () => {
        throw new Error('not registered')
      },
    })
    expect(['ai', 'fake']).toContain(missing.id)
  })

  it('reads limits from env with defaults', () => {
    expect(readOfferAiLimits({})).toEqual({ maxOutputTokens: 65536, timeoutMs: 300000 })
    expect(
      readOfferAiLimits({ OM_OFFER_GENERATOR_MAX_OUTPUT_TOKENS: '1000', OM_OFFER_GENERATOR_AI_TIMEOUT_MS: 'abc' }),
    ).toEqual({ maxOutputTokens: 1000, timeoutMs: 300000 })
  })
})

describe('fake offer generator', () => {
  const generator = createFakeOfferHtmlGenerator()

  it('fills the template with the brief heading and language', async () => {
    const onText = jest.fn()
    const result = await generator.stream(baseInput({ onText }))
    expect(result.finishReason).toBe('stop')
    expect(result.text).toContain('<html lang="pl">')
    expect(result.text).toContain('<h1 data-fake-generate>Website for Acme</h1>')
    expect(checkOfferHtmlComplete(result.text).ok).toBe(true)
    expect(onText).toHaveBeenCalled()
  })

  it('appends refine feedback before the body close', async () => {
    const result = await generator.stream(
      baseInput({ source: { kind: 'refine', strippedHtml: template, feedback: 'Add <b>FAQ</b>' } }),
    )
    expect(result.text).toContain('<p data-fake-refine>Add &lt;b&gt;FAQ&lt;/b&gt;</p></body>')
  })

  it('returns incomplete HTML when the marker is present', async () => {
    const result = await generator.stream(
      baseInput({ source: { kind: 'generate', brief: `Brief ${FAKE_INCOMPLETE_MARKER}`, template } }),
    )
    expect(result.text).not.toContain('</html>')
  })
})

describe('resolveOfferModel', () => {
  const container = {} as AwilixContainer
  const em = {} as EntityManager

  it('passes overrides and the tenant allowlist to the model factory', async () => {
    const resolveModel = jest.fn(() => ({ model: { id: 'm' }, providerId: 'google', modelId: 'gemini-x' }))
    ;(createModelFactory as jest.Mock).mockReturnValue({ resolveModel })
    const resolution = await resolveOfferModel(container, em, scope, {
      modelOverride: ' gemini-x ',
      settingsDefaultModel: '',
    })
    expect(resolution).toMatchObject({ providerId: 'google', modelId: 'gemini-x' })
    expect(resolveModel).toHaveBeenCalledWith({
      moduleId: 'offer_generator',
      callerOverride: 'gemini-x',
      providerOverride: undefined,
      agentDefaultModel: undefined,
      tenantAllowlist: { allowedProviders: ['google'], allowedModelsByProvider: {} },
    })
  })

  it('wraps model factory errors as not configured', async () => {
    ;(createModelFactory as jest.Mock).mockReturnValue({
      resolveModel: () => {
        throw new AiModelFactoryError('no_provider_configured', 'none')
      },
    })
    await expect(resolveOfferModel(container, em, scope)).rejects.toBeInstanceOf(OfferAiNotConfiguredError)
  })
})

describe('AI offer generator', () => {
  const generator = createAiOfferHtmlGenerator()

  it('accumulates the text stream', async () => {
    mockStream(['<html>', '</html>'], 'stop')
    const onText = jest.fn()
    const result = await generator.stream(baseInput({ resolution: fakeResolution(), onText }))
    expect(result).toEqual({ text: '<html></html>', finishReason: 'stop' })
    expect(onText).toHaveBeenLastCalledWith('</html>', 13)
    expect(streamText).toHaveBeenCalledWith(expect.objectContaining({ system: 'system', prompt: 'prompt' }))
  })

  it('maps a length finish to max_tokens', async () => {
    mockStream(['<html>'], 'length')
    await expect(generator.stream(baseInput({ resolution: fakeResolution() }))).rejects.toMatchObject({
      code: 'max_tokens',
    })
  })

  it('maps other finish reasons and stream errors to provider_error', async () => {
    mockStream(['<html>'], 'content-filter')
    await expect(generator.stream(baseInput({ resolution: fakeResolution() }))).rejects.toMatchObject({
      code: 'provider_error',
    })
    mockStream(['<html>'], 'stop', new Error('boom'))
    const error = await generator.stream(baseInput({ resolution: fakeResolution() })).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(OfferGenerationError)
    expect((error as OfferGenerationError).code).toBe('provider_error')
  })

  it('requires a resolved model', async () => {
    await expect(generator.stream(baseInput())).rejects.toBeInstanceOf(OfferAiNotConfiguredError)
  })
})

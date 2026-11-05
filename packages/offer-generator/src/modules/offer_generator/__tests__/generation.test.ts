import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { isCrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { Offer, OfferGenerationRun } from '../data/entities'
import type { GenerateOfferJob } from '../data/validators'
import { emitOfferGeneratorEvent } from '../events'
import {
  OfferGenerationError,
  type OfferHtmlGenerator,
  type OfferHtmlStreamInput,
} from '../lib/ai-client'
import { OFFER_COMMAND_IDS } from '../commands/offers'
import {
  allowedSettingsModels,
  computeGenerationPercent,
  executeGenerationRun,
  startGenerationRun,
} from '../lib/generation'
import { enqueueGenerateOffer } from '../lib/queue'
import { buildDefaultSettingsValues, getOfferGeneratorSettings } from '../lib/settings'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
  findWithDecryption: jest.fn(),
}))
jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({ translate: (key: string) => key })),
}))
jest.mock('../lib/queue', () => ({ enqueueGenerateOffer: jest.fn(async () => 'job-1') }))
jest.mock('../events', () => ({ emitOfferGeneratorEvent: jest.fn(async () => undefined) }))
jest.mock('../lib/settings', () => {
  const actual = jest.requireActual('../lib/settings')
  return { ...actual, getOfferGeneratorSettings: jest.fn() }
})

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}
const offerId = '33333333-3333-4333-8333-333333333333'
const runId = '44444444-4444-4444-8444-444444444444'
const progressJobId = '55555555-5555-4555-8555-555555555555'
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const findOne = findOneWithDecryption as jest.Mock
const settingsMock = getOfferGeneratorSettings as jest.Mock
const emitMock = emitOfferGeneratorEvent as jest.Mock
const enqueueMock = enqueueGenerateOffer as jest.Mock

type NativeUpdateCall = { entity: unknown; where: Record<string, unknown>; data: Record<string, unknown> }

function buildHtml(marker: string, size = 6): string {
  const paragraph = `<p>${marker} ${'Offer content describing services and pricing in detail. '.repeat(size)}</p>`
  return `<!DOCTYPE html><html lang="pl"><head><title>${marker}</title></head><body><section class="card">${paragraph}</section></body></html>`
}

function buildOffer(overrides: Partial<Offer> = {}): Offer {
  const offer = new Offer()
  Object.assign(offer, {
    id: offerId,
    ...scope,
    title: 'Website offer',
    clientName: 'Acme',
    language: 'pl',
    status: 'draft',
    slug: 'acme-2026-11',
    accessToken: 'abcdefghijk1',
    prompt: 'Website for Acme with three packages',
    html: null,
    generationStatus: 'idle',
    lastGenerationRunId: null,
    deletedAt: null,
    ...overrides,
  })
  return offer
}

function buildRun(overrides: Partial<OfferGenerationRun> = {}): OfferGenerationRun {
  const run = new OfferGenerationRun()
  Object.assign(run, {
    id: runId,
    ...scope,
    offerId,
    kind: 'generate',
    inputText: 'Website for Acme with three packages',
    language: 'pl',
    status: 'queued',
    progressJobId,
    providerId: null,
    modelId: null,
    ...overrides,
  })
  return run
}

function createEm(options: { nativeUpdateResult?: (call: NativeUpdateCall) => number; activeRuns?: OfferGenerationRun[] } = {}) {
  const calls: NativeUpdateCall[] = []
  const persisted: unknown[] = []
  const em = {
    fork: () => em,
    nativeUpdate: jest.fn(async (entity: unknown, where: Record<string, unknown>, data: Record<string, unknown>) => {
      const call = { entity, where, data }
      calls.push(call)
      return options.nativeUpdateResult ? options.nativeUpdateResult(call) : 1
    }),
    find: jest.fn(async () => options.activeRuns ?? []),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ ...data })),
    persist: jest.fn((entity: unknown) => {
      persisted.push(entity)
    }),
    flush: jest.fn(async () => undefined),
  }
  return { em, calls, persisted }
}

function createProgressService() {
  return {
    createJob: jest.fn(async () => ({ id: progressJobId })),
    startJob: jest.fn(async () => ({})),
    updateProgress: jest.fn(async () => ({})),
    completeJob: jest.fn(async () => ({})),
    failJob: jest.fn(async () => ({})),
    touchJobHeartbeat: jest.fn(async () => undefined),
  }
}

function createGenerator(handler: (input: OfferHtmlStreamInput) => Promise<{ text: string; finishReason: string }>): OfferHtmlGenerator & {
  stream: jest.Mock
} {
  return { id: 'test', requiresModel: false, stream: jest.fn(handler) }
}

function createRuntime(services: Record<string, unknown>) {
  return {
    resolve: <T,>(name: string): T => {
      if (!(name in services)) throw new Error(`missing ${name}`)
      return services[name] as T
    },
  }
}

const job: GenerateOfferJob = { runId, ...scope, userId }

beforeEach(() => {
  jest.clearAllMocks()
  settingsMock.mockResolvedValue({ ...buildDefaultSettingsValues(), defaultModel: 'gemini-a', alternateModels: ['gemini-b'] })
})

describe('generation helpers', () => {
  it('lists allowed settings models without duplicates', () => {
    expect(allowedSettingsModels({ defaultModel: 'a', alternateModels: ['b', 'a', ' '] })).toEqual(['a', 'b'])
  })

  it('caps the running percent', () => {
    expect(computeGenerationPercent(0)).toBe(0)
    expect(computeGenerationPercent(30000)).toBe(50)
    expect(computeGenerationPercent(600000)).toBe(95)
  })
})

describe('executeGenerationRun', () => {
  function setupRun(run: OfferGenerationRun, offer: Offer) {
    findOne.mockImplementation(async (_em: unknown, entity: unknown) => {
      if (entity === OfferGenerationRun) return run
      if (entity === Offer) return offer
      return null
    })
  }

  it('applies generated HTML through the update_html command and completes the run', async () => {
    setupRun(buildRun(), buildOffer())
    const { em, calls } = createEm()
    const progress = createProgressService()
    const commandBus = { execute: jest.fn(async () => ({ result: { offerId, revisionId: null } })) }
    const generator = createGenerator(async (input) => {
      input.onText?.('x', 70000)
      return { text: '```html\n' + buildHtml('Generated') + '\n```', finishReason: 'stop' }
    })
    const runtime = createRuntime({ em, progressService: progress, commandBus, offerHtmlGenerator: generator })

    const result = await executeGenerationRun(runtime, job)

    expect(result).toEqual({ status: 'completed', runId, revisionId: null })
    expect(progress.startJob).toHaveBeenCalledWith(progressJobId, expect.objectContaining(scope))
    expect(progress.completeJob).toHaveBeenCalled()
    const [commandId, options] = commandBus.execute.mock.calls[0] as unknown as [
      string,
      { input: Record<string, unknown>; ctx: { systemActor: boolean; organizationScope: { tenantId: string } } },
    ]
    expect(commandId).toBe(OFFER_COMMAND_IDS.updateHtml)
    expect(options.input).toMatchObject({ id: offerId, source: 'generate', generationRunId: runId, feedback: null })
    expect(String(options.input.html).startsWith('<!DOCTYPE html>')).toBe(true)
    expect(options.ctx.systemActor).toBe(true)
    expect(options.ctx.organizationScope.tenantId).toBe(scope.tenantId)
    const runCompleted = calls.find((call) => call.entity === OfferGenerationRun && call.data.status === 'completed')
    expect(runCompleted?.data).toMatchObject({ resultRevisionId: null, bytesReceived: 70000, chunks: 1 })
    const offerIdle = calls.find((call) => call.entity === Offer && call.data.generationStatus === 'idle')
    expect(offerIdle).toBeDefined()
    expect(emitMock).toHaveBeenCalledWith(
      'offer_generator.generation.completed',
      expect.objectContaining({ offerId, runId, kind: 'generate' }),
      expect.anything(),
    )
  })

  it('fails the run on incomplete HTML without touching the offer content', async () => {
    setupRun(buildRun(), buildOffer())
    const { em, calls } = createEm()
    const progress = createProgressService()
    const commandBus = { execute: jest.fn() }
    const generator = createGenerator(async () => ({
      text: buildHtml('Broken').replace('</html>', ''),
      finishReason: 'stop',
    }))
    const runtime = createRuntime({ em, progressService: progress, commandBus, offerHtmlGenerator: generator })

    const result = await executeGenerationRun(runtime, job)

    expect(result).toEqual({ status: 'failed', runId, errorCode: 'incomplete_html' })
    expect(commandBus.execute).not.toHaveBeenCalled()
    expect(progress.failJob).toHaveBeenCalledWith(progressJobId, { errorMessage: 'incomplete_html' }, expect.anything())
    expect(calls.find((call) => call.entity === OfferGenerationRun && call.data.status === 'failed')?.data).toMatchObject({
      errorCode: 'incomplete_html',
    })
    expect(calls.find((call) => call.entity === Offer && call.data.generationStatus === 'failed')).toBeDefined()
    expect(emitMock).toHaveBeenCalledWith('offer_generator.generation.failed', expect.anything(), expect.anything())
  })

  it('rejects a refine that shrinks the offer and restores image placeholders on success', async () => {
    const image = `data:image/png;base64,${'A'.repeat(400)}`
    const baseHtml = buildHtml('Base', 60).replace('<section', `<img src="${image}"><section`)
    setupRun(buildRun({ kind: 'refine', inputText: 'Shorten everything' }), buildOffer({ html: baseHtml }))
    const { em } = createEm()
    const progress = createProgressService()
    const commandBus = { execute: jest.fn(async () => ({ result: { offerId, revisionId: 'rev-1' } })) }
    const shrinking = createGenerator(async () => ({ text: buildHtml('Short'), finishReason: 'stop' }))

    const shrunk = await executeGenerationRun(
      createRuntime({ em, progressService: progress, commandBus, offerHtmlGenerator: shrinking }),
      job,
    )
    expect(shrunk).toEqual({ status: 'failed', runId, errorCode: 'refine_shrunk' })
    const refineInput = shrinking.stream.mock.calls[0][0] as OfferHtmlStreamInput
    expect(refineInput.source.kind).toBe('refine')
    expect(refineInput.prompt).toContain('__IMG_0__')
    expect(refineInput.prompt).not.toContain(image)

    setupRun(buildRun({ kind: 'refine', inputText: 'Add FAQ' }), buildOffer({ html: baseHtml }))
    const echoing = createGenerator(async (input) => ({
      text: input.source.kind === 'refine' ? input.source.strippedHtml : '',
      finishReason: 'stop',
    }))
    const refined = await executeGenerationRun(
      createRuntime({ em, progressService: progress, commandBus, offerHtmlGenerator: echoing }),
      job,
    )
    expect(refined).toEqual({ status: 'completed', runId, revisionId: 'rev-1' })
    const [, options] = commandBus.execute.mock.calls[0] as unknown as [string, { input: { html: string; feedback: string } }]
    expect(options.input.html).toContain(image)
    expect(options.input.feedback).toBe('Add FAQ')
  })

  it('records max_tokens failures from the generator', async () => {
    setupRun(buildRun(), buildOffer())
    const { em } = createEm()
    const progress = createProgressService()
    const generator = createGenerator(async () => {
      throw new OfferGenerationError('max_tokens')
    })
    const result = await executeGenerationRun(
      createRuntime({ em, progressService: progress, commandBus: { execute: jest.fn() }, offerHtmlGenerator: generator }),
      job,
    )
    expect(result).toEqual({ status: 'failed', runId, errorCode: 'max_tokens' })
    expect(progress.failJob).toHaveBeenCalledWith(progressJobId, { errorMessage: 'max_tokens' }, expect.anything())
  })

  it('skips runs that are no longer queued', async () => {
    setupRun(buildRun({ status: 'completed' }), buildOffer())
    const { em } = createEm()
    const generator = createGenerator(async () => ({ text: '', finishReason: 'stop' }))
    const result = await executeGenerationRun(createRuntime({ em, offerHtmlGenerator: generator }), job)
    expect(result).toEqual({ status: 'skipped', runId })
    expect(generator.stream).not.toHaveBeenCalled()
  })
})

describe('startGenerationRun', () => {
  function container(services: Record<string, unknown>): AwilixContainer {
    return createRuntime(services) as unknown as AwilixContainer
  }

  async function expectHttpError(promise: Promise<unknown>, status: number): Promise<void> {
    const error = await promise.catch((err: unknown) => err)
    expect(isCrudHttpError(error)).toBe(true)
    expect((error as { status: number }).status).toBe(status)
  }

  const fakeGenerator: OfferHtmlGenerator = { id: 'fake', requiresModel: false, stream: jest.fn() }

  it('creates a run, a progress job and enqueues the worker job', async () => {
    findOne.mockResolvedValue(buildOffer())
    const { em, persisted, calls } = createEm()
    const progress = createProgressService()

    const result = await startGenerationRun({
      container: container({ progressService: progress, offerHtmlGenerator: fakeGenerator }),
      em: em as unknown as EntityManager,
      scope,
      userId,
      offerId,
      input: { kind: 'generate', model: 'gemini-b' },
    })

    expect(result.progressJobId).toBe(progressJobId)
    expect(persisted[0]).toMatchObject({ id: result.runId, kind: 'generate', status: 'queued', inputText: 'Website for Acme with three packages' })
    expect(progress.createJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobType: 'offer_generator.offers.generate', cancellable: false }),
      expect.objectContaining({ ...scope, userId }),
    )
    expect(enqueueMock).toHaveBeenCalledWith({ runId: result.runId, ...scope, userId })
    const claim = calls.find((call) => call.entity === Offer && call.data.generationStatus === 'queued')
    expect(claim?.data).toEqual({ generationStatus: 'queued', lastGenerationRunId: result.runId })
    expect(emitMock).toHaveBeenCalledWith('offer_generator.generation.started', expect.anything(), expect.anything())
  })

  it('returns 404 for a missing offer and 400 for refine without HTML or a foreign model', async () => {
    const { em } = createEm()
    const deps = { container: container({ offerHtmlGenerator: fakeGenerator }), em: em as unknown as EntityManager, scope, userId, offerId }
    findOne.mockResolvedValue(null)
    await expectHttpError(startGenerationRun({ ...deps, input: { kind: 'generate' } }), 404)
    findOne.mockResolvedValue(buildOffer())
    await expectHttpError(startGenerationRun({ ...deps, input: { kind: 'refine', feedback: 'More detail' } }), 400)
    await expectHttpError(startGenerationRun({ ...deps, input: { kind: 'generate', model: 'other-model' } }), 400)
  })

  it('returns 409 when a fresh run is active or the claim is lost', async () => {
    findOne.mockResolvedValue(buildOffer({ generationStatus: 'running' }))
    const active = createEm({ activeRuns: [buildRun({ status: 'running', updatedAt: new Date() })] })
    const deps = { container: container({ offerHtmlGenerator: fakeGenerator }), scope, userId, offerId, input: { kind: 'generate' as const } }
    await expectHttpError(startGenerationRun({ ...deps, em: active.em as unknown as EntityManager }), 409)

    findOne.mockResolvedValue(buildOffer())
    const lost = createEm({ nativeUpdateResult: () => 0 })
    await expectHttpError(startGenerationRun({ ...deps, em: lost.em as unknown as EntityManager }), 409)
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it('returns 503 when the AI model cannot be resolved', async () => {
    findOne.mockResolvedValue(buildOffer())
    const { em } = createEm()
    const realGenerator: OfferHtmlGenerator = { id: 'ai', requiresModel: true, stream: jest.fn() }
    const previous = { ...process.env }
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('OM_AI_') || key.endsWith('_API_KEY') || key.startsWith('OPENCODE_')) delete process.env[key]
    }
    try {
      await expectHttpError(
        startGenerationRun({
          container: container({ offerHtmlGenerator: realGenerator }),
          em: { ...em, findOne: jest.fn(async () => null) } as unknown as EntityManager,
          scope,
          userId,
          offerId,
          input: { kind: 'generate' },
        }),
        503,
      )
    } finally {
      process.env = previous
    }
  })
})

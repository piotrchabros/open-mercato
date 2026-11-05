import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { POST as startGeneration } from '../api/offers/[id]/generate/route'
import { GET as getRun } from '../api/generation-runs/[id]/route'
import { startGenerationRun } from '../lib/generation'

const TENANT_ID = '7a1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f61'
const ORG_ID = '8b1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f62'
const USER_ID = '5d1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f64'
const OFFER_ID = '6f1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f60'
const RUN_ID = '4e1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f65'
const JOB_ID = '3f1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f66'
const ISO = '2026-11-04T11:00:00.000Z'

const fakeEm = { fork: () => fakeEm }

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: (name: string) => {
      if (name === 'em') return fakeEm
      throw new Error(`unexpected ${name}`)
    },
  })),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({ translate: (_key: string, fallback: string) => fallback })),
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn(),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: jest.fn(async () => ({
    selectedId: '8b1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f62',
    filterIds: ['8b1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f62'],
    allowedIds: null,
    tenantId: '7a1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f61',
  })),
}))

jest.mock('@open-mercato/shared/lib/crud/route-mutation-guard', () => ({
  runRouteMutationGuards: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))

jest.mock('../commands/offers', () => ({
  OFFER_RESOURCE_KIND: 'offer_generator.offer',
}))

jest.mock('../lib/generation', () => ({
  startGenerationRun: jest.fn(),
}))

const authMock = getAuthFromRequest as jest.MockedFunction<typeof getAuthFromRequest>
const guardsMock = runRouteMutationGuards as jest.MockedFunction<typeof runRouteMutationGuards>
const findMock = findOneWithDecryption as unknown as jest.Mock
const startMock = startGenerationRun as jest.MockedFunction<typeof startGenerationRun>
const runAfterSuccess = jest.fn(async () => undefined)

const params = (id: string) => ({ params: Promise.resolve({ id }) })

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  authMock.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, orgId: ORG_ID } as Awaited<
    ReturnType<typeof getAuthFromRequest>
  >)
  guardsMock.mockResolvedValue({ ok: true, runAfterSuccess })
  startMock.mockResolvedValue({ runId: RUN_ID, progressJobId: JOB_ID })
})

describe('generate route', () => {
  const url = `https://crm.example.com/api/offer_generator/offers/${OFFER_ID}/generate`
  const validBody = { kind: 'generate', prompt: 'Prepare an offer for a website redesign' }

  it('requires the generate feature', async () => {
    const { metadata } = await import('../api/offers/[id]/generate/route')
    expect(metadata.POST.requireFeatures).toEqual(['offer_generator.generate'])
  })

  it('answers 401 without a session', async () => {
    authMock.mockResolvedValue(null)
    expect((await startGeneration(jsonRequest(url, validBody), params(OFFER_ID))).status).toBe(401)
  })

  it('answers 400 for an invalid body', async () => {
    const res = await startGeneration(jsonRequest(url, { kind: 'refine' }), params(OFFER_ID))
    expect(res.status).toBe(400)
    expect(startMock).not.toHaveBeenCalled()
  })

  it('answers 404 for a malformed offer id', async () => {
    expect((await startGeneration(jsonRequest(url, validBody), params('nope'))).status).toBe(404)
  })

  it('guards the mutation and answers 202 with the run ids', async () => {
    const res = await startGeneration(jsonRequest(url, validBody), params(OFFER_ID))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ runId: RUN_ID, progressJobId: JOB_ID })
    expect(guardsMock.mock.calls[0][0].input).toMatchObject({
      resourceKind: 'offer_generator.offer',
      resourceId: OFFER_ID,
      operation: 'update',
    })
    expect(startMock.mock.calls[0][0]).toMatchObject({
      scope: { tenantId: TENANT_ID, organizationId: ORG_ID },
      userId: USER_ID,
      offerId: OFFER_ID,
      input: validBody,
    })
    expect(runAfterSuccess).toHaveBeenCalled()
  })

  it('returns the guard response when a mutation guard blocks', async () => {
    guardsMock.mockResolvedValue({ ok: false, response: Response.json({ error: 'blocked' }, { status: 423 }) })
    expect((await startGeneration(jsonRequest(url, validBody), params(OFFER_ID))).status).toBe(423)
    expect(startMock).not.toHaveBeenCalled()
  })

  it.each([404, 409, 503])('maps a CrudHttpError %s to its status and body', async (status) => {
    startMock.mockRejectedValue(new CrudHttpError(status, { error: 'nope', code: 'some_code' }))
    const res = await startGeneration(jsonRequest(url, validBody), params(OFFER_ID))
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({ code: 'some_code' })
    expect(runAfterSuccess).not.toHaveBeenCalled()
  })

  it('answers 500 for unexpected failures', async () => {
    startMock.mockRejectedValue(new Error('boom'))
    expect((await startGeneration(jsonRequest(url, validBody), params(OFFER_ID))).status).toBe(500)
  })
})

describe('generation run route', () => {
  const url = `https://crm.example.com/api/offer_generator/generation-runs/${RUN_ID}`

  it('returns the serialized run scoped to tenant and organization', async () => {
    findMock.mockResolvedValue({
      id: RUN_ID,
      offerId: OFFER_ID,
      kind: 'generate',
      status: 'running',
      providerId: 'anthropic',
      modelId: 'claude',
      language: 'pl',
      bytesReceived: 120,
      errorCode: null,
      progressJobId: JOB_ID,
      resultRevisionId: null,
      startedAt: new Date(ISO),
      finishedAt: null,
      createdAt: new Date(ISO),
      inputText: 'secret prompt',
    })
    const res = await getRun(new Request(url), params(RUN_ID))
    expect(res.status).toBe(200)
    const payload = await res.json()
    expect(payload).toMatchObject({ id: RUN_ID, offerId: OFFER_ID, status: 'running', bytesReceived: 120, startedAt: ISO })
    expect(payload).not.toHaveProperty('inputText')
    expect(findMock.mock.calls[0][2]).toEqual({ id: RUN_ID, tenantId: TENANT_ID, organizationId: ORG_ID })
  })

  it('answers 404 for an unknown run', async () => {
    findMock.mockResolvedValue(null)
    expect((await getRun(new Request(url), params(RUN_ID))).status).toBe(404)
  })

  it('answers 404 for a malformed id without querying', async () => {
    expect((await getRun(new Request(url), params('nope'))).status).toBe(404)
    expect(findMock).not.toHaveBeenCalled()
  })

  it('answers 401 without a session', async () => {
    authMock.mockResolvedValue(null)
    expect((await getRun(new Request(url), params(RUN_ID))).status).toBe(401)
  })
})

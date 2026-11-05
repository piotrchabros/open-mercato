import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { GET as getHtml, PUT as putHtml } from '../api/offers/[id]/html/route'
import { GET as listRevisions, POST as restoreRevision } from '../api/offers/[id]/revisions/route'
import { GET as getSettings, PUT as putSettings } from '../api/settings/route'
import { GET as renderOffer } from '../api/render/offers/[id]/route'
import { getOfferGeneratorSettings } from '../lib/settings'

const TENANT_ID = '7a1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f61'
const ORG_ID = '8b1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f62'
const USER_ID = '5d1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f64'
const OFFER_ID = '6f1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f60'
const REVISION_ID = '9c1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f63'
const LOCK_HEADER = 'x-om-ext-optimistic-lock-expected-updated-at'
const LOCK_TOKEN = '2026-11-04T11:00:00.000Z'
const VALID_HTML = `<!DOCTYPE html><html><head><title>Offer</title></head><body><h1>Offer</h1><p>${'x'.repeat(250)}</p></body></html>`

const commandExecute = jest.fn()
const connectionExecute = jest.fn()
const fakeEm = {
  fork: () => fakeEm,
  getConnection: () => ({ execute: connectionExecute }),
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: (name: string) => {
      if (name === 'em') return fakeEm
      if (name === 'commandBus') return { execute: commandExecute }
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
  OFFER_COMMAND_IDS: { updateHtml: 'offer_generator.offers.update_html' },
}))

jest.mock('../commands/settings', () => ({
  SETTINGS_RESOURCE_KIND: 'offer_generator.settings',
  SETTINGS_COMMAND_IDS: { upsert: 'offer_generator.settings.upsert' },
}))

jest.mock('../lib/settings', () => ({
  getOfferGeneratorSettings: jest.fn(),
}))

const authMock = getAuthFromRequest as jest.MockedFunction<typeof getAuthFromRequest>
const guardsMock = runRouteMutationGuards as jest.MockedFunction<typeof runRouteMutationGuards>
const findMock = findOneWithDecryption as unknown as jest.Mock
const settingsMock = getOfferGeneratorSettings as jest.MockedFunction<typeof getOfferGeneratorSettings>
const runAfterSuccess = jest.fn(async () => undefined)

const params = (id: string) => ({ params: Promise.resolve({ id }) })

function jsonRequest(url: string, method: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const SETTINGS_VALUES = {
  id: null,
  companyName: '',
  templateHtml: VALID_HTML,
  extraInstructions: null,
  defaultLanguage: 'pl' as const,
  defaultCurrency: 'PLN',
  defaultModel: null,
  alternateModels: [],
  updatedAt: null,
}

beforeEach(() => {
  jest.clearAllMocks()
  authMock.mockResolvedValue({ sub: USER_ID, tenantId: TENANT_ID, orgId: ORG_ID } as Awaited<
    ReturnType<typeof getAuthFromRequest>
  >)
  guardsMock.mockResolvedValue({ ok: true, runAfterSuccess })
  commandExecute.mockResolvedValue({
    result: { offerId: OFFER_ID, revisionId: REVISION_ID, htmlUpdatedAt: LOCK_TOKEN, updatedAt: LOCK_TOKEN },
  })
  settingsMock.mockResolvedValue(SETTINGS_VALUES)
})

describe('offer HTML route', () => {
  const url = `https://crm.example.com/api/offer_generator/offers/${OFFER_ID}/html`

  it('returns the HTML scoped to the active organization', async () => {
    findMock.mockResolvedValue({ id: OFFER_ID, html: VALID_HTML, updatedAt: new Date(LOCK_TOKEN) })
    const res = await getHtml(new Request(url), params(OFFER_ID))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ html: VALID_HTML, updatedAt: LOCK_TOKEN })
    expect(findMock.mock.calls[0][2]).toMatchObject({ id: OFFER_ID, tenantId: TENANT_ID, organizationId: ORG_ID, deletedAt: null })
  })

  it('answers 404 for an unknown offer', async () => {
    findMock.mockResolvedValue(null)
    expect((await getHtml(new Request(url), params(OFFER_ID))).status).toBe(404)
  })

  it('runs mutation guards then update_html as a manual edit with the lock token', async () => {
    const res = await putHtml(jsonRequest(url, 'PUT', { html: VALID_HTML }, { [LOCK_HEADER]: LOCK_TOKEN }), params(OFFER_ID))
    expect(res.status).toBe(200)
    expect(guardsMock.mock.calls[0][0].input).toMatchObject({
      resourceKind: 'offer_generator.offer',
      resourceId: OFFER_ID,
      operation: 'update',
    })
    const [commandId, { input, ctx }] = commandExecute.mock.calls[0]
    expect(commandId).toBe('offer_generator.offers.update_html')
    expect(input).toEqual({ id: OFFER_ID, html: VALID_HTML, source: 'manual_edit', expectedUpdatedAt: LOCK_TOKEN })
    expect(ctx.selectedOrganizationId).toBe(ORG_ID)
    expect(runAfterSuccess).toHaveBeenCalledTimes(1)
  })

  it('returns the guard response when a guard blocks the write', async () => {
    guardsMock.mockResolvedValue({
      ok: false,
      errorStatus: 423,
      errorBody: { error: 'locked' },
      response: Response.json({ error: 'locked' }, { status: 423 }),
    })
    const res = await putHtml(jsonRequest(url, 'PUT', { html: VALID_HTML }), params(OFFER_ID))
    expect(res.status).toBe(423)
    expect(commandExecute).not.toHaveBeenCalled()
  })

  it('rejects a too-short body with 400 before touching the command', async () => {
    const res = await putHtml(jsonRequest(url, 'PUT', { html: '<p>x</p>' }), params(OFFER_ID))
    expect(res.status).toBe(400)
    expect(guardsMock).not.toHaveBeenCalled()
  })

  it('passes command conflicts through', async () => {
    commandExecute.mockRejectedValue(
      new CrudHttpError(409, { error: 'record_modified', code: 'optimistic_lock_conflict' }),
    )
    const res = await putHtml(jsonRequest(url, 'PUT', { html: VALID_HTML }, { [LOCK_HEADER]: 'stale' }), params(OFFER_ID))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'optimistic_lock_conflict' })
    expect(runAfterSuccess).not.toHaveBeenCalled()
  })
})

describe('offer revisions route', () => {
  const url = `https://crm.example.com/api/offer_generator/offers/${OFFER_ID}/revisions`

  it('lists revisions without HTML', async () => {
    findMock.mockResolvedValue({ id: OFFER_ID })
    connectionExecute.mockResolvedValue([
      {
        id: REVISION_ID,
        source: 'generate',
        feedback: null,
        generation_run_id: null,
        created_by_user_id: USER_ID,
        created_at: LOCK_TOKEN,
        size_bytes: '1234',
      },
    ])
    const res = await listRevisions(new Request(url), params(OFFER_ID))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toEqual([
      {
        id: REVISION_ID,
        source: 'generate',
        feedback: null,
        generationRunId: null,
        createdByUserId: USER_ID,
        createdAt: LOCK_TOKEN,
        sizeBytes: 1234,
      },
    ])
    const sql = String(connectionExecute.mock.calls[0][0])
    expect(sql).toContain('octet_length(html) as size_bytes')
    expect(sql).not.toMatch(/select [^]*[ ,]html,/)
    expect(connectionExecute.mock.calls[0][1]).toEqual([OFFER_ID, TENANT_ID, ORG_ID, 50])
  })

  it('restores a revision through update_html with source restore', async () => {
    findMock.mockResolvedValue({ id: REVISION_ID, offerId: OFFER_ID, html: VALID_HTML })
    const res = await restoreRevision(
      jsonRequest(url, 'POST', { revisionId: REVISION_ID }, { [LOCK_HEADER]: LOCK_TOKEN }),
      params(OFFER_ID),
    )
    expect(res.status).toBe(200)
    expect(findMock.mock.calls[0][2]).toEqual({
      id: REVISION_ID,
      offerId: OFFER_ID,
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
    })
    const [commandId, { input }] = commandExecute.mock.calls[0]
    expect(commandId).toBe('offer_generator.offers.update_html')
    expect(input).toEqual({ id: OFFER_ID, html: VALID_HTML, source: 'restore', expectedUpdatedAt: LOCK_TOKEN })
  })

  it('answers 404 for a revision outside the offer', async () => {
    findMock.mockResolvedValue(null)
    const res = await restoreRevision(jsonRequest(url, 'POST', { revisionId: REVISION_ID }), params(OFFER_ID))
    expect(res.status).toBe(404)
    expect(commandExecute).not.toHaveBeenCalled()
  })
})

describe('settings route', () => {
  const url = 'https://crm.example.com/api/offer_generator/settings'
  const body = {
    companyName: 'Acme',
    templateHtml: VALID_HTML,
    defaultLanguage: 'en',
    defaultCurrency: 'eur',
    alternateModels: ['google/gemini-3.1-pro-preview'],
  }

  it('returns defaults when no row exists', async () => {
    const res = await getSettings(new Request(url))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ defaultLanguage: 'pl', defaultCurrency: 'PLN', updatedAt: null })
  })

  it('upserts through the command with scope and lock token', async () => {
    settingsMock
      .mockResolvedValueOnce({ ...SETTINGS_VALUES, id: REVISION_ID, updatedAt: new Date(LOCK_TOKEN) })
      .mockResolvedValueOnce({ ...SETTINGS_VALUES, id: REVISION_ID, companyName: 'Acme', updatedAt: new Date() })
    const res = await putSettings(jsonRequest(url, 'PUT', body, { [LOCK_HEADER]: LOCK_TOKEN }))
    expect(res.status).toBe(200)
    expect(guardsMock.mock.calls[0][0].input).toMatchObject({
      resourceKind: 'offer_generator.settings',
      resourceId: REVISION_ID,
      operation: 'update',
    })
    const [commandId, { input }] = commandExecute.mock.calls[0]
    expect(commandId).toBe('offer_generator.settings.upsert')
    expect(input).toMatchObject({
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      companyName: 'Acme',
      defaultCurrency: 'EUR',
      expectedUpdatedAt: LOCK_TOKEN,
    })
    expect((await res.json()).companyName).toBe('Acme')
  })

  it('rejects an invalid body with 400', async () => {
    const res = await putSettings(jsonRequest(url, 'PUT', { ...body, defaultLanguage: 'fr' }))
    expect(res.status).toBe(400)
    expect(commandExecute).not.toHaveBeenCalled()
  })
})

describe('authenticated offer render route', () => {
  const url = `https://crm.example.com/api/offer_generator/render/offers/${OFFER_ID}`

  it('serves sanitized HTML with no-store and noindex', async () => {
    findMock.mockResolvedValue({ id: OFFER_ID, html: VALID_HTML.replace('<h1>', '<script>alert(1)</script><h1 onclick="x()">') })
    const res = await renderOffer(new Request(url), params(OFFER_ID))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('x-robots-tag')).toContain('noindex')
    const html = await res.text()
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onclick')
    expect(html).toContain('<h1>Offer</h1>')
  })

  it('answers 404 when the offer has no HTML', async () => {
    findMock.mockResolvedValue({ id: OFFER_ID, html: null })
    const res = await renderOffer(new Request(url), params(OFFER_ID))
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  it('answers 401 without a session', async () => {
    authMock.mockResolvedValue(null)
    expect((await renderOffer(new Request(url), params(OFFER_ID))).status).toBe(401)
  })
})

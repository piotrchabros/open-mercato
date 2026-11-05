import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { invalidateCrudCache } from '@open-mercato/shared/lib/crud/cache'
import { POST } from '../api/public/sessions/route'
import { emitOfferGeneratorEvent } from '../events'
import { TRACKING } from '../lib/constants'
import { resolvePublicOfferRoute } from '../lib/public-offer'
import { insertView, recordFirstView, touchView } from '../lib/views-repository'

const fakeEm = { tag: 'em' }

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    hasRegistration: (name: string) => name === 'em',
    resolve: (name: string) => {
      if (name === 'em') return { fork: () => fakeEm }
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

jest.mock('@open-mercato/shared/lib/crud/cache', () => ({
  invalidateCrudCache: jest.fn(async () => undefined),
}))

jest.mock('../lib/public-offer', () => ({
  resolvePublicOfferRoute: jest.fn(),
}))

jest.mock('../lib/views-repository', () => ({
  insertView: jest.fn(),
  touchView: jest.fn(),
  recordFirstView: jest.fn(),
}))

jest.mock('../events', () => ({
  emitOfferGeneratorEvent: jest.fn(async () => undefined),
}))

const OFFER = {
  id: '6f1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f60',
  tenantId: '7a1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f61',
  organizationId: '8b1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f62',
  status: 'sent' as const,
}
const VIEW_KEY = '9c1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f63'
const SEGMENT = 'acme-2026-11-abcdef123456'
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

const resolveRouteMock = resolvePublicOfferRoute as jest.MockedFunction<typeof resolvePublicOfferRoute>
const insertViewMock = insertView as jest.MockedFunction<typeof insertView>
const touchViewMock = touchView as jest.MockedFunction<typeof touchView>
const recordFirstViewMock = recordFirstView as jest.MockedFunction<typeof recordFirstView>
const authMock = getAuthFromRequest as jest.MockedFunction<typeof getAuthFromRequest>
const emitMock = emitOfferGeneratorEvent as jest.MockedFunction<typeof emitOfferGeneratorEvent>
const invalidateMock = invalidateCrudCache as jest.MockedFunction<typeof invalidateCrudCache>

function buildRequest(body: unknown, headers: Record<string, string> = {}): Request {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Request('https://crm.example.com/api/offer_generator/public/sessions', {
    method: 'POST',
    body: text,
    headers: {
      host: 'crm.example.com',
      origin: 'https://crm.example.com',
      'content-type': 'text/plain;charset=UTF-8',
      'user-agent': CHROME_UA,
      ...headers,
    },
  })
}

const startBody = { t: 'start', seg: SEGMENT, key: VIEW_KEY, ref: null }

describe('POST /api/offer_generator/public/sessions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resolveRouteMock.mockResolvedValue(OFFER)
    authMock.mockResolvedValue(null)
    insertViewMock.mockResolvedValue(true)
    touchViewMock.mockResolvedValue(true)
    recordFirstViewMock.mockResolvedValue({ firstView: true })
  })

  it('rejects a foreign origin with 403', async () => {
    const res = await POST(buildRequest(startBody, { origin: 'https://evil.example.org' }))
    expect(res.status).toBe(403)
    expect(resolveRouteMock).not.toHaveBeenCalled()
  })

  it('rejects a missing origin with 403', async () => {
    const req = new Request('https://crm.example.com/api/offer_generator/public/sessions', {
      method: 'POST',
      body: JSON.stringify(startBody),
      headers: { host: 'crm.example.com' },
    })
    expect((await POST(req)).status).toBe(403)
  })

  it('rejects oversized bodies with 413', async () => {
    const big = JSON.stringify({ ...startBody, ref: 'x'.repeat(TRACKING.MAX_BODY_BYTES) })
    const res = await POST(buildRequest(big))
    expect(res.status).toBe(413)
    expect(resolveRouteMock).not.toHaveBeenCalled()
  })

  it('rejects malformed bodies with 400', async () => {
    expect((await POST(buildRequest('not json'))).status).toBe(400)
    expect((await POST(buildRequest({ t: 'start', seg: SEGMENT, key: 'nope' }))).status).toBe(400)
  })

  it('answers 404 for an unknown offer', async () => {
    resolveRouteMock.mockResolvedValue(null)
    const res = await POST(buildRequest(startBody))
    expect(res.status).toBe(404)
    expect(insertViewMock).not.toHaveBeenCalled()
  })

  it('does not count bot user agents', async () => {
    const res = await POST(buildRequest(startBody, { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, counted: false })
    expect(insertViewMock).not.toHaveBeenCalled()
  })

  it('counts a browser start, sets the visitor cookie and emits the first view', async () => {
    const res = await POST(buildRequest(startBody))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, counted: true, internal: false })
    expect(res.headers.get('set-cookie')).toContain(`${TRACKING.VISITOR_COOKIE}=${body.visitorId}`)
    expect(insertViewMock).toHaveBeenCalledWith(
      fakeEm,
      expect.objectContaining({
        viewKey: VIEW_KEY,
        offerId: OFFER.id,
        tenantId: OFFER.tenantId,
        organizationId: OFFER.organizationId,
        ipHash: null,
        device: 'desktop',
        browser: 'Chrome',
        os: 'Windows',
        isInternal: false,
      }),
    )
    expect(recordFirstViewMock).toHaveBeenCalledWith(fakeEm, OFFER, { internal: false })
    expect(emitMock).toHaveBeenCalledWith(
      'offer_generator.offer.viewed',
      { offerId: OFFER.id, tenantId: OFFER.tenantId, organizationId: OFFER.organizationId },
      { tenantId: OFFER.tenantId, organizationId: OFFER.organizationId },
    )
    expect(invalidateMock).toHaveBeenCalledWith(
      expect.anything(),
      'offer_generator.offer',
      { id: OFFER.id, organizationId: OFFER.organizationId, tenantId: OFFER.tenantId },
      OFFER.tenantId,
      expect.any(String),
    )
  })

  it('invalidates the offer CRUD cache on a repeat counted view', async () => {
    recordFirstViewMock.mockResolvedValue({ firstView: false })
    await POST(buildRequest(startBody))
    expect(emitMock).not.toHaveBeenCalled()
    expect(invalidateMock).toHaveBeenCalledTimes(1)
  })

  it('flags authenticated visitors as internal', async () => {
    authMock.mockResolvedValue({ sub: 'user-1', tenantId: OFFER.tenantId } as never)
    recordFirstViewMock.mockResolvedValue({ firstView: false })
    const res = await POST(buildRequest(startBody))
    expect(await res.json()).toMatchObject({ counted: true, internal: true })
    expect(insertViewMock).toHaveBeenCalledWith(fakeEm, expect.objectContaining({ isInternal: true }))
    expect(emitMock).not.toHaveBeenCalled()
    expect(invalidateMock).not.toHaveBeenCalled()
  })

  it('reports counted false when the insert is capped', async () => {
    insertViewMock.mockResolvedValue(false)
    const res = await POST(buildRequest(startBody))
    expect(await res.json()).toEqual({ ok: true, counted: false })
    expect(recordFirstViewMock).not.toHaveBeenCalled()
    expect(invalidateMock).not.toHaveBeenCalled()
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('applies a beat with sections and answers 204', async () => {
    const sections = [{ k: '01-intro', l: 'Intro', ms: 4000 }]
    const res = await POST(buildRequest({ t: 'beat', seg: SEGMENT, key: VIEW_KEY, ms: 15000, sc: 42, sx: sections }))
    expect(res.status).toBe(204)
    expect(touchViewMock).toHaveBeenCalledWith(fakeEm, {
      viewKey: VIEW_KEY,
      offerId: OFFER.id,
      activeMs: 15000,
      scrollPct: 42,
      sections,
    })
    expect(insertViewMock).not.toHaveBeenCalled()
  })
})

describe('offer CRUD cache resource', () => {
  it('matches the resource the offers CRUD route caches under', () => {
    const actual = jest.requireActual<typeof import('@open-mercato/shared/lib/crud/cache')>(
      '@open-mercato/shared/lib/crud/cache',
    )
    expect(actual.deriveResourceFromCommandId('offer_generator.offers.create')).toBe('offer_generator.offer')
  })
})

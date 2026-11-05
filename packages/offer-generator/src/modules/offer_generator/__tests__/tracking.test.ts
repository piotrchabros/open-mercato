import {
  buildVisitorCookie,
  hashClientIp,
  isBotUserAgent,
  isSameOrigin,
  parseTrackingBody,
  parseUserAgent,
  readVisitorCookie,
} from '../lib/tracking'
import { TRACKING } from '../lib/constants'

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const VISITOR_ID = '3f2b8c1e-9d4a-4e6b-8a7c-1b2c3d4e5f60'

describe('isBotUserAgent', () => {
  it('flags empty and bot user agents', () => {
    expect(isBotUserAgent(null)).toBe(true)
    expect(isBotUserAgent('  ')).toBe(true)
    expect(isBotUserAgent('Googlebot/2.1')).toBe(true)
    expect(isBotUserAgent('curl/8.0')).toBe(true)
  })

  it('accepts browsers', () => {
    expect(isBotUserAgent(CHROME_UA)).toBe(false)
    expect(isBotUserAgent(IPHONE_UA)).toBe(false)
  })
})

describe('parseUserAgent', () => {
  it('detects desktop Chrome on Windows', () => {
    expect(parseUserAgent(CHROME_UA)).toEqual({ device: 'desktop', browser: 'Chrome', os: 'Windows' })
  })

  it('detects mobile Safari on iOS', () => {
    expect(parseUserAgent(IPHONE_UA)).toEqual({ device: 'mobile', browser: 'Safari', os: 'iOS' })
  })

  it('uses neutral labels for unknown agents', () => {
    expect(parseUserAgent('something')).toEqual({ device: 'desktop', browser: 'other', os: 'other' })
  })
})

describe('hashClientIp', () => {
  const originalSecret = process.env.OM_OFFER_GENERATOR_IP_HASH_SECRET
  const originalJwt = process.env.JWT_SECRET

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.OM_OFFER_GENERATOR_IP_HASH_SECRET
    else process.env.OM_OFFER_GENERATOR_IP_HASH_SECRET = originalSecret
    if (originalJwt === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = originalJwt
  })

  it('is deterministic, truncated and keyed', () => {
    process.env.OM_OFFER_GENERATOR_IP_HASH_SECRET = 'secret-a'
    const first = hashClientIp('203.0.113.7')
    expect(hashClientIp('203.0.113.7')).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(first).not.toContain('203')
    process.env.OM_OFFER_GENERATOR_IP_HASH_SECRET = 'secret-b'
    expect(hashClientIp('203.0.113.7')).not.toBe(first)
  })

  it('falls back to JWT_SECRET', () => {
    delete process.env.OM_OFFER_GENERATOR_IP_HASH_SECRET
    process.env.JWT_SECRET = 'jwt-secret'
    expect(hashClientIp('203.0.113.7')).toMatch(/^[0-9a-f]{32}$/)
  })

  it('throws when no secret is configured', () => {
    delete process.env.OM_OFFER_GENERATOR_IP_HASH_SECRET
    delete process.env.JWT_SECRET
    expect(() => hashClientIp('203.0.113.7')).toThrow()
  })
})

describe('isSameOrigin', () => {
  it('matches the host header', () => {
    expect(isSameOrigin(new Headers({ origin: 'https://crm.example.com', host: 'crm.example.com' }))).toBe(true)
  })

  it('matches x-forwarded-host', () => {
    expect(
      isSameOrigin(new Headers({ origin: 'https://crm.example.com', host: 'internal:3000', 'x-forwarded-host': 'crm.example.com' })),
    ).toBe(true)
  })

  it('rejects foreign, missing and malformed origins', () => {
    expect(isSameOrigin(new Headers({ origin: 'https://evil.example', host: 'crm.example.com' }))).toBe(false)
    expect(isSameOrigin(new Headers({ host: 'crm.example.com' }))).toBe(false)
    expect(isSameOrigin(new Headers({ origin: 'not a url', host: 'crm.example.com' }))).toBe(false)
  })
})

describe('visitor cookie', () => {
  it('round-trips a visitor id', () => {
    const cookie = buildVisitorCookie(VISITOR_ID, true)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    const headers = new Headers({ cookie: `a=1; ${cookie.split(';')[0]}; b=2` })
    expect(readVisitorCookie(headers)).toBe(VISITOR_ID)
  })

  it('omits Secure when not requested', () => {
    expect(buildVisitorCookie(VISITOR_ID, false)).not.toContain('Secure')
  })

  it('rejects missing and invalid values', () => {
    expect(readVisitorCookie(new Headers())).toBeNull()
    expect(readVisitorCookie(new Headers({ cookie: `${TRACKING.VISITOR_COOKIE}=nope` }))).toBeNull()
  })
})

describe('parseTrackingBody', () => {
  it('parses a start body', () => {
    const body = { t: 'start', seg: 'acme-abc123', key: VISITOR_ID }
    expect(parseTrackingBody(JSON.stringify(body))).toEqual(body)
  })

  it('parses a beat body with sections', () => {
    const body = {
      t: 'beat',
      seg: 'acme-abc123',
      key: VISITOR_ID,
      ms: 15000,
      sc: 40,
      sx: [{ k: '0-intro', l: 'Intro', ms: 4000 }],
    }
    expect(parseTrackingBody(JSON.stringify(body))).toEqual(body)
  })

  it('rejects invalid JSON, unknown types and out-of-range values', () => {
    expect(parseTrackingBody('{')).toBeNull()
    expect(parseTrackingBody(JSON.stringify({ t: 'other', seg: 'seg', key: VISITOR_ID }))).toBeNull()
    expect(parseTrackingBody(JSON.stringify({ t: 'beat', seg: 'seg', key: VISITOR_ID, ms: -1, sc: 10 }))).toBeNull()
    expect(parseTrackingBody(JSON.stringify({ t: 'beat', seg: 'seg', key: VISITOR_ID, ms: 1, sc: 101 }))).toBeNull()
    expect(
      parseTrackingBody(JSON.stringify({ t: 'beat', seg: 'seg', key: VISITOR_ID, ms: TRACKING.MAX_ACTIVE_MS + 1, sc: 1 })),
    ).toBeNull()
  })

  it('rejects non-uuid keys', () => {
    expect(parseTrackingBody(JSON.stringify({ t: 'start', seg: 'seg', key: 'k1' }))).toBeNull()
  })

  it('rejects oversized bodies', () => {
    const padded = JSON.stringify({ t: 'start', seg: 'seg', key: VISITOR_ID, ref: 'x'.repeat(TRACKING.MAX_BODY_BYTES) })
    expect(parseTrackingBody(padded)).toBeNull()
  })

  it('rejects more than 60 sections', () => {
    const sx = Array.from({ length: 61 }, (_, i) => ({ k: `k${i}`, l: 'x', ms: 1 }))
    expect(parseTrackingBody(JSON.stringify({ t: 'beat', seg: 'seg', key: VISITOR_ID, ms: 1, sc: 1, sx }))).toBeNull()
  })
})

import { createHmac } from 'node:crypto'
import {
  buildSignedRequest,
  computeHubSignature,
  parseSignedRequest,
  timingSafeEqualStrings,
  verifyHubSignature,
} from '../lib/signature'

const APP_SECRET = 'test-app-secret'
const BODY = '{"object":"page","entry":[{"id":"1","time":1,"changes":[]}]}'

describe('hub signature', () => {
  it('computes sha256= prefixed hex HMAC', () => {
    const expected = `sha256=${createHmac('sha256', APP_SECRET).update(BODY).digest('hex')}`
    expect(computeHubSignature(BODY, APP_SECRET)).toBe(expected)
    expect(computeHubSignature(Buffer.from(BODY), APP_SECRET)).toBe(expected)
  })

  it('verifies a valid header', () => {
    expect(verifyHubSignature(BODY, computeHubSignature(BODY, APP_SECRET), APP_SECRET)).toBe(true)
  })

  it('rejects a tampered body, wrong secret, missing header and wrong prefix', () => {
    const header = computeHubSignature(BODY, APP_SECRET)
    expect(verifyHubSignature(`${BODY} `, header, APP_SECRET)).toBe(false)
    expect(verifyHubSignature(BODY, header, 'other-secret')).toBe(false)
    expect(verifyHubSignature(BODY, null, APP_SECRET)).toBe(false)
    expect(verifyHubSignature(BODY, undefined, APP_SECRET)).toBe(false)
    expect(verifyHubSignature(BODY, '', APP_SECRET)).toBe(false)
    expect(verifyHubSignature(BODY, header.replace('sha256=', 'sha1='), APP_SECRET)).toBe(false)
  })

  it('rejects a header of different length without throwing', () => {
    expect(verifyHubSignature(BODY, 'sha256=abc', APP_SECRET)).toBe(false)
  })

  it('rejects when no app secret is available', () => {
    expect(verifyHubSignature(BODY, computeHubSignature(BODY, ''), '')).toBe(false)
  })
})

describe('timingSafeEqualStrings', () => {
  it('compares equal and different strings', () => {
    expect(timingSafeEqualStrings('abc', 'abc')).toBe(true)
    expect(timingSafeEqualStrings('abc', 'abd')).toBe(false)
    expect(timingSafeEqualStrings('abc', 'abcd')).toBe(false)
  })
})

describe('signed_request', () => {
  const payload = { algorithm: 'HMAC-SHA256', issued_at: 1762250500, user_id: '100044556677889' }

  it('round-trips a valid signed request', () => {
    expect(parseSignedRequest(buildSignedRequest(payload, APP_SECRET), APP_SECRET)).toEqual(payload)
  })

  it('accepts a lowercase algorithm', () => {
    const lowercase = { ...payload, algorithm: 'hmac-sha256' }
    expect(parseSignedRequest(buildSignedRequest(lowercase, APP_SECRET), APP_SECRET)).toEqual(lowercase)
  })

  it('rejects a wrong secret', () => {
    expect(parseSignedRequest(buildSignedRequest(payload, APP_SECRET), 'other-secret')).toBeNull()
  })

  it('rejects a tampered payload', () => {
    const [signature] = buildSignedRequest(payload, APP_SECRET).split('.')
    const forged = Buffer.from(JSON.stringify({ ...payload, user_id: '999' })).toString('base64url')
    expect(parseSignedRequest(`${signature}.${forged}`, APP_SECRET)).toBeNull()
  })

  it('rejects malformed inputs', () => {
    expect(parseSignedRequest('', APP_SECRET)).toBeNull()
    expect(parseSignedRequest('nodot', APP_SECRET)).toBeNull()
    expect(parseSignedRequest('.payload', APP_SECRET)).toBeNull()
    expect(parseSignedRequest('signature.', APP_SECRET)).toBeNull()
    expect(parseSignedRequest('@@@.@@@', APP_SECRET)).toBeNull()
    expect(parseSignedRequest(buildSignedRequest(payload, APP_SECRET), '')).toBeNull()
  })

  it('rejects a non-JSON payload even when correctly signed', () => {
    const segment = Buffer.from('not json').toString('base64url')
    const signature = createHmac('sha256', APP_SECRET).update(segment).digest().toString('base64url')
    expect(parseSignedRequest(`${signature}.${segment}`, APP_SECRET)).toBeNull()
  })

  it('rejects an unsupported algorithm', () => {
    expect(parseSignedRequest(buildSignedRequest({ ...payload, algorithm: 'HMAC-SHA1' }, APP_SECRET), APP_SECRET)).toBeNull()
  })

  it('rejects a missing or non-numeric user_id', () => {
    expect(parseSignedRequest(buildSignedRequest({ algorithm: 'HMAC-SHA256' }, APP_SECRET), APP_SECRET)).toBeNull()
    expect(parseSignedRequest(buildSignedRequest({ ...payload, user_id: 'abc' }, APP_SECRET), APP_SECRET)).toBeNull()
    expect(parseSignedRequest(buildSignedRequest({ ...payload, user_id: '' }, APP_SECRET), APP_SECRET)).toBeNull()
  })
})

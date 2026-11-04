import { createHmac } from 'node:crypto'
import type { InboundWebhookRequest } from '@open-mercato/shared/lib/webhooks'
import { CALCOM_SIGNATURE_HEADER, computeCalcomSignature, verifyCalcomSignature } from '../lib/signature'

const SECRET = 'calcom-test-secret'
const BODY = JSON.stringify({ triggerEvent: 'BOOKING_CREATED', createdAt: '2026-11-04T09:00:00.000Z', payload: { uid: 'bk-uid-1' } })

function makeRequest(headers: Record<string, string>, body = BODY): InboundWebhookRequest {
  return { body, headers, parsedBody: JSON.parse(body) as Record<string, unknown> }
}

describe('computeCalcomSignature', () => {
  it('returns lowercase hex HMAC-SHA256 of the raw body', () => {
    const expected = createHmac('sha256', SECRET).update(BODY).digest('hex')
    const signature = computeCalcomSignature(BODY, SECRET)
    expect(signature).toBe(expected)
    expect(signature).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('verifyCalcomSignature', () => {
  const valid = computeCalcomSignature(BODY, SECRET)

  it('accepts a valid signature', async () => {
    await expect(verifyCalcomSignature(makeRequest({ [CALCOM_SIGNATURE_HEADER]: valid }), { webhookSecret: SECRET })).resolves.toBe(true)
  })

  it('accepts an uppercase hex signature and a non-lowercased header key', async () => {
    await expect(
      verifyCalcomSignature(makeRequest({ 'X-Cal-Signature-256': valid.toUpperCase() }), { webhookSecret: SECRET }),
    ).resolves.toBe(true)
  })

  it('rejects a signature computed with another secret', async () => {
    const wrong = computeCalcomSignature(BODY, 'other-secret')
    await expect(verifyCalcomSignature(makeRequest({ [CALCOM_SIGNATURE_HEADER]: wrong }), { webhookSecret: SECRET })).resolves.toBe(false)
  })

  it('rejects when the body was tampered with', async () => {
    await expect(
      verifyCalcomSignature(makeRequest({ [CALCOM_SIGNATURE_HEADER]: valid }, BODY.replace('bk-uid-1', 'bk-uid-2')), { webhookSecret: SECRET }),
    ).resolves.toBe(false)
  })

  it('rejects when the signature header is missing', async () => {
    await expect(verifyCalcomSignature(makeRequest({}), { webhookSecret: SECRET })).resolves.toBe(false)
  })

  it('rejects the no-secret-provided placeholder', async () => {
    await expect(
      verifyCalcomSignature(makeRequest({ [CALCOM_SIGNATURE_HEADER]: 'no-secret-provided' }), { webhookSecret: SECRET }),
    ).resolves.toBe(false)
  })

  it('rejects when no secret is configured', async () => {
    await expect(verifyCalcomSignature(makeRequest({ [CALCOM_SIGNATURE_HEADER]: valid }), {})).resolves.toBe(false)
    await expect(verifyCalcomSignature(makeRequest({ [CALCOM_SIGNATURE_HEADER]: valid }), { webhookSecret: '  ' })).resolves.toBe(false)
  })

  it('rejects a signature of the wrong length', async () => {
    await expect(
      verifyCalcomSignature(makeRequest({ [CALCOM_SIGNATURE_HEADER]: valid.slice(0, 32) }), { webhookSecret: SECRET }),
    ).resolves.toBe(false)
  })
})

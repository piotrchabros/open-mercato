import { createHmac, timingSafeEqual } from 'node:crypto'

const SIGNATURE_PREFIX = 'sha256='
const SIGNED_REQUEST_ALGORITHM = 'HMAC-SHA256'

export type SignedRequestPayload = { algorithm: string; issued_at?: number; user_id: string } & Record<string, unknown>

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function computeHubSignature(rawBody: Uint8Array | string, appSecret: string): string {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`
}

export function verifyHubSignature(
  rawBody: Uint8Array | string,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  if (!header || !appSecret || !header.startsWith(SIGNATURE_PREFIX)) return false
  return timingSafeEqualStrings(computeHubSignature(rawBody, appSecret), header)
}

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

function decodeBase64Url(segment: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(segment)) return null
  return Buffer.from(segment, 'base64url')
}

function signSegment(payloadSegment: string, appSecret: string): Buffer {
  return createHmac('sha256', appSecret).update(payloadSegment).digest()
}

export function parseSignedRequest(signedRequest: string, appSecret: string): SignedRequestPayload | null {
  if (!signedRequest || !appSecret) return null
  const separatorIndex = signedRequest.indexOf('.')
  if (separatorIndex <= 0 || separatorIndex === signedRequest.length - 1) return null
  const signatureSegment = signedRequest.slice(0, separatorIndex)
  const payloadSegment = signedRequest.slice(separatorIndex + 1)

  const signature = decodeBase64Url(signatureSegment)
  const payloadBytes = decodeBase64Url(payloadSegment)
  if (!signature || !payloadBytes) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const payload = parsed as Record<string, unknown>
  if (typeof payload.algorithm !== 'string' || payload.algorithm.toUpperCase() !== SIGNED_REQUEST_ALGORITHM) return null
  if (typeof payload.user_id !== 'string' || !/^\d+$/.test(payload.user_id)) return null

  const expected = signSegment(payloadSegment, appSecret)
  if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) return null
  return payload as SignedRequestPayload
}

export function buildSignedRequest(payload: object, appSecret: string): string {
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signatureSegment = signSegment(payloadSegment, appSecret).toString('base64url')
  return `${signatureSegment}.${payloadSegment}`
}

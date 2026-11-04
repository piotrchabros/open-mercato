import { createHmac, timingSafeEqual } from 'node:crypto'
import type { InboundWebhookRequest } from '@open-mercato/shared/lib/webhooks'

export const CALCOM_SIGNATURE_HEADER = 'x-cal-signature-256'
const NO_SECRET_SIGNATURE = 'no-secret-provided'

export function computeCalcomSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
}

function readSignatureHeader(headers: Record<string, string>): string | undefined {
  const direct = headers[CALCOM_SIGNATURE_HEADER]
  if (typeof direct === 'string') return direct
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === CALCOM_SIGNATURE_HEADER) return headers[key]
  }
  return undefined
}

export async function verifyCalcomSignature(
  request: InboundWebhookRequest,
  credentials: Record<string, string>,
): Promise<boolean> {
  const secret = credentials.webhookSecret?.trim()
  if (!secret) return false
  const provided = readSignatureHeader(request.headers)?.trim().toLowerCase()
  if (!provided || provided === NO_SECRET_SIGNATURE) return false
  const expected = computeCalcomSignature(request.body, secret)
  const providedBuffer = Buffer.from(provided, 'utf8')
  const expectedBuffer = Buffer.from(expected, 'utf8')
  if (providedBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(providedBuffer, expectedBuffer)
}

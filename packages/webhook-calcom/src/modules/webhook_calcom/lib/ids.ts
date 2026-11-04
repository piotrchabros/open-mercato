import { createHash } from 'node:crypto'

export const CALCOM_INTERACTION_NAMESPACE = '5c1f0a7e-3b6d-4e0a-9d52-7a4c8e1b2f90'

export function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const digest = createHash('sha1')
    .update(namespaceBytes)
    .update(Buffer.from(name, 'utf8'))
    .digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function calcomInteractionId(tenantId: string, organizationId: string, bookingUid: string): string {
  return uuidV5(CALCOM_INTERACTION_NAMESPACE, `${tenantId}:${organizationId}:${bookingUid}`)
}

import { createHash, randomBytes } from 'node:crypto'
import { INTERACTION_ID_NAMESPACE } from './constants'

export function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const digest = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function computeInteractionId(metaLeadId: string): string {
  return uuidV5(metaLeadId, INTERACTION_ID_NAMESPACE)
}

export function generateConfirmationCode(): string {
  return `dr_${randomBytes(6).toString('hex')}`
}

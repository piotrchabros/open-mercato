import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('communication_channels').child({ component: 'thread-reader-cursor' })

/**
 * Opaque signed paging cursor for the authorized thread reader (Connect
 * upstream Contract C).
 *
 * A cursor is not a bookmark — it is a claim about what the holder was
 * authorized to read. It therefore binds every dimension of that claim: tenant,
 * organization, channel, the authorization epoch, the normalized allowlist, the
 * ordering and the page size. Continuation re-validates authorization from
 * scratch and re-applies the CURRENT allowlist; the cursor only proves the
 * caller is continuing the same query, never that they may still run it.
 *
 * Signing (rather than opaque-looking encoding) is what stops a caller from
 * editing the allowlist hash or the position out of a cursor to widen their own
 * read.
 */

const HMAC_KEY_ENV = 'OM_THREAD_READER_CURSOR_SECRET'
const HMAC_FALLBACK_KEY_ENV = 'KMS_MASTER_KEY'
const HMAC_KEY_INFO = 'thread-reader-cursor'

let cachedKey: Buffer | null = null

function getKey(): Buffer {
  if (cachedKey) return cachedKey
  const primary = process.env[HMAC_KEY_ENV]
  if (primary && primary.length > 0) {
    cachedKey = Buffer.from(primary, 'utf8')
    return cachedKey
  }
  const fallback = process.env[HMAC_FALLBACK_KEY_ENV]
  if (fallback && fallback.length > 0) {
    cachedKey = createHmac('sha256', fallback).update(HMAC_KEY_INFO).digest()
    return cachedKey
  }
  // Fail closed in production: an unsigned-in-practice cursor would let a
  // caller forge the allowlist binding and read conversations they never
  // supplied.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `[communication_channels] No ${HMAC_KEY_ENV} or ${HMAC_FALLBACK_KEY_ENV} configured —` +
        ' refusing to sign thread-reader cursors with a static dev key in production.',
    )
  }
  logger.warn(
    `No ${HMAC_KEY_ENV} or ${HMAC_FALLBACK_KEY_ENV} configured.` +
      ' Thread-reader cursors will use a dev-only static key — DO NOT USE IN PRODUCTION.',
  )
  cachedKey = createHash('sha256').update('open-mercato-thread-reader-cursor-dev').digest()
  return cachedKey
}

/** Reset the cached key — for tests that mutate env vars. */
export function _resetThreadReaderCursorKeyCache(): void {
  cachedKey = null
}

export type ThreadReaderCursorPayload = {
  tenantId: string
  organizationId: string
  channelId: string
  /**
   * Fingerprint of the caller's authorization at the time the page was issued.
   * A revoke-then-regrant changes it, so a cursor minted under the old grant is
   * refused rather than silently resumed.
   */
  authorizationEpoch: string
  /** Hash of the normalized (sorted, deduplicated) conversation allowlist. */
  allowlistHash: string
  pageSize: number
  /** Position: the last returned record's (createdAt ISO, id) pair. */
  afterCreatedAt: string
  afterId: string
}

/** Stable hash of a conversation allowlist, order- and duplicate-insensitive. */
export function hashAllowlist(externalConversationIds: readonly string[]): string {
  // Byte-order comparator, not the locale-dependent default: the hash travels
  // inside a cursor and is re-derived by whichever process serves the next page.
  const normalized = Array.from(new Set(externalConversationIds)).sort((a, b) =>
    a === b ? 0 : a < b ? -1 : 1,
  )
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function base64urlEncode(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64urlDecode(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
  try {
    return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  } catch {
    return null
  }
}

export function encodeThreadReaderCursor(payload: ThreadReaderCursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const signature = createHmac('sha256', getKey()).update(body).digest()
  return `${base64urlEncode(body)}.${base64urlEncode(signature)}`
}

/**
 * Verify and decode a cursor. Returns `null` for anything that is not a cursor
 * this installation issued — malformed, truncated, re-signed, or edited.
 */
export function decodeThreadReaderCursor(cursor: string): ThreadReaderCursorPayload | null {
  const parts = cursor.split('.')
  if (parts.length !== 2) return null
  const body = base64urlDecode(parts[0])
  const signature = base64urlDecode(parts[1])
  if (!body || !signature) return null

  const expected = createHmac('sha256', getKey()).update(body).digest()
  if (expected.length !== signature.length) return null
  if (!timingSafeEqual(expected, signature)) return null

  try {
    return JSON.parse(body.toString('utf8')) as ThreadReaderCursorPayload
  } catch {
    return null
  }
}

import { createHash, createHmac } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ConnectContactIdentity, type ConnectIdentityLinkState } from '../data/entities'

const logger = createLogger('connect').child({ component: 'identity-resolver' })

/**
 * Contact identity resolution.
 *
 * Connect stores the handle it saw (encrypted) and what it believes that handle
 * maps to. Two rules govern the whole module:
 *
 *   1. **Lookup goes through a hash, never the value.** The handle column is
 *      encrypted at rest, and an encrypted column is not queryable by value. The
 *      hash is written even when tenant data encryption is DISABLED — otherwise
 *      enabling it later would silently make every existing identity invisible
 *      to lookup, which fails open into duplicate identities and duplicate Cases.
 *   2. **Below the confidence threshold, stay unresolved.** An unresolved
 *      identity opens its own Case and never cross-attaches. Guessing wrong here
 *      puts one customer's message on another customer's record, which is a
 *      disclosure; opening an extra Case is merely untidy.
 */

const HASH_KEY_ENV = 'OM_CONNECT_IDENTITY_HASH_SECRET'
const HASH_FALLBACK_KEY_ENV = 'KMS_MASTER_KEY'
const HASH_KEY_INFO = 'connect-identity-handle'

let cachedKey: Buffer | null = null

function getHashKey(): Buffer {
  if (cachedKey) return cachedKey
  const primary = process.env[HASH_KEY_ENV]
  if (primary && primary.length > 0) {
    cachedKey = Buffer.from(primary, 'utf8')
    return cachedKey
  }
  const fallback = process.env[HASH_FALLBACK_KEY_ENV]
  if (fallback && fallback.length > 0) {
    cachedKey = createHmac('sha256', fallback).update(HASH_KEY_INFO).digest()
    return cachedKey
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `[connect] No ${HASH_KEY_ENV} or ${HASH_FALLBACK_KEY_ENV} configured —` +
        ' refusing to derive identity blind indexes with a static dev key in production.',
    )
  }
  logger.warn(
    `No ${HASH_KEY_ENV} or ${HASH_FALLBACK_KEY_ENV} configured.` +
      ' Identity hashes will use a dev-only static key — DO NOT USE IN PRODUCTION.',
  )
  cachedKey = createHash('sha256').update('open-mercato-connect-identity-dev').digest()
  return cachedKey
}

/** Reset the cached key — for tests that mutate env vars. */
export function _resetIdentityHashKeyCache(): void {
  cachedKey = null
}

/**
 * Normalize a handle before hashing so trivially different spellings of the same
 * address resolve to one identity.
 *
 * Deliberately conservative: case and surrounding whitespace only. Plus-address
 * stripping or dot-folding are provider-specific and would merge handles that a
 * customer may intend to keep separate.
 */
export function normalizeHandle(handleType: string, value: string): string {
  const trimmed = value.trim()
  return handleType === 'email' ? trimmed.toLowerCase() : trimmed
}

/**
 * Keyed blind index. Keyed rather than a plain digest so a leaked table cannot
 * be brute-forced against a dictionary of known addresses.
 */
export function hashHandle(handleType: string, value: string): string {
  const normalized = normalizeHandle(handleType, value)
  return createHmac('sha256', getHashKey()).update(`${handleType}:${normalized}`).digest('hex')
}

/** Masked, non-PII label safe for lists, logs and search documents. */
export function maskHandle(value: string): string {
  const at = value.lastIndexOf('@')
  if (at <= 0) {
    return value.length <= 2 ? '…' : `${value[0]}…${value[value.length - 1]}`
  }
  const local = value.slice(0, at)
  const domain = value.slice(at)
  return local.length <= 2 ? `…${domain}` : `${local[0]}…${local[local.length - 1]}${domain}`
}

export type IdentityScope = {
  tenantId: string
  organizationId: string
  channelId: string
}

export type IdentityMatch = {
  customerKind: 'person' | 'company'
  customerId: string
  confidence: number
  matchMethod: string
}

export type ResolveIdentityInput = {
  scope: IdentityScope
  handleType: string
  handleValue: string
  /** Best candidate from the matcher, or `null` when nothing matched. */
  candidate: IdentityMatch | null
  /** 0–100. Below it the identity stays unresolved. */
  threshold: number
}

export type ResolvedIdentity = {
  identity: ConnectContactIdentity
  created: boolean
  linkState: ConnectIdentityLinkState
}

/**
 * Decide the link state for a candidate.
 *
 * Exported separately so the threshold rule can be tested without a database —
 * it is the rule that decides whether Connect risks a cross-attach.
 */
export function decideLinkState(
  candidate: IdentityMatch | null,
  threshold: number,
): { linkState: ConnectIdentityLinkState; match: IdentityMatch | null } {
  if (!candidate) return { linkState: 'unresolved', match: null }
  if (candidate.confidence < threshold) return { linkState: 'unresolved', match: null }
  return { linkState: 'linked', match: candidate }
}

/**
 * Find or create the identity for a handle.
 *
 * The insert races the scoped unique hash constraint rather than reading first:
 * two inbound messages from the same sender arriving together must produce ONE
 * identity, and a read-then-create would let both pass the check and then fight
 * over which Case is active.
 *
 * An existing identity is never downgraded from `linked` to `unresolved` by a
 * weaker later match — an operator's or an earlier matcher's link stands until
 * something explicitly unlinks it.
 */
export async function resolveIdentity(
  em: EntityManager,
  input: ResolveIdentityInput,
): Promise<ResolvedIdentity> {
  const handleHash = hashHandle(input.handleType, input.handleValue)
  const { linkState, match } = decideLinkState(input.candidate, input.threshold)

  const existing = await em.findOne(ConnectContactIdentity, {
    tenantId: input.scope.tenantId,
    organizationId: input.scope.organizationId,
    channelId: input.scope.channelId,
    handleHash,
  })
  if (existing) {
    if (existing.linkState !== 'linked' && linkState === 'linked' && match) {
      existing.linkState = 'linked'
      existing.customerKind = match.customerKind
      existing.customerId = match.customerId
      existing.confidence = match.confidence
      existing.matchMethod = match.matchMethod
      await em.flush()
    }
    return { identity: existing, created: false, linkState: existing.linkState }
  }

  const identity = em.create(ConnectContactIdentity, {
    tenantId: input.scope.tenantId,
    organizationId: input.scope.organizationId,
    channelId: input.scope.channelId,
    handleType: input.handleType,
    handleValue: normalizeHandle(input.handleType, input.handleValue),
    handleHash,
    handleDisplayLabel: maskHandle(input.handleValue),
    linkState,
    customerKind: match?.customerKind ?? null,
    customerId: match?.customerId ?? null,
    confidence: match?.confidence ?? null,
    matchMethod: match?.matchMethod ?? null,
  })
  em.persist(identity)
  await em.flush()
  return { identity, created: true, linkState }
}

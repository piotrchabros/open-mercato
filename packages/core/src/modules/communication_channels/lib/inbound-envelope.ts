import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  CommunicationChannel,
  ExternalConversation,
  ExternalMessage,
  MessageChannelLink,
  type ChannelProjectionMode,
} from '../data/entities'

const logger = createLogger('communication_channels').child({ component: 'inbound-envelope' })

/**
 * Authorized inbound envelope reader (Connect upstream Contract D).
 *
 * `communication_channels.message.received` is identifier-only by design — a
 * persistent event store must not hold raw PII. But Connect's ingest cannot
 * classify a loop, hash an identity, or set a Case subject from identifiers
 * alone, and it must not query peer tables to get them. This facade is the
 * bounded, server-only way across that gap.
 *
 * The threat model is explicit and NOT pretended away: Open Mercato modules
 * share one trusted server process, and DI is not a sandbox against malicious
 * installed code. This is a class (e) contract that deliberately enlarges the
 * trusted computing base, and a caller-supplied module id would be theatre, not
 * authorization. What it does instead is make accidental misuse by a trusted
 * module structurally hard:
 *
 *   - the caller must present the COMPLETE tuple from one event; a mixed or
 *     partial tuple returns `missing` without saying which component failed;
 *   - the classification comes from the ingest-time snapshot, so a later
 *     reprovision cannot retroactively hand old messages to a new owner;
 *   - the projection is length- and enum-bounded and excludes raw headers,
 *     HTML, body, attachments and credentials;
 *   - the reply address never crosses the boundary at all — only an opaque
 *     reference and a masked label.
 */

/** The exact tuple carried by one `communication_channels.message.received`. */
export type InboundEnvelopeTuple = {
  tenantId: string
  organizationId: string
  channelId: string
  /** `external_conversations.id` */
  conversationId: string
  /** `messages.message.id` */
  messageId: string
  /** `external_messages.id` */
  externalMessageId: string
  /** `message_channel_links.id` */
  channelLinkId: string
}

export type InboundSenderType = 'email' | 'phone' | 'handle' | 'unknown'

export type InboundEnvelope = {
  /** Normalized sender handle. Connect must encrypt or hash this immediately. */
  senderHandle: string
  senderType: InboundSenderType
  /** Bounded subject, safe for a Case title. */
  subject: string
  /** True when the message looks machine-generated (vacation responder, etc.). */
  isAutoResponder: boolean
  /** True when the message is a delivery-status notification. */
  isBounce: boolean
  /** Why the flags above were set, or `null`. */
  classificationReason: string | null
  /** Opaque, immutable handle for `resolveInboundReplyTarget`. */
  replyTargetRef: string
  /** Human-readable, deliberately masked. Safe to render. */
  replyTargetMaskedLabel: string
  occurredAt: string
}

export type InboundEnvelopeResult =
  | { status: 'found'; envelope: InboundEnvelope; projectionMode: ChannelProjectionMode; trafficEnabled: boolean }
  | { status: 'missing' }
  | { status: 'not_connect_managed'; projectionModeAtEvent: ChannelProjectionMode }
  | { status: 'channel_disabled'; projectionModeAtEvent: ChannelProjectionMode }
  | { status: 'transient_error' }
  | { status: 'permanent_invalid'; reason: string }

export const INBOUND_SUBJECT_MAX_CHARS = 500
export const INBOUND_SENDER_HANDLE_MAX_CHARS = 320

// ── Opaque reply-target references ───────────────────────────

const REF_KEY_ENV = 'OM_INBOUND_REPLY_REF_SECRET'
const REF_FALLBACK_KEY_ENV = 'KMS_MASTER_KEY'
const REF_KEY_INFO = 'inbound-reply-target-ref'
/**
 * Bumped when the reply-resolution POLICY changes. A reference minted under an
 * older policy is refused rather than resolved under the new one, so a stored
 * reference can never quietly change which address it means.
 */
export const INBOUND_REPLY_REF_SOURCE_VERSION = 1

let cachedKey: Buffer | null = null

function getKey(): Buffer {
  if (cachedKey) return cachedKey
  const primary = process.env[REF_KEY_ENV]
  if (primary && primary.length > 0) {
    cachedKey = Buffer.from(primary, 'utf8')
    return cachedKey
  }
  const fallback = process.env[REF_FALLBACK_KEY_ENV]
  if (fallback && fallback.length > 0) {
    cachedKey = createHmac('sha256', fallback).update(REF_KEY_INFO).digest()
    return cachedKey
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `[communication_channels] No ${REF_KEY_ENV} or ${REF_FALLBACK_KEY_ENV} configured —` +
        ' refusing to sign inbound reply-target references with a static dev key in production.',
    )
  }
  logger.warn(
    `No ${REF_KEY_ENV} or ${REF_FALLBACK_KEY_ENV} configured.` +
      ' Inbound reply-target references will use a dev-only static key — DO NOT USE IN PRODUCTION.',
  )
  cachedKey = createHash('sha256').update('open-mercato-inbound-reply-ref-dev').digest()
  return cachedKey
}

/** Reset the cached key — for tests that mutate env vars. */
export function _resetInboundReplyRefKeyCache(): void {
  cachedKey = null
}

/**
 * A reply-target reference is a signed binding, not an identifier: it carries
 * no address, and it is only meaningful for the exact scope and message it was
 * minted for.
 */
function buildReplyTargetRef(tuple: InboundEnvelopeTuple): string {
  const body = [
    INBOUND_REPLY_REF_SOURCE_VERSION,
    tuple.tenantId,
    tuple.organizationId,
    tuple.channelId,
    tuple.conversationId,
    tuple.channelLinkId,
  ].join(':')
  const signature = createHmac('sha256', getKey()).update(body).digest('hex').slice(0, 32)
  return `v${INBOUND_REPLY_REF_SOURCE_VERSION}.${tuple.channelLinkId}.${signature}`
}

function verifyReplyTargetRef(
  ref: string,
  tuple: Omit<InboundEnvelopeTuple, 'messageId' | 'externalMessageId'> & { channelLinkId: string },
): boolean {
  const expected = buildReplyTargetRef(tuple as InboundEnvelopeTuple)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(ref, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// ── Projection helpers ───────────────────────────────────────

function classifySenderType(handle: string): InboundSenderType {
  if (handle.includes('@')) return 'email'
  if (/^\+?[0-9][0-9\s()-]{4,}$/.test(handle)) return 'phone'
  if (handle.length > 0) return 'handle'
  return 'unknown'
}

function boundedString(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  return stripped.length > maxChars ? stripped.slice(0, maxChars) : stripped
}

/**
 * Mask an address for display: enough to recognize, not enough to reconstruct.
 * `alice@example.com` → `a…e@example.com`.
 */
export function maskRecipient(value: string): string {
  if (!value) return ''
  const atIndex = value.lastIndexOf('@')
  if (atIndex <= 0) {
    return value.length <= 2 ? '…' : `${value[0]}…${value[value.length - 1]}`
  }
  const local = value.slice(0, atIndex)
  const domain = value.slice(atIndex)
  if (local.length <= 2) return `…${domain}`
  return `${local[0]}…${local[local.length - 1]}${domain}`
}

const AUTO_RESPONDER_HEADERS = ['auto-submitted', 'x-autoreply', 'x-autorespond', 'x-auto-response-suppress']
const BULK_PRECEDENCES = new Set(['bulk', 'auto_reply', 'junk', 'list'])

function lowercaseHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value.toLowerCase()
  }
  return out
}

/**
 * Loop and bounce classification.
 *
 * Connect uses this to avoid auto-replying to an auto-reply, which is the
 * classic way a shared inbox generates an infinite mail loop with a customer's
 * vacation responder.
 */
export function classifyInboundLoop(
  headers: Record<string, string>,
  payload: Record<string, unknown>,
): { isAutoResponder: boolean; isBounce: boolean; reason: string | null } {
  for (const header of AUTO_RESPONDER_HEADERS) {
    const value = headers[header]
    if (value && value !== 'no') return { isAutoResponder: true, isBounce: false, reason: header }
  }
  const precedence = headers['precedence']
  if (precedence && BULK_PRECEDENCES.has(precedence)) {
    return { isAutoResponder: true, isBounce: false, reason: `precedence:${precedence}` }
  }
  // An empty Return-Path is the RFC 3464 marker of a bounce: it exists so a
  // delivery-status notification cannot itself bounce.
  const returnPath = headers['return-path']
  if (returnPath === '<>' || returnPath === '') {
    return { isAutoResponder: false, isBounce: true, reason: 'empty_return_path' }
  }
  const contentType = headers['content-type'] ?? ''
  if (contentType.includes('report-type=delivery-status')) {
    return { isAutoResponder: false, isBounce: true, reason: 'delivery_status_report' }
  }
  const subject = typeof payload.subject === 'string' ? payload.subject.toLowerCase() : ''
  if (/^(undeliverable|mail delivery (failed|subsystem)|returned mail|delivery status notification)/.test(subject)) {
    return { isAutoResponder: false, isBounce: true, reason: 'bounce_subject' }
  }
  if (/^(auto(matic)?[ -]?(reply|response)|out of (the )?office)/.test(subject)) {
    return { isAutoResponder: true, isBounce: false, reason: 'auto_reply_subject' }
  }
  return { isAutoResponder: false, isBounce: false, reason: null }
}

type ContainerLike = { resolve: <T = unknown>(name: string) => T }

/**
 * Read the bounded envelope for one inbound event.
 *
 * Every component of the tuple must match the same record. A mixed tuple —
 * a real message id with someone else's conversation id, say — returns
 * `missing` without identifying which component failed.
 */
export async function readInboundEnvelope(
  container: ContainerLike,
  tuple: InboundEnvelopeTuple,
): Promise<InboundEnvelopeResult> {
  let em: EntityManager
  try {
    em = (container.resolve('em') as EntityManager).fork()
  } catch (err) {
    logger.warn('inbound envelope reader could not open a session', { err })
    return { status: 'transient_error' }
  }

  try {
    const link = await em.findOne(MessageChannelLink, {
      id: tuple.channelLinkId,
      messageId: tuple.messageId,
      externalMessageId: tuple.externalMessageId,
      externalConversationId: tuple.conversationId,
      tenantId: tuple.tenantId,
      organizationId: tuple.organizationId,
      direction: 'inbound',
    })
    if (!link) return { status: 'missing' }

    // Historical ownership: validated from the ingest record's own scope, so a
    // channel deactivated or disconnected LATER does not invalidate an event
    // that was legitimate when it was emitted.
    const conversation = await em.findOne(ExternalConversation, {
      id: tuple.conversationId,
      channelId: tuple.channelId,
      tenantId: tuple.tenantId,
      organizationId: tuple.organizationId,
    })
    if (!conversation) return { status: 'missing' }

    const channel = await em.findOne(CommunicationChannel, {
      id: tuple.channelId,
      tenantId: tuple.tenantId,
      organizationId: tuple.organizationId,
    })
    if (!channel) return { status: 'missing' }

    // Event-time classification. Reading the channel's CURRENT mode here would
    // let a reprovision retroactively hand old messages to a different owner.
    const projectionModeAtEvent: ChannelProjectionMode =
      link.projectionModeAtIngest ?? 'legacy_customers'
    if (projectionModeAtEvent !== 'connect_managed') {
      return { status: 'not_connect_managed', projectionModeAtEvent }
    }
    if (!link.trafficEnabledAtIngest) {
      return { status: 'channel_disabled', projectionModeAtEvent }
    }

    const externalMessage = await em.findOne(ExternalMessage, {
      id: tuple.externalMessageId,
      channelId: tuple.channelId,
      conversationId: tuple.conversationId,
      tenantId: tuple.tenantId,
    })
    if (!externalMessage) return { status: 'missing' }

    const senderHandle = boundedString(externalMessage.senderIdentifier, INBOUND_SENDER_HANDLE_MAX_CHARS)
    if (!senderHandle) {
      // An inbound record with no sender cannot support identity resolution and
      // will never become resolvable, so it is permanently invalid rather than
      // retryable.
      return { status: 'permanent_invalid', reason: 'missing_sender' }
    }

    const payload = (link.channelPayload ?? {}) as Record<string, unknown>
    const headers = lowercaseHeaders(link.channelMetadata)
    const classification = classifyInboundLoop(headers, payload)

    return {
      status: 'found',
      projectionMode: projectionModeAtEvent,
      trafficEnabled: true,
      envelope: {
        senderHandle,
        senderType: classifySenderType(senderHandle),
        subject: boundedString(conversation.subject ?? payload.subject, INBOUND_SUBJECT_MAX_CHARS),
        isAutoResponder: classification.isAutoResponder,
        isBounce: classification.isBounce,
        classificationReason: classification.reason,
        replyTargetRef: buildReplyTargetRef(tuple),
        replyTargetMaskedLabel: maskRecipient(senderHandle),
        occurredAt: (externalMessage.providerTimestamp ?? externalMessage.createdAt).toISOString(),
      },
    }
  } catch (err) {
    // A database blip must be retryable, not a permanent classification.
    logger.warn('inbound envelope read failed', { err })
    return { status: 'transient_error' }
  }
}

// ── Reply-target resolution ──────────────────────────────────

export type ResolveInboundReplyTargetInput = {
  tenantId: string
  organizationId: string
  channelId: string
  conversationId: string
  replyTargetRef: string
  sourceVersion: number
}

export type ResolveInboundReplyTargetResult =
  | {
      status: 'resolved'
      kind: 'reply_to' | 'sender'
      /**
       * The real recipient. Server-only: it is returned so the hub's own send
       * path can use it, and must never reach a browser payload.
       */
      canonicalRecipientInternal: string
      maskedLabel: string
    }
  | { status: 'transient_error' }
  | { status: 'stale_or_wrong_ref' }
  | { status: 'ambiguous_multi_party' }
  | { status: 'unavailable' }

function extractAddress(value: unknown): string | null {
  if (typeof value === 'string') {
    const match = value.match(/<([^>]+)>/)
    const candidate = (match ? match[1] : value).trim()
    return candidate.includes('@') ? candidate.toLowerCase() : null
  }
  if (value && typeof value === 'object') {
    const address = (value as Record<string, unknown>).address
    if (typeof address === 'string' && address.includes('@')) return address.trim().toLowerCase()
  }
  return null
}

function extractAddresses(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(extractAddress).filter((address): address is string => address !== null)
  }
  const single = extractAddress(value)
  return single ? [single] : []
}

/**
 * Resolve an opaque reference to the address a reply must go to.
 *
 * Called at send enqueue and again at dispatch. Reply-To takes precedence over
 * the sender because that is what the sender asked for; a multi-party Reply-To
 * is refused rather than guessed, since picking one of several addresses on a
 * customer's behalf is a disclosure decision the hub is not entitled to make.
 *
 * No outcome here is ever `unknown` — that status is reserved for a send that
 * may have crossed provider dispatch. Every failure here is definitive BEFORE
 * any provider call, except `transient_error`, which keeps the send queued for
 * a bounded retry.
 */
export async function resolveInboundReplyTarget(
  container: ContainerLike,
  input: ResolveInboundReplyTargetInput,
): Promise<ResolveInboundReplyTargetResult> {
  if (input.sourceVersion !== INBOUND_REPLY_REF_SOURCE_VERSION) {
    return { status: 'stale_or_wrong_ref' }
  }

  const parts = input.replyTargetRef.split('.')
  if (parts.length !== 3 || parts[0] !== `v${INBOUND_REPLY_REF_SOURCE_VERSION}`) {
    return { status: 'stale_or_wrong_ref' }
  }
  const channelLinkId = parts[1]

  const verified = verifyReplyTargetRef(input.replyTargetRef, {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    channelId: input.channelId,
    conversationId: input.conversationId,
    channelLinkId,
  })
  if (!verified) return { status: 'stale_or_wrong_ref' }

  let em: EntityManager
  try {
    em = (container.resolve('em') as EntityManager).fork()
  } catch (err) {
    logger.warn('reply target resolution could not open a session', { err })
    return { status: 'transient_error' }
  }

  try {
    const link = await em.findOne(MessageChannelLink, {
      id: channelLinkId,
      externalConversationId: input.conversationId,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      direction: 'inbound',
    })
    // The signature proves the reference is ours; the row proves it still
    // points at something in this scope.
    if (!link) return { status: 'stale_or_wrong_ref' }

    const payload = (link.channelPayload ?? {}) as Record<string, unknown>
    const metadata = (link.channelMetadata ?? {}) as Record<string, unknown>

    const replyTo = extractAddresses(payload.replyTo ?? metadata.replyTo ?? metadata['reply-to'])
    if (replyTo.length > 1) return { status: 'ambiguous_multi_party' }
    if (replyTo.length === 1) {
      return {
        status: 'resolved',
        kind: 'reply_to',
        canonicalRecipientInternal: replyTo[0],
        maskedLabel: maskRecipient(replyTo[0]),
      }
    }

    const from = extractAddresses(payload.from ?? metadata.from)
    if (from.length > 1) return { status: 'ambiguous_multi_party' }
    if (from.length === 1) {
      return {
        status: 'resolved',
        kind: 'sender',
        canonicalRecipientInternal: from[0],
        maskedLabel: maskRecipient(from[0]),
      }
    }

    // Nothing to reply to and nothing that will make one appear later.
    return { status: 'unavailable' }
  } catch (err) {
    logger.warn('reply target resolution failed', { err })
    return { status: 'transient_error' }
  }
}

/** DI service types (`communicationChannelsInboundEnvelopeReader`). */
export type InboundEnvelopeReaderService = {
  readEnvelope: typeof readInboundEnvelope
  resolveReplyTarget: typeof resolveInboundReplyTarget
}

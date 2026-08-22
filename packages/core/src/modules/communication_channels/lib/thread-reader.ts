import { createHash } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ExternalConversation, MessageChannelLink } from '../data/entities'
import {
  SHARED_INBOX_READ_FEATURE,
  authorizeSharedInbox,
  type SharedInboxActor,
} from './shared-inbox-authorization'
import { htmlToText } from './email-mime'
import {
  decodeThreadReaderCursor,
  encodeThreadReaderCursor,
  hashAllowlist,
} from './thread-reader-cursor'

const logger = createLogger('communication_channels').child({ component: 'thread-reader' })

/**
 * Authorized thread reader (Connect upstream Contract C).
 *
 * A downstream inbox module needs to render inbound thread bodies and
 * direction. It cannot query hub tables directly, and a facade in `messages`
 * cannot produce the projection because `communication_channels` owns the
 * message-link direction and transport metadata.
 *
 * System-authored inbound rows fall outside the existing sender-or-recipient
 * participant predicate, so this facade is an explicit, separately reviewed
 * exception to that boundary — and it is deliberately narrow:
 *
 *   - It reads ONE channel per call, already authorized through Contract E.
 *   - It reads only conversations the caller explicitly allowlists, and proves
 *     every one of them belongs to that channel and scope. The allowlist NARROWS
 *     an authorized channel; it is never itself the grant.
 *   - It returns plain records. No ORM entity, entity manager, query callback or
 *     cross-tenant error distinction crosses DI.
 *   - It is batched and page-bounded. There is no filter or query interface a
 *     caller could widen.
 *
 * Existing participant-scoped message APIs are untouched.
 */

/** Hard bounds. A caller cannot widen them; oversized requests are rejected. */
export const THREAD_READER_MAX_ALLOWLIST = 200
export const THREAD_READER_MAX_PAGE_SIZE = 100
export const THREAD_READER_DEFAULT_PAGE_SIZE = 50
/** Bodies are truncated, not streamed: this facade renders previews, not archives. */
export const THREAD_READER_MAX_BODY_CHARS = 20_000

export type ThreadReaderInput = {
  channelId: string
  /** Non-empty, bounded allowlist of conversations to read within that channel. */
  externalConversationIds: readonly string[]
  pageSize?: number
  cursor?: string | null
}

export type ThreadReaderAttachment = {
  fileName: string
  mimeType: string
  fileSize: number | null
}

export type ThreadReaderItem =
  | {
      kind: 'message'
      id: string
      externalConversationId: string
      direction: 'inbound' | 'outbound'
      /** Bounded, source-sanitized plain text. Never HTML. */
      text: string
      truncated: boolean
      /** Display-only metadata. Phase 1 exposes no download URL or handle. */
      attachments: ThreadReaderAttachment[]
      deliveryStatus: string
      channelType: string
      occurredAt: string
    }
  | {
      /**
       * Stable-position placeholder for an item that could not be rendered
       * (decrypt failure, malformed payload). The rest of the page and its
       * cursor stay valid so one bad row cannot blank a whole thread.
       */
      kind: 'unavailable'
      id: string
      externalConversationId: string
      code: 'content_unavailable'
      retryable: boolean
      occurredAt: string
    }

export type ThreadReaderResult =
  | {
      status: 'ok'
      items: ThreadReaderItem[]
      nextCursor: string | null
      /** Conversation ids from the allowlist that are not bound to this channel. */
      unboundConversationIds: string[]
    }
  | {
      status: 'denied'
      reason: 'not_found' | 'channel_disabled' | 'not_a_member' | 'missing_feature' | 'traffic_not_enabled'
    }
  | { status: 'invalid'; reason: 'empty_allowlist' | 'allowlist_too_large' | 'page_size_too_large' | 'invalid_cursor' }

type ContainerLike = { resolve: <T = unknown>(name: string) => T }

/**
 * Fingerprint of the caller's current authorization on this channel.
 *
 * Derived from the membership row's identity and last-modified time, so a
 * revoke-then-regrant produces a different epoch and invalidates cursors minted
 * under the previous grant.
 */
function computeAuthorizationEpoch(membership: {
  id: string
  updatedAt: Date
  isActive: boolean
}): string {
  return createHash('sha256')
    .update(`${membership.id}:${membership.updatedAt.toISOString()}:${membership.isActive}`)
    .digest('hex')
}

function sanitizeBody(raw: unknown): { text: string; truncated: boolean } {
  const value = typeof raw === 'string' ? raw : ''
  // Strip control characters other than newline/tab so a crafted body cannot
  // corrupt a consumer's rendering or logs.
  const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  if (stripped.length <= THREAD_READER_MAX_BODY_CHARS) return { text: stripped, truncated: false }
  return { text: stripped.slice(0, THREAD_READER_MAX_BODY_CHARS), truncated: true }
}

function projectAttachments(raw: unknown): ThreadReaderAttachment[] {
  if (!Array.isArray(raw)) return []
  const projected: ThreadReaderAttachment[] = []
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') continue
    const attachment = candidate as Record<string, unknown>
    const fileName = typeof attachment.fileName === 'string' ? attachment.fileName : null
    const mimeType = typeof attachment.mimeType === 'string' ? attachment.mimeType : null
    if (!fileName || !mimeType) continue
    // `url` is deliberately dropped: Phase 1 exposes no download affordance, and
    // a signed provider URL is a credential.
    projected.push({
      fileName: fileName.slice(0, 255),
      mimeType: mimeType.slice(0, 255),
      fileSize: typeof attachment.fileSize === 'number' ? attachment.fileSize : null,
    })
  }
  return projected
}

/**
 * Project one link row. Returns an `unavailable` placeholder instead of
 * throwing, so a single unreadable body cannot fail the whole page.
 */
function projectLink(
  link: MessageChannelLink,
  externalConversationId: string,
): ThreadReaderItem {
  const occurredAt = link.createdAt.toISOString()
  try {
    const payload = (link.channelPayload ?? {}) as Record<string, unknown>
    const rawText =
      typeof payload.text === 'string'
        ? payload.text
        : typeof payload.html === 'string'
          ? htmlToText(payload.html)
          : ''
    const { text, truncated } = sanitizeBody(rawText)
    return {
      kind: 'message',
      id: link.id,
      externalConversationId,
      direction: link.direction,
      text,
      truncated,
      attachments: projectAttachments(payload.attachments),
      deliveryStatus: link.deliveryStatus,
      channelType: link.channelType,
      occurredAt,
    }
  } catch (err) {
    // Never let the reason leak: it could distinguish "encrypted with a key we
    // cannot load" from "malformed", which is source-internal detail.
    logger.warn('thread reader could not project a message', { linkId: link.id, err })
    return {
      kind: 'unavailable',
      id: link.id,
      externalConversationId,
      code: 'content_unavailable',
      retryable: true,
      occurredAt,
    }
  }
}

/**
 * Read an authorized, bounded page of a shared inbox's threads.
 *
 * `actor` is server-derived by the caller. Any membership assertion a caller
 * might send is ignored — membership is read from the source.
 */
export async function readAuthorizedThreads(
  container: ContainerLike,
  actor: SharedInboxActor,
  input: ThreadReaderInput,
): Promise<ThreadReaderResult> {
  const allowlist = Array.from(new Set(input.externalConversationIds ?? []))
  if (allowlist.length === 0) return { status: 'invalid', reason: 'empty_allowlist' }
  if (allowlist.length > THREAD_READER_MAX_ALLOWLIST) {
    return { status: 'invalid', reason: 'allowlist_too_large' }
  }
  const pageSize = input.pageSize ?? THREAD_READER_DEFAULT_PAGE_SIZE
  if (pageSize < 1 || pageSize > THREAD_READER_MAX_PAGE_SIZE) {
    return { status: 'invalid', reason: 'page_size_too_large' }
  }

  const em = (container.resolve('em') as EntityManager).fork()

  const authorization = await authorizeSharedInbox(
    em,
    input.channelId,
    actor,
    SHARED_INBOX_READ_FEATURE,
  )
  if (!authorization.ok) return { status: 'denied', reason: authorization.reason }

  const authorizationEpoch = computeAuthorizationEpoch(authorization.membership)
  const allowlistHash = hashAllowlist(allowlist)

  // Continuation re-validates everything the cursor claims against the
  // authorization we just recomputed. A cursor minted before a revoke, for a
  // different allowlist, or for another scope is refused rather than resumed.
  let after: { createdAt: Date; id: string } | null = null
  if (input.cursor) {
    const decoded = decodeThreadReaderCursor(input.cursor)
    if (
      !decoded ||
      decoded.tenantId !== actor.tenantId ||
      decoded.organizationId !== actor.organizationId ||
      decoded.channelId !== input.channelId ||
      decoded.authorizationEpoch !== authorizationEpoch ||
      decoded.allowlistHash !== allowlistHash ||
      decoded.pageSize !== pageSize
    ) {
      return { status: 'invalid', reason: 'invalid_cursor' }
    }
    const afterCreatedAt = new Date(decoded.afterCreatedAt)
    if (Number.isNaN(afterCreatedAt.getTime())) return { status: 'invalid', reason: 'invalid_cursor' }
    after = { createdAt: afterCreatedAt, id: decoded.afterId }
  }

  // Prove every allowlisted conversation belongs to THIS channel and scope.
  // Anything else is simply absent from the result: reporting it as "exists
  // elsewhere" would confirm an id in another tenant or organization.
  const conversations = await em.find(ExternalConversation, {
    externalConversationId: { $in: allowlist },
    channelId: authorization.channel.id,
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
  })
  const conversationIdByRowId = new Map<string, string>()
  for (const conversation of conversations) {
    conversationIdByRowId.set(conversation.id, conversation.externalConversationId)
  }
  const boundExternalIds = new Set(conversations.map((row) => row.externalConversationId))
  const unboundConversationIds = allowlist.filter((id) => !boundExternalIds.has(id))

  if (conversations.length === 0) {
    return { status: 'ok', items: [], nextCursor: null, unboundConversationIds }
  }

  // Deterministic total order so paging cannot skip or repeat a record when two
  // messages share a timestamp.
  const where: Record<string, unknown> = {
    externalConversationId: { $in: Array.from(conversationIdByRowId.keys()) },
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
  }
  if (after) {
    where.$or = [
      { createdAt: { $gt: after.createdAt } },
      { createdAt: after.createdAt, id: { $gt: after.id } },
    ]
  }

  const links = await em.find(MessageChannelLink, where, {
    orderBy: { createdAt: 'asc', id: 'asc' },
    // One extra row tells us whether another page exists without a count query.
    limit: pageSize + 1,
  })

  const pageLinks = links.slice(0, pageSize)
  const items = pageLinks.map((link) =>
    projectLink(link, conversationIdByRowId.get(link.externalConversationId) ?? ''),
  )

  const hasMore = links.length > pageSize
  const last = pageLinks[pageLinks.length - 1]
  const nextCursor =
    hasMore && last
      ? encodeThreadReaderCursor({
          tenantId: actor.tenantId,
          organizationId: actor.organizationId,
          channelId: input.channelId,
          authorizationEpoch,
          allowlistHash,
          pageSize,
          afterCreatedAt: last.createdAt.toISOString(),
          afterId: last.id,
        })
      : null

  return { status: 'ok', items, nextCursor, unboundConversationIds }
}

/** DI service type for downstream inbox modules (`communicationChannelsThreadReader`). */
export type ThreadReaderService = typeof readAuthorizedThreads

import { LockMode } from '@mikro-orm/core'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  ConnectCase,
  ConnectCaseTransition,
  ConnectContactIdentity,
  ConnectConversation,
  ConnectConversationCaseBinding,
  ConnectIdentityCaseBinding,
  ConnectSettings,
  type ConnectCaseStatus,
} from '../data/entities'
import { evaluateAttach, type AttachCandidate } from '../lib/case-lifecycle'
import { classifyInbound, mayAcknowledge } from '../lib/inbound-classifier'
import { recordInboundHit } from '../lib/inbound-rate-limiter'
import { hashHandle, resolveIdentity } from '../lib/identity-resolver'
import { claimInboundReceipt, completeReceipt } from '../lib/receipt-claim'
import { stageDomainEvent } from '../lib/domain-outbox'
import { evaluateActivation } from '../lib/activation'
import { CONNECT_QUEUES } from '../lib/queue'

const logger = createLogger('connect').child({ component: 'ingest-inbound-message' })

/**
 * Turn one `communication_channels.message.received` event into exactly one
 * Case decision.
 *
 * Order matters and is not arbitrary:
 *
 *   1. **Activation** — before anything, because an inert Connect must not
 *      dead-letter a legacy tenant's mail, and a post-enable outage must fail
 *      RETRYABLY rather than acknowledge a message it cannot process.
 *   2. **Contract D classification** — the event-time projection mode decides
 *      whether this message is Connect's at all. A legacy or disabled result
 *      creates no Connect row whatsoever.
 *   3. **Receipt claim** — a unique insert, before any non-idempotent work, so
 *      a duplicate delivery cannot double-count or double-open.
 *   4. **Suppression** — auto-responders and bounces are recorded and dropped.
 *   5. **Identity, then the Case decision under the identity binding lock** —
 *      so two messages from the same person cannot both conclude "no active
 *      Case" and open two.
 */

const ingestInputSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  channelId: z.string().uuid(),
  /**
   * The hub-owned `ExternalConversation.id`, published by the event as
   * `conversationId`. NOT the provider thread ref and NOT the ingest command's
   * `externalConversationId` return field — substituting either would bind
   * Connect to a key the event does not publish.
   */
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  externalMessageId: z.string().uuid(),
  channelLinkId: z.string().uuid(),
  sourceEventId: z.string().optional(),
})

export type IngestInboundMessageInput = z.infer<typeof ingestInputSchema>

export type IngestInboundMessageResult =
  | { status: 'opened'; caseId: string; receiptId: string }
  | { status: 'attached'; caseId: string; receiptId: string }
  | { status: 'suppressed'; reason: string; receiptId: string }
  | { status: 'duplicate'; receiptId: string }
  | { status: 'not_connect_managed' }
  | { status: 'inert'; missing: string[] }
  | { status: 'dead_lettered'; reason: string; receiptId: string }

/**
 * Thrown when the handler must NOT acknowledge the persistent source event.
 *
 * The distinction matters: a definitively-classified message is acknowledged
 * even when Connect stores nothing for it, but a transient outage must leave the
 * event unacknowledged so the bus redelivers it. Acknowledging a message we
 * could not process is how customer mail disappears.
 */
export class ConnectIngestRetryableError extends Error {
  override name = 'ConnectIngestRetryableError'
  constructor(readonly reason: string) {
    super(`[connect] inbound ingest is temporarily unable to proceed: ${reason}`)
  }
}

export const CONNECT_INGEST_COMMAND_ID = 'connect.inbound.ingest_message'

type ContainerLike = {
  hasRegistration?: (name: string) => boolean
  resolve: <T = unknown>(name: string) => T
}

type EnvelopeReaderLike = {
  readEnvelope: (
    container: ContainerLike,
    tuple: Record<string, string>,
  ) => Promise<Record<string, unknown>>
}

const DEFAULT_SETTINGS = {
  attachWindowHours: 72,
  reopenWindowDays: 7,
  autoCloseAfterDays: 14,
  identityMatchThreshold: 80,
  suppressionCount: 3,
  suppressionWindowMinutes: 60,
}

async function loadSettings(
  em: EntityManager,
  tenantId: string,
  organizationId: string,
): Promise<typeof DEFAULT_SETTINGS> {
  const row = await em.findOne(ConnectSettings, { tenantId, organizationId })
  if (!row) return DEFAULT_SETTINGS
  return {
    attachWindowHours: row.attachWindowHours,
    reopenWindowDays: row.reopenWindowDays,
    autoCloseAfterDays: row.autoCloseAfterDays,
    identityMatchThreshold: row.identityMatchThreshold,
    suppressionCount: row.suppressionCount,
    suppressionWindowMinutes: row.suppressionWindowMinutes,
  }
}

/** Per-organization Case numbers, allocated from the current maximum. */
async function nextCaseNumber(
  em: EntityManager,
  tenantId: string,
  organizationId: string,
): Promise<number> {
  const rows = (await em.execute(
    `select coalesce(max("number"), 0) + 1 as "next" from "connect_cases"
      where "tenant_id" = ? and "organization_id" = ?`,
    [tenantId, organizationId],
  )) as Array<{ next: number }>
  return Number(rows[0]?.next ?? 1)
}

export async function ingestInboundMessage(
  container: ContainerLike,
  rawInput: IngestInboundMessageInput,
  now: Date = new Date(),
): Promise<IngestInboundMessageResult> {
  const input = ingestInputSchema.parse(rawInput)

  // (1) Activation. Inert is a normal, silent no-op; a post-enable outage is
  // surfaced by the caller as a retryable failure (see the subscriber).
  const activation = evaluateActivation(container)
  if (activation.state !== 'active') {
    return { status: 'inert', missing: activation.missing }
  }

  const envelopeReader = container.resolve<EnvelopeReaderLike>(
    'communicationChannelsInboundEnvelopeReader',
  )

  // (2) Event-time classification from the source. This decides whether the
  // message belongs to Connect AT ALL, using the snapshot taken at ingest —
  // never the channel's current mode.
  const envelopeResult = (await envelopeReader.readEnvelope(container, {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    channelId: input.channelId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    externalMessageId: input.externalMessageId,
    channelLinkId: input.channelLinkId,
  })) as { status: string; envelope?: Record<string, unknown> }

  if (envelopeResult.status === 'transient_error') {
    throw new ConnectIngestRetryableError('inbound_envelope_transient')
  }
  if (
    envelopeResult.status === 'not_connect_managed' ||
    envelopeResult.status === 'channel_disabled'
  ) {
    // Legacy or pre-cutover traffic: create no receipt, no identity, no
    // conversation, no Case. A later reprovision must not reclassify it.
    return { status: 'not_connect_managed' }
  }
  if (envelopeResult.status !== 'found' || !envelopeResult.envelope) {
    // `missing` / `permanent_invalid` are definitive. Acknowledge the source
    // event; retrying cannot make an absent or malformed record appear.
    return { status: 'not_connect_managed' }
  }

  const envelope = envelopeResult.envelope as {
    senderHandle: string
    senderType: string
    subject: string
    isAutoResponder: boolean
    isBounce: boolean
    classificationReason: string | null
    replyTargetRef: string
    replyTargetMaskedLabel: string
    occurredAt: string
  }

  const em = (container.resolve('em') as EntityManager).fork()
  const scope = { tenantId: input.tenantId, organizationId: input.organizationId }

  // (3) Claim the receipt BEFORE any non-idempotent work.
  const claim = await claimInboundReceipt(
    em,
    { ...scope, channelId: input.channelId, externalMessageId: input.externalMessageId },
    input.sourceEventId ?? null,
    now,
  )
  if (claim.status === 'duplicate') {
    return { status: 'duplicate', receiptId: claim.receipt.id }
  }
  const receipt = claim.receipt

  // Announce the claim itself: operational metrics count claimed-vs-disposed to
  // detect receipts that never reached a terminal state.
  stageDomainEvent(em, {
    ...scope,
    sourceEventId: `connect.inbound.claimed:${receipt.id}`,
    aggregateId: receipt.id,
    aggregateVersion: receipt.attempts,
    eventType: 'connect.inbound.claimed',
    payload: {
      receiptId: receipt.id,
      channelId: input.channelId,
      reclaimed: claim.status === 'reclaimed',
      // The cohort is frozen here. A terminal fact that lands after midnight
      // still reconciles against the day this receipt was claimed.
      claimCohortUtcDate: receipt.claimCohortUtcDate,
      claimedAt: now.toISOString(),
      leaseExpiresAt: receipt.leaseExpiresAt?.toISOString() ?? null,
    },
  })
  await em.flush()

  const settings = await loadSettings(em, scope.tenantId, scope.organizationId)
  const handleHash = hashHandle(envelope.senderType, envelope.senderHandle)

  // (4) Suppression. Auto-responders and bounces are recorded and dropped so an
  // operator can see what was filtered; silently discarding them would make a
  // mis-tuned classifier invisible.
  const suppression = await recordInboundHit(
    em,
    { ...scope, channelId: input.channelId, fromHandleHash: handleHash },
    { count: settings.suppressionCount, windowMinutes: settings.suppressionWindowMinutes },
    input.externalMessageId,
    now,
  )
  const disposition = classifyInbound({
    classification: {
      isAutoResponder: envelope.isAutoResponder,
      isBounce: envelope.isBounce,
      classificationReason: envelope.classificationReason,
    },
    rateLimited: suppression.status === 'suppressed',
  })

  if (disposition.action === 'suppress') {
    completeReceipt(receipt, { disposition: 'suppressed', terminalReason: disposition.reason }, now)
    stageDomainEvent(em, {
      ...scope,
      sourceEventId: `connect.inbound.disposed:${receipt.id}`,
      aggregateId: receipt.id,
      aggregateVersion: receipt.attempts,
      eventType: 'connect.inbound.disposed',
      payload: {
        receiptId: receipt.id,
        channelId: input.channelId,
        disposition: 'suppressed',
        reason: disposition.reason,
        claimCohortUtcDate: receipt.claimCohortUtcDate,
        // Hash only — enough to bound a per-sender rate, never enough to
        // recover an address from a reporting table.
        senderHash: handleHash,
        // The settings actually in force for THIS decision. Without them a
        // later settings change silently reinterprets history.
        appliedWindowMinutes: settings.suppressionWindowMinutes,
        appliedCountLimit: settings.suppressionCount,
        occurredAt: now.toISOString(),
      },
    })
    await em.flush()
    return { status: 'suppressed', reason: disposition.reason, receiptId: receipt.id }
  }

  // A suppression-counter outage never widens the key and never drops the
  // message — it only withholds the automated acknowledgement, which is the one
  // action that can start a loop.
  const acknowledgementAllowed = mayAcknowledge(disposition, suppression.status !== 'unavailable')
  if (!acknowledgementAllowed) {
    logger.warn('storing inbound without acknowledgement; suppression counter unavailable', {
      channelId: input.channelId,
    })
  }

  // (5) Identity, then the Case decision under the identity binding lock.
  const resolved = await resolveIdentity(em, {
    scope: { ...scope, channelId: input.channelId },
    handleType: envelope.senderType,
    handleValue: envelope.senderHandle,
    // Foundation performs no customer matching; Customer Projection supplies
    // candidates later. Until then every identity is legitimately unresolved,
    // which means every Case opens in isolation — the safe default.
    candidate: null,
    threshold: settings.identityMatchThreshold,
  })

  // An unresolved identity is the signal Customer Projection reacts to. Staged
  // atomically with the identity so a crash cannot leave one without the other,
  // and it carries the identity id only — never the handle.
  if (resolved.created && resolved.linkState === 'unresolved') {
    stageDomainEvent(em, {
      ...scope,
      sourceEventId: `connect.contact_identity.unresolved:${resolved.identity.id}`,
      aggregateId: resolved.identity.id,
      aggregateVersion: 1,
      eventType: 'connect.contact_identity.unresolved',
      payload: {
        identityId: resolved.identity.id,
        channelId: input.channelId,
        linkState: resolved.linkState,
      },
    })
    await em.flush()
  }

  const outcome = await em.transactional(async (tem) => {
    const binding = await lockIdentityBinding(tem as EntityManager, scope, resolved.identity.id)

    const boundCase = binding.currentCaseId
      ? await (tem as EntityManager).findOne(ConnectCase, {
          id: binding.currentCaseId,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          deletedAt: null,
        })
      : null

    const legacyCandidates: AttachCandidate[] =
      resolved.identity.linkState === 'linked' && resolved.identity.customerId
        ? (
            await (tem as EntityManager).find(
              ConnectCase,
              {
                tenantId: scope.tenantId,
                organizationId: scope.organizationId,
                customerId: resolved.identity.customerId,
                deletedAt: null,
              },
              { orderBy: { lastInboundAt: 'desc', id: 'asc' }, limit: 20 },
            )
          ).map(toCandidate)
        : []

    const decision = evaluateAttach({
      identityLinked: resolved.identity.linkState === 'linked',
      boundCase: boundCase ? toCandidate(boundCase) : null,
      legacyCandidates,
      windows: settings,
      now,
    })

    if (decision.decision === 'attach' && boundCase && decision.caseId === boundCase.id) {
      return applyAttach(tem as EntityManager, scope, boundCase, decision.nextStatus, now)
    }
    if (decision.decision === 'attach') {
      const target = await (tem as EntityManager).findOne(ConnectCase, {
        id: decision.caseId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      })
      if (target) return applyAttach(tem as EntityManager, scope, target, decision.nextStatus, now)
    }

    return openCase(tem as EntityManager, {
      scope,
      channelId: input.channelId,
      identity: resolved.identity,
      binding,
      envelope,
      previousCaseId: boundCase?.status === 'closed' ? boundCase.id : null,
      now,
    })
  })

  // Conversation binding + reply target, then close the receipt out.
  await upsertConversation(em, {
    scope,
    channelId: input.channelId,
    externalConversationId: input.conversationId,
    caseId: outcome.caseId,
    externalMessageId: input.externalMessageId,
    messageId: input.messageId,
    envelope,
    now,
  })

  completeReceipt(
    receipt,
    { disposition: outcome.opened ? 'opened' : 'attached', caseId: outcome.caseId },
    now,
  )
  stageDomainEvent(em, {
    ...scope,
    sourceEventId: `${outcome.opened ? 'connect.case.opened' : 'connect.case.attached'}:${receipt.id}`,
    aggregateId: outcome.caseId,
    aggregateVersion: 1,
    eventType: outcome.opened ? 'connect.case.opened' : 'connect.case.attached',
    payload: { caseId: outcome.caseId, channelId: input.channelId, receiptId: receipt.id },
  })
  stageDomainEvent(em, {
    ...scope,
    sourceEventId: `connect.inbound.disposed:${receipt.id}`,
    aggregateId: receipt.id,
    aggregateVersion: receipt.attempts,
    eventType: 'connect.inbound.disposed',
    payload: {
      receiptId: receipt.id,
      channelId: input.channelId,
      disposition: outcome.opened ? 'opened' : 'attached',
      caseId: outcome.caseId,
      claimCohortUtcDate: receipt.claimCohortUtcDate,
      senderHash: handleHash,
      appliedWindowMinutes: settings.suppressionWindowMinutes,
      appliedCountLimit: settings.suppressionCount,
      occurredAt: now.toISOString(),
    },
  })
  await em.flush()

  // Best-effort wake so staged events publish promptly. The scheduled sweep is
  // the correctness guarantee — this only removes the latency of waiting for it,
  // so a failure here is logged and ignored rather than failing a committed
  // ingest.
  await wakeDomainOutbox(container)

  return outcome.opened
    ? { status: 'opened', caseId: outcome.caseId, receiptId: receipt.id }
    : { status: 'attached', caseId: outcome.caseId, receiptId: receipt.id }
}

type QueueLike = { enqueue: (payload: Record<string, unknown>) => Promise<unknown> }
type QueueFactoryLike = { getQueue?: (name: string) => QueueLike | undefined }

async function wakeDomainOutbox(container: ContainerLike): Promise<void> {
  try {
    const factory = container.resolve<QueueFactoryLike>('queueFactory')
    const queue = factory?.getQueue?.(CONNECT_QUEUES.domainOutbox)
    if (queue) await queue.enqueue({ reason: 'after_commit_wake' })
  } catch (err) {
    logger.debug('domain outbox wake job could not be enqueued; the sweep will publish', { err })
  }
}

function toCandidate(row: ConnectCase): AttachCandidate {
  return {
    id: row.id,
    status: row.status,
    lastInboundAt: row.lastInboundAt ?? null,
    resolvedAt: row.resolvedAt ?? null,
  }
}

/**
 * The single serialization point for ingest, link, unlink and resolve.
 *
 * Created on demand and immediately locked, so concurrent inbound for one
 * identity queue behind each other instead of racing the attach decision.
 */
async function lockIdentityBinding(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  identityId: string,
): Promise<ConnectIdentityCaseBinding> {
  const existing = await em.findOne(
    ConnectIdentityCaseBinding,
    { tenantId: scope.tenantId, organizationId: scope.organizationId, identityId },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  )
  if (existing) return existing

  const created = em.create(ConnectIdentityCaseBinding, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    identityId,
    currentCaseId: null,
    version: 0,
  })
  em.persist(created)
  await em.flush()
  return created
}

async function applyAttach(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  target: ConnectCase,
  nextStatus: ConnectCaseStatus,
  now: Date,
): Promise<{ caseId: string; opened: false }> {
  const previousStatus = target.status
  target.lastInboundAt = now
  if (nextStatus !== previousStatus) {
    target.status = nextStatus
    if (nextStatus === 'in_progress') target.resolvedAt = null
    em.persist(
      em.create(ConnectCaseTransition, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        caseId: target.id,
        actorKind: 'system',
        actorUserId: null,
        fromStatus: previousStatus,
        toStatus: nextStatus,
        payload: { trigger: 'inbound' },
      }),
    )
  }
  await em.flush()
  return { caseId: target.id, opened: false }
}

async function openCase(
  em: EntityManager,
  args: {
    scope: { tenantId: string; organizationId: string }
    channelId: string
    identity: ConnectContactIdentity
    binding: ConnectIdentityCaseBinding
    envelope: { subject: string; replyTargetMaskedLabel: string }
    previousCaseId: string | null
    now: Date
  },
): Promise<{ caseId: string; opened: true }> {
  const { scope, now } = args
  const number = await nextCaseNumber(em, scope.tenantId, scope.organizationId)

  const created = em.create(ConnectCase, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    number,
    subject: args.envelope.subject || null,
    // The list label is derived from the MASKED handle, never the subject — a
    // subject is the customer's own words and must not leak into lists or logs.
    displayLabel: args.identity.handleDisplayLabel ?? args.envelope.replyTargetMaskedLabel,
    status: 'new',
    priority: 'normal',
    customerKind: args.identity.customerKind ?? null,
    customerId: args.identity.customerId ?? null,
    channelId: args.channelId,
    firstInboundAt: now,
    lastInboundAt: now,
    previousCaseId: args.previousCaseId,
  })
  em.persist(created)
  em.persist(
    em.create(ConnectCaseTransition, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      caseId: created.id,
      actorKind: 'system',
      actorUserId: null,
      fromStatus: null,
      toStatus: 'new',
      payload: { trigger: 'inbound', successor: args.previousCaseId != null },
    }),
  )
  await em.flush()

  args.binding.currentCaseId = created.id
  args.binding.version += 1
  await em.flush()

  return { caseId: created.id, opened: true }
}

/**
 * Upsert the conversation row and its reply target.
 *
 * Only a NEWER accepted inbound replaces the reply target: a late-arriving older
 * message must not re-point future replies at a stale address.
 */
async function upsertConversation(
  em: EntityManager,
  args: {
    scope: { tenantId: string; organizationId: string }
    channelId: string
    externalConversationId: string
    caseId: string
    externalMessageId: string
    messageId: string
    envelope: { replyTargetRef: string; replyTargetMaskedLabel: string; occurredAt: string }
    now: Date
  },
): Promise<void> {
  const { scope } = args
  const occurredAt = new Date(args.envelope.occurredAt)
  const messageAt = Number.isNaN(occurredAt.getTime()) ? args.now : occurredAt

  const existing = await em.findOne(
    ConnectConversation,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      externalConversationId: args.externalConversationId,
    },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  )

  if (!existing) {
    const conversation = em.create(ConnectConversation, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      channelId: args.channelId,
      externalConversationId: args.externalConversationId,
      currentCaseId: args.caseId,
      lastExternalMessageId: args.externalMessageId,
      lastMessageAt: messageAt,
      replyTargetRef: args.envelope.replyTargetRef,
      replyTargetMaskedLabel: args.envelope.replyTargetMaskedLabel,
      replyTargetSourceVersion: 1,
      replyTargetMessageId: args.messageId,
      replyTargetExternalMessageId: args.externalMessageId,
    })
    em.persist(conversation)
    await em.flush()
    em.persist(
      em.create(ConnectConversationCaseBinding, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        conversationId: conversation.id,
        caseId: args.caseId,
        boundAt: args.now,
        reason: 'inbound',
      }),
    )
    await em.flush()
    return
  }

  const isNewer = !existing.lastMessageAt || messageAt.getTime() >= existing.lastMessageAt.getTime()
  if (isNewer) {
    existing.lastExternalMessageId = args.externalMessageId
    existing.lastMessageAt = messageAt
    existing.replyTargetRef = args.envelope.replyTargetRef
    existing.replyTargetMaskedLabel = args.envelope.replyTargetMaskedLabel
    existing.replyTargetSourceVersion = 1
    existing.replyTargetMessageId = args.messageId
    existing.replyTargetExternalMessageId = args.externalMessageId
  }

  if (existing.currentCaseId !== args.caseId) {
    const previousCaseId = existing.currentCaseId
    existing.currentCaseId = args.caseId
    await em.flush()
    if (previousCaseId) {
      await em.execute(
        `update "connect_conversation_case_bindings"
            set "unbound_at" = ?
          where "tenant_id" = ? and "conversation_id" = ? and "case_id" = ? and "unbound_at" is null`,
        [args.now, scope.tenantId, existing.id, previousCaseId],
      )
    }
    em.persist(
      em.create(ConnectConversationCaseBinding, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        conversationId: existing.id,
        caseId: args.caseId,
        boundAt: args.now,
        reason: 'inbound',
      }),
    )
  }
  await em.flush()
}

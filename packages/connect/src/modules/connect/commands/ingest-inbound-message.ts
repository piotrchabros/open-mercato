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
import {
  evaluateAttach,
  evaluateConversationOwnership,
  type AttachCandidate,
} from '../lib/case-lifecycle'
import { allocateConnectCaseNumber } from '../lib/case-number'
import { classifyInbound, mayAcknowledge } from '../lib/inbound-classifier'
import { recordInboundHit } from '../lib/inbound-rate-limiter'
import { hashHandle, resolveIdentity } from '../lib/identity-resolver'
import { claimInboundReceipt, completeReceipt } from '../lib/receipt-claim'
import { stageDomainEvent } from '../lib/domain-outbox'
import { recordGenerationStarted, recordWaitEnded } from '../lib/sla-source-facts'
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

  /**
   * The Case decision AND the conversation binding, in ONE transaction.
   *
   * They used to be two: the Case was decided under the identity lock, then the
   * conversation pointer was updated afterwards. That gap is where a reparenting
   * gets silently undone — a supervisor moves a Conversation to another Case,
   * and the next message reassigns it from outside any lock the supervisor held.
   *
   * Lock order is Conversation, then identity binding, then the Case. The
   * Conversation lock is the one reparenting also takes, so the two paths
   * serialize on it instead of interleaving.
   */
  const outcome = await em.transactional(async (tem) => {
    const txEm = tem as EntityManager

    const conversation = await txEm.findOne(
      ConnectConversation,
      {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        externalConversationId: input.conversationId,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )

    const binding = await lockIdentityBinding(txEm, scope, resolved.identity.id)

    // (a) The Conversation's own Case wins, when it is still live. This is the
    // supported correction override that split and merge create.
    const owner = conversation?.currentCaseId
      ? await txEm.findOne(ConnectCase, {
          id: conversation.currentCaseId,
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          deletedAt: null,
        })
      : null
    const ownership = evaluateConversationOwnership(
      owner
        ? { caseId: owner.id, status: owner.status, mergedIntoCaseId: owner.mergedIntoCaseId ?? null }
        : null,
    )

    let decided: CaseDecision
    if (ownership.decision === 'attach' && owner) {
      decided = await applyAttach(txEm, scope, owner, ownership.nextStatus, receipt.id, now)
    } else {
      decided = await decideByIdentity(txEm, {
        scope,
        channelId: input.channelId,
        identity: resolved.identity,
        binding,
        envelope,
        settings,
        // A Conversation whose Case closed chains to it directly. The identity
        // binding may point somewhere else entirely after a split.
        conversationSuccessorOf: ownership.decision === 'fall_through' ? ownership.successorOf : null,
        receiptId: receipt.id,
        now,
      })
    }

    // (b) Pointer, interval and reply target, still inside this transaction.
    await applyConversationBinding(txEm, {
      scope,
      channelId: input.channelId,
      externalConversationId: input.conversationId,
      existing: conversation,
      caseId: decided.caseId,
      externalMessageId: input.externalMessageId,
      messageId: input.messageId,
      envelope,
      now,
    })

    return decided
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

export type CaseDecision = { caseId: string; opened: boolean }

/**
 * The pre-existing identity/customer attach rule, unchanged.
 *
 * Reached only when the Conversation has no live Case of its own — a brand-new
 * conversation, or one whose Case closed or was merged away. A new conversation
 * for a known identity still follows this rule by design: nobody has said where
 * it belongs, so the identity binding is the best available evidence.
 */
async function decideByIdentity(
  em: EntityManager,
  args: {
    scope: { tenantId: string; organizationId: string }
    channelId: string
    identity: ConnectContactIdentity
    binding: ConnectIdentityCaseBinding
    envelope: { subject: string; replyTargetMaskedLabel: string }
    settings: typeof DEFAULT_SETTINGS
    conversationSuccessorOf: string | null
    receiptId: string
    now: Date
  },
): Promise<CaseDecision> {
  const { scope, identity, binding, now } = args

  const boundCase = binding.currentCaseId
    ? await em.findOne(ConnectCase, {
        id: binding.currentCaseId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        deletedAt: null,
      })
    : null

  const legacyCandidates: AttachCandidate[] =
    identity.linkState === 'linked' && identity.customerId
      ? (
          await em.find(
            ConnectCase,
            {
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              customerId: identity.customerId,
              deletedAt: null,
              // A merged source is historical and must never absorb new inbound;
              // its canonical target is a candidate in its own right.
              mergedIntoCaseId: null,
            },
            { orderBy: { lastInboundAt: 'desc', id: 'asc' }, limit: 20 },
          )
        ).map(toCandidate)
      : []

  const eligibleBound = boundCase && !boundCase.mergedIntoCaseId ? boundCase : null

  const decision = evaluateAttach({
    identityLinked: identity.linkState === 'linked',
    boundCase: eligibleBound ? toCandidate(eligibleBound) : null,
    legacyCandidates,
    windows: args.settings,
    now,
  })

  if (decision.decision === 'attach' && eligibleBound && decision.caseId === eligibleBound.id) {
    return applyAttach(em, scope, eligibleBound, decision.nextStatus, args.receiptId, now)
  }
  if (decision.decision === 'attach') {
    const target = await em.findOne(ConnectCase, {
      id: decision.caseId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      deletedAt: null,
    })
    if (target) return applyAttach(em, scope, target, decision.nextStatus, args.receiptId, now)
  }

  return openCase(em, {
    scope,
    channelId: args.channelId,
    identity,
    binding,
    envelope: args.envelope,
    previousCaseId:
      args.conversationSuccessorOf ?? (boundCase?.status === 'closed' ? boundCase.id : null),
    receiptId: args.receiptId,
    now,
  })
}

async function applyAttach(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
  target: ConnectCase,
  nextStatus: ConnectCaseStatus,
  receiptId: string,
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

  // The customer answered, so any wait on the round they were answering is
  // over. Recorded against the round in force BEFORE a reopen, otherwise the
  // interval would be attributed to a round that had not started when it began.
  if (previousStatus === 'waiting_customer' && nextStatus !== previousStatus) {
    await recordWaitEnded(em, {
      ...scope,
      sourceEventId: `connect.case.customer_wait_ended:${receiptId}`,
      caseId: target.id,
      generation: target.slaGeneration,
      occurredAt: now,
    })
  }

  // An inbound that revives a resolved Case is a reopen in every sense that
  // matters downstream, so it starts a new round exactly as the explicit
  // command does. Treating only the button as a reopen would let a customer's
  // reply accrue silently against the round that was already reported resolved.
  if (previousStatus === 'resolved' && nextStatus === 'in_progress') {
    target.slaGeneration += 1
    await recordGenerationStarted(em, {
      ...scope,
      sourceEventId: `connect.case.generation_started:${receiptId}`,
      caseId: target.id,
      generation: target.slaGeneration,
      channelId: target.channelId,
      cause: 'reopened',
      occurredAt: now,
    })
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
    receiptId: string
    now: Date
  },
): Promise<{ caseId: string; opened: true }> {
  const { scope, now } = args
  // From the locked sequence, shared with split-child creation. `max(number)+1`
  // is a read rather than an allocation: two openers race, both claim the same
  // number, and one dies on the unique constraint after all its other work.
  const number = await allocateConnectCaseNumber(em, scope)

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

  // Round 0 opens with the Case. Emitting it here, rather than lazily on the
  // first reply, is what lets a consumer see a Case that was never answered at
  // all — the case that matters most and the one a lazy write would hide.
  await recordGenerationStarted(em, {
    ...scope,
    sourceEventId: `connect.case.generation_started:${args.receiptId}`,
    caseId: created.id,
    generation: created.slaGeneration,
    channelId: args.channelId,
    cause: 'opened',
    occurredAt: now,
  })
  await em.flush()

  args.binding.currentCaseId = created.id
  args.binding.version += 1
  await em.flush()

  return { caseId: created.id, opened: true }
}

/**
 * Write the conversation row, its reply target and its Case interval.
 *
 * Runs inside the Case-decision transaction on the ALREADY-LOCKED conversation
 * (`existing`), rather than re-finding and re-locking it. Re-reading here would
 * reopen the window the single transaction exists to close.
 *
 * Only a NEWER accepted inbound replaces the reply target: a late-arriving older
 * message must not re-point future replies at a stale address.
 */
async function applyConversationBinding(
  em: EntityManager,
  args: {
    scope: { tenantId: string; organizationId: string }
    channelId: string
    externalConversationId: string
    existing: ConnectConversation | null
    caseId: string
    externalMessageId: string
    messageId: string
    envelope: { replyTargetRef: string; replyTargetMaskedLabel: string; occurredAt: string }
    now: Date
  },
): Promise<void> {
  const { scope, existing } = args
  const occurredAt = new Date(args.envelope.occurredAt)
  const messageAt = Number.isNaN(occurredAt.getTime()) ? args.now : occurredAt

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
    existing.currentCaseId = args.caseId
    await em.flush()
    // Close EVERY open interval for this conversation, not just the one naming
    // the previous Case. At most one may exist — the partial unique index says
    // so — and closing by conversation is what keeps that true even if the
    // pointer and the intervals ever disagreed.
    await em.execute(
      `update "connect_conversation_case_bindings"
          set "unbound_at" = ?
        where "tenant_id" = ? and "organization_id" = ? and "conversation_id" = ?
          and "unbound_at" is null`,
      [args.now, scope.tenantId, scope.organizationId, existing.id],
    )
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

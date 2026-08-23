import { createHash, randomUUID } from 'node:crypto'
import { LockMode } from '@mikro-orm/core'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  ConnectCase,
  ConnectConversation,
  ConnectOutbox,
  ConnectOutboundAttempt,
  ConnectOutboundMessage,
} from '../data/entities'
import { evaluateCaseAccess, type CaseActor } from '../lib/case-access'
import { stageDomainEvent } from '../lib/domain-outbox'
import { INBOUND_REPLY_REF_SOURCE_VERSION } from '../lib/reply-target'
import {
  CONNECT_CONTENT_ORIGINS,
  CONNECT_RESPONSE_EVIDENCE_VERSION,
  computeResponseEvidence,
  resolvePrincipalKindsSoftly,
} from '../lib/response-evidence'

const logger = createLogger('connect').child({ component: 'enqueue-outbound' })

/**
 * Accept an agent's reply and make it durable.
 *
 * This command never calls a provider. It writes the logical message, its first
 * attempt and the dispatch outbox row in ONE transaction, then returns 202. A
 * crash immediately afterwards loses nothing: the outbox row is the instruction,
 * and the queue job that usually picks it up is only a latency optimisation.
 *
 * Three protections matter here, and all three exist because a duplicate reply
 * to a customer is unrecoverable:
 *
 *   1. **Client command key.** Unique per tenant+organization+Case. A lost 202
 *      is retried with the same key and resolves to the existing message.
 *   2. **Payload fingerprint.** A retry that changed the text is not a retry;
 *      it is a different message, and reusing the key for it would silently
 *      discard one of them.
 *   3. **Server-resolved destination.** The recipient comes from the Case-bound
 *      conversation's Contract D reference, never from the request. The browser
 *      only ever sees a masked label.
 */

const enqueueSchema = z.object({
  caseId: z.string().uuid(),
  /** Must be the conversation currently bound to this Case. */
  conversationId: z.string().uuid(),
  clientCommandKey: z.string().min(1).max(200),
  body: z.string().min(1).max(50_000),
  /**
   * SERVER-OWNED. Trusted human reply routes pass `human_authored`; a future AI
   * endpoint passes `ai_draft` with an authenticated acceptor. No client may
   * submit it, because it is one half of the proof that a person answered.
   */
  contentOrigin: z.enum(CONNECT_CONTENT_ORIGINS).default('human_authored'),
  /** The authenticated user who accepted an AI draft. Server-resolved. */
  acceptedByUserId: z.string().uuid().nullish(),
  actor: z.object({
    userId: z.string().uuid(),
    tenantId: z.string().uuid(),
    organizationId: z.string().uuid(),
    features: z.array(z.string()),
  }),
})

/**
 * `z.input`, not `z.infer`: `contentOrigin` carries a server-side default, and
 * inferring the OUTPUT type would make it required on every existing caller —
 * a signature break for a field no caller is allowed to choose anyway.
 */
export type EnqueueOutboundInput = z.input<typeof enqueueSchema>

export type EnqueueOutboundResult =
  | {
      status: 'queued'
      messageId: string
      attemptId: string
      duplicate: boolean
      maskedRecipientLabel: string | null
      updatedAt: string
    }
  | { status: 'not_found' }
  | { status: 'forbidden'; reason: 'not_owner' }
  | { status: 'case_closed' }
  | { status: 'conversation_mismatch' }
  | { status: 'fingerprint_mismatch' }
  | { status: 'reply_target_unavailable'; reason: string }
  | { status: 'reply_target_transient' }

export const CONNECT_ENQUEUE_OUTBOUND_COMMAND_ID = 'connect.outbound.enqueue'

type ContainerLike = { resolve: <T = unknown>(name: string) => T }

type ReplyResolverLike = {
  resolveReplyTarget: (
    container: ContainerLike,
    input: {
      tenantId: string
      organizationId: string
      channelId: string
      conversationId: string
      replyTargetRef: string
      sourceVersion: number
    },
  ) => Promise<{ status: string; kind?: string; maskedLabel?: string }>
}

export function computePayloadFingerprint(body: string): string {
  return createHash('sha256').update(body).digest('hex')
}

export async function enqueueOutbound(
  container: ContainerLike,
  rawInput: EnqueueOutboundInput,
  now: Date = new Date(),
): Promise<EnqueueOutboundResult> {
  const input = enqueueSchema.parse(rawInput)
  const actor: CaseActor = input.actor
  const fingerprint = computePayloadFingerprint(input.body)
  const rootEm = (container.resolve('em') as EntityManager).fork()

  return rootEm.transactional(async (tem) => {
    const em = tem as EntityManager

    // Lock the Case, then the conversation: the same order ingest uses, so a
    // reply and an inbound for the same Case cannot deadlock each other.
    const target = await em.findOne(
      ConnectCase,
      {
        id: input.caseId,
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!target) return { status: 'not_found' }

    const access = evaluateCaseAccess(target, actor)
    if (!access.canRead) return { status: 'not_found' }
    if (!access.canAct) return { status: 'forbidden', reason: 'not_owner' }
    // `closed` is terminal. Replying to a closed Case would produce a message
    // with nowhere to belong, since a later inbound opens a successor.
    if (target.status === 'closed') return { status: 'case_closed' }

    const conversation = await em.findOne(
      ConnectConversation,
      {
        id: input.conversationId,
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    // The conversation must currently belong to THIS Case. Without the check, a
    // stale browser tab could reply into a conversation that has since moved to
    // a successor Case — sending the customer an answer to a different thread.
    if (!conversation || conversation.currentCaseId !== target.id) {
      return { status: 'conversation_mismatch' }
    }

    // Idempotency: the same key returns the original message and enqueues
    // nothing.
    const existing = await em.findOne(ConnectOutboundMessage, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      caseId: target.id,
      clientCommandKey: input.clientCommandKey,
    })
    if (existing) {
      // A changed body under the same key is a different message, not a retry.
      if (existing.payloadFingerprint !== fingerprint) return { status: 'fingerprint_mismatch' }
      const firstAttempt = await em.findOne(
        ConnectOutboundAttempt,
        { tenantId: actor.tenantId, messageId: existing.id },
        { orderBy: { attemptNumber: 'asc' } },
      )
      return {
        status: 'queued',
        messageId: existing.id,
        attemptId: firstAttempt?.id ?? '',
        duplicate: true,
        maskedRecipientLabel: existing.maskedRecipientLabel ?? null,
        updatedAt: existing.updatedAt.toISOString(),
      }
    }

    if (!conversation.replyTargetRef) {
      return { status: 'reply_target_unavailable', reason: 'no_reply_target' }
    }

    // Resolve the destination server-side BEFORE anything is written. A
    // stale, ambiguous or unavailable target must fail here, with nothing
    // queued — not later, where it would look like a delivery failure.
    const resolver = container.resolve<ReplyResolverLike>('communicationChannelsInboundEnvelopeReader')
    const resolved = await resolver.resolveReplyTarget(container, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      channelId: conversation.channelId,
      conversationId: conversation.externalConversationId,
      replyTargetRef: conversation.replyTargetRef,
      sourceVersion: conversation.replyTargetSourceVersion ?? INBOUND_REPLY_REF_SOURCE_VERSION,
    })
    if (resolved.status === 'transient_error') {
      // Retryable: the source could not answer right now, which is not the
      // same as "there is nobody to reply to".
      return { status: 'reply_target_transient' }
    }
    if (resolved.status !== 'resolved') {
      return { status: 'reply_target_unavailable', reason: resolved.status }
    }

    // Classification is a SOFT dependency: an unprovisioned sidecar or an Auth
    // facade that is down must degrade the evidence to `unknown`, never refuse
    // to deliver an agent's reply to a customer.
    const acceptedByUserId = input.acceptedByUserId ?? null
    const kinds = await resolvePrincipalKindsSoftly(container, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      userIds: acceptedByUserId ? [actor.userId, acceptedByUserId] : [actor.userId],
    })
    const authorPrincipalKind = kinds.get(actor.userId) ?? null
    const acceptedByPrincipalKind = acceptedByUserId ? kinds.get(acceptedByUserId) ?? null : null
    const responseEvidence = computeResponseEvidence({
      contentOrigin: input.contentOrigin,
      authorPrincipalKind,
      acceptedByUserId,
      acceptedByPrincipalKind,
    })

    const message = em.create(ConnectOutboundMessage, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      caseId: target.id,
      conversationId: conversation.id,
      clientCommandKey: input.clientCommandKey,
      payload: input.body,
      payloadFingerprint: fingerprint,
      replyTargetRef: conversation.replyTargetRef,
      // Only the MASKED label is persisted for display. The real recipient is
      // re-resolved at dispatch, so no address is stored in Connect at all.
      maskedRecipientLabel: resolved.maskedLabel ?? conversation.replyTargetMaskedLabel ?? null,
      actorUserId: actor.userId,
      channelId: conversation.channelId,
      // Read while the Case is LOCKED. A reopen racing this enqueue would
      // otherwise let a reply be credited to a round it was never part of.
      caseGeneration: target.slaGeneration,
      contentOrigin: input.contentOrigin,
      authorPrincipalKind,
      acceptedByUserId,
      acceptedByPrincipalKind,
      responseEvidence,
      responseEvidenceVersion: CONNECT_RESPONSE_EVIDENCE_VERSION,
    })
    em.persist(message)
    await em.flush()

    const attempt = em.create(ConnectOutboundAttempt, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      messageId: message.id,
      caseId: target.id,
      predecessorAttemptId: null,
      attemptNumber: 1,
      // Generated BEFORE enqueue so Contract A can bind it immutably; an
      // outcome carrying a different correlation cannot be applied here.
      hubCorrelationId: randomUUID(),
      status: 'queued',
    })
    em.persist(attempt)

    em.persist(
      em.create(ConnectOutbox, {
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
        attemptId: attempt.id,
        payloadFingerprint: fingerprint,
        status: 'pending',
      }),
    )

    stageDomainEvent(em, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      sourceEventId: `connect.outbound.attempted:${attempt.id}`,
      aggregateId: attempt.id,
      aggregateVersion: 1,
      eventType: 'connect.outbound.attempted',
      payload: {
        caseId: target.id,
        messageId: message.id,
        attemptId: attempt.id,
        attemptNumber: 1,
        // Immutable denominator bucket. Outcome counts are reported as
        // "attempts enqueued on DATE", never by the day a provider answered.
        enqueueCohortUtcDate: now.toISOString().slice(0, 10),
        occurredAt: now.toISOString(),
      },
    })

    await em.flush()
    logger.debug('outbound reply queued', { caseId: target.id, attemptId: attempt.id })

    return {
      status: 'queued',
      messageId: message.id,
      attemptId: attempt.id,
      duplicate: false,
      maskedRecipientLabel: message.maskedRecipientLabel ?? null,
      updatedAt: message.updatedAt.toISOString(),
    }
  })
}

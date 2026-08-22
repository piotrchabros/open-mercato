import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  ConnectConversation,
  ConnectOutbox,
  ConnectOutboundAttempt,
  ConnectOutboundMessage,
} from '../data/entities'
import { CONNECT_QUEUES } from '../lib/queue'
import { INBOUND_REPLY_REF_SOURCE_VERSION } from '../lib/reply-target'

const logger = createLogger('connect').child({ component: 'dispatch-outbox' })

/**
 * Submit durable outbound rows to the hub's send facade.
 *
 * **Connect never calls a provider.** It hands one logical attempt to
 * `communicationChannelsSendAsUser` with a precomputed correlation, and the
 * hub's existing delivery worker owns the provider call and the outcome event.
 * Keeping the provider on one side of that line is what makes "did it send?"
 * answerable at all.
 *
 * The most important rule here is what happens when submission is ambiguous:
 * an attempt that may have crossed the hub boundary becomes `unknown` and is
 * NEVER resubmitted. A lease expiry is not evidence that nothing was sent.
 */
export const metadata: WorkerMeta = {
  queue: CONNECT_QUEUES.outboundDispatch,
  id: 'connect:dispatch-outbox',
  concurrency: 4,
}

export const CONNECT_DISPATCH_BATCH_SIZE = 25
export const CONNECT_DISPATCH_LEASE_MS = 5 * 60 * 1000

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

type SendAsUserLike = (
  container: unknown,
  actor: { userId: string; tenantId: string; organizationId: string | null },
  input: Record<string, unknown>,
) => Promise<{ ok: boolean; status?: number; code?: string; error?: string }>

type ReplyResolverLike = {
  resolveReplyTarget: (
    container: unknown,
    input: Record<string, unknown>,
  ) => Promise<{ status: string; canonicalRecipientInternal?: string }>
}

const INDETERMINATE_PATTERNS = [/timed?\s?out/i, /etimedout/i, /econnreset/i, /socket hang ?up/i, /aborted/i]

function isIndeterminate(message: string): boolean {
  return INDETERMINATE_PATTERNS.some((pattern) => pattern.test(message))
}

export default async function handle(
  _job: QueuedJob<Record<string, unknown>>,
  ctx: HandlerContext,
): Promise<void> {
  const em = (ctx.resolve<EntityManager>('em')).fork()
  const now = new Date()
  const leaseExpiresAt = new Date(now.getTime() + CONNECT_DISPATCH_LEASE_MS)

  // One conditional UPDATE claims the batch, so the after-commit wake job and
  // the scheduled sweep cannot dispatch the same attempt twice.
  const claimed = (await em.execute(
    `update "connect_outbox"
        set "lease_expires_at" = ?, "attempts" = "attempts" + 1, "updated_at" = ?
      where "id" in (
        select "id" from "connect_outbox"
         where "status" = 'pending'
           and ("lease_expires_at" is null or "lease_expires_at" < ?)
         order by "created_at" asc
         limit ?
         for update skip locked
      )
      returning "id", "tenant_id", "attempt_id"`,
    [leaseExpiresAt, now, now, CONNECT_DISPATCH_BATCH_SIZE],
  )) as Array<{ id: string; tenant_id: string; attempt_id: string }>

  for (const row of claimed) {
    await dispatchOne(ctx, em, row.id, row.tenant_id, row.attempt_id, now)
  }
}

async function dispatchOne(
  ctx: HandlerContext,
  em: EntityManager,
  outboxId: string,
  tenantId: string,
  attemptId: string,
  now: Date,
): Promise<void> {
  const attempt = await em.findOne(ConnectOutboundAttempt, { id: attemptId, tenantId })
  if (!attempt) return

  // Only a queued attempt may be dispatched. Anything else — already sending,
  // already settled, or unknown — must not be resubmitted, because we cannot
  // prove the hub did not already accept it.
  if (attempt.status !== 'queued') {
    await settleOutbox(em, outboxId, 'dispatched', now)
    return
  }

  const message = await em.findOne(ConnectOutboundMessage, { id: attempt.messageId, tenantId })
  const conversation = message
    ? await em.findOne(ConnectConversation, { id: message.conversationId, tenantId })
    : null
  if (!message || !conversation) {
    attempt.status = 'failed'
    attempt.errorReason = 'missing_message_context'
    attempt.settledAt = now
    await em.flush()
    await settleOutbox(em, outboxId, 'abandoned', now)
    return
  }

  // Re-resolve the destination at dispatch. The reference may have gone stale
  // since enqueue — a later inbound can change the reply target — and sending
  // to a superseded address is worse than not sending.
  const resolver = ctx.resolve<ReplyResolverLike>('communicationChannelsInboundEnvelopeReader')
  const resolved = await resolver.resolveReplyTarget(ctx, {
    tenantId,
    organizationId: attempt.organizationId,
    channelId: message.channelId,
    conversationId: conversation.externalConversationId,
    replyTargetRef: message.replyTargetRef,
    sourceVersion: conversation.replyTargetSourceVersion ?? INBOUND_REPLY_REF_SOURCE_VERSION,
  })
  if (resolved.status === 'transient_error') {
    // Keep it queued: the source could not answer, which is not evidence about
    // the message. Release the lease so a later pass retries.
    await releaseOutboxLease(em, outboxId, now)
    return
  }
  if (resolved.status !== 'resolved' || !resolved.canonicalRecipientInternal) {
    // Definitive, and BEFORE any provider call — so `failed`, never `unknown`.
    attempt.status = 'failed'
    attempt.errorReason = `reply_target_${resolved.status}`
    attempt.settledAt = now
    await em.flush()
    await settleOutbox(em, outboxId, 'abandoned', now)
    return
  }

  attempt.status = 'sending'
  attempt.dispatchedAt = now
  await em.flush()

  const sendAsUser = ctx.resolve<SendAsUserLike>('communicationChannelsSendAsUser')
  try {
    const result = await sendAsUser(
      ctx,
      { userId: message.actorUserId, tenantId, organizationId: attempt.organizationId },
      {
        userChannelId: message.channelId,
        to: [resolved.canonicalRecipientInternal],
        subject: 're',
        body: { plain: message.payload },
        correlation: {
          correlationId: attempt.hubCorrelationId,
          attemptId: attempt.id,
        },
      },
    )
    if (!result.ok) {
      // The hub refused before dispatch (authorization, disabled channel,
      // correlation conflict). Definitive, so `failed`.
      attempt.status = 'failed'
      attempt.errorReason = result.code ?? result.error ?? 'hub_rejected'
      attempt.settledAt = now
      await em.flush()
      await settleOutbox(em, outboxId, 'abandoned', now)
      return
    }
    // Accepted. The attempt stays `sending` until Contract A's outcome event
    // settles it — the hub, not Connect, knows what the provider did.
    await settleOutbox(em, outboxId, 'dispatched', now)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (isIndeterminate(reason)) {
      // The submission may have crossed the boundary. This is precisely the
      // case that must never be resubmitted.
      attempt.status = 'unknown'
      attempt.errorReason = 'indeterminate_submission'
      await em.flush()
      await settleOutbox(em, outboxId, 'abandoned', now)
      logger.warn('outbound submission indeterminate; left for reconciliation', { attemptId })
      return
    }
    attempt.status = 'failed'
    attempt.errorReason = reason.slice(0, 500)
    attempt.settledAt = now
    await em.flush()
    await settleOutbox(em, outboxId, 'abandoned', now)
  }
}

async function settleOutbox(
  em: EntityManager,
  outboxId: string,
  status: 'dispatched' | 'abandoned',
  now: Date,
): Promise<void> {
  const row = await em.findOne(ConnectOutbox, { id: outboxId })
  if (!row) return
  row.status = status
  row.dispatchedAt = now
  row.leaseExpiresAt = null
  await em.flush()
}

async function releaseOutboxLease(em: EntityManager, outboxId: string, now: Date): Promise<void> {
  const row = await em.findOne(ConnectOutbox, { id: outboxId })
  if (!row) return
  row.leaseExpiresAt = null
  row.updatedAt = now
  await em.flush()
}

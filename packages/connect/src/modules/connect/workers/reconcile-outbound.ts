import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ConnectOutboundAttempt, ConnectUnknownDelivery } from '../data/entities'
import { CONNECT_QUEUES } from '../lib/queue'
import { applyDeliveryOutcome } from '../lib/delivery-outcome-apply'

const logger = createLogger('connect').child({ component: 'reconcile-outbound' })

/**
 * Re-check attempts whose outcome is still unknown.
 *
 * It asks the hub's READ-ONLY status lookup — the one facade that can answer
 * "did my send happen?" without sending. It never resubmits: an `unknown`
 * attempt may already be in the customer's mailbox, and the entire point of the
 * state is that we refuse to guess.
 *
 * An attempt the provider cannot corroborate stays unknown and stays in the
 * recovery queue for a human. That is the honest answer, and it is better than
 * inventing a terminal state.
 */
export const metadata: WorkerMeta = {
  queue: CONNECT_QUEUES.outboundReconcile,
  id: 'connect:reconcile-outbound',
  concurrency: 1,
}

export const CONNECT_RECONCILE_BATCH_SIZE = 50

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

type StatusLookupLike = (
  container: unknown,
  actor: { userId: string; tenantId: string; organizationId: string | null; features: string[] },
  input: { channelId: string; correlationId: string; attemptId: string },
) => Promise<{
  status: string
  deliveryRevision?: number
  providerMessageId?: string | null
  reasonCode?: string | null
  providerEvidence?: string
}>

export default async function handle(
  _job: QueuedJob<Record<string, unknown>>,
  ctx: HandlerContext,
): Promise<void> {
  const em = (ctx.resolve<EntityManager>('em')).fork()
  const now = new Date()

  const open = await em.find(
    ConnectUnknownDelivery,
    { acknowledgedAt: null },
    { orderBy: { createdAt: 'asc' }, limit: CONNECT_RECONCILE_BATCH_SIZE },
  )
  if (open.length === 0) return

  let lookup: StatusLookupLike | null = null
  try {
    lookup = ctx.resolve<StatusLookupLike>('communicationChannelsSendStatusLookup')
  } catch {
    logger.warn('send status lookup unavailable; unknown deliveries stay open')
    return
  }

  for (const exception of open) {
    const attempt = await em.findOne(ConnectOutboundAttempt, {
      id: exception.attemptId,
      tenantId: exception.tenantId,
    })
    if (!attempt || attempt.status !== 'unknown') {
      // Settled by the outcome event in the meantime — close the exception out.
      exception.acknowledgedAt = now
      exception.acknowledgeReason = 'resolved_by_outcome'
      continue
    }

    const result = await lookup(
      ctx,
      {
        // A trusted service principal: the reconciler acts for the system, not
        // for the agent who originally sent, whose access may have changed.
        userId: attempt.messageId,
        tenantId: attempt.tenantId,
        organizationId: attempt.organizationId,
        features: ['communication_channels.*'],
      },
      {
        channelId: exception.channelId,
        correlationId: attempt.hubCorrelationId,
        attemptId: attempt.id,
      },
    ).catch(() => null)

    exception.lastCheckedAt = now
    if (!result) continue
    exception.lookupSupported = result.providerEvidence === 'supported'

    if (result.status === 'sent' || result.status === 'failed') {
      await applyDeliveryOutcome(
        em,
        {
          tenantId: attempt.tenantId,
          organizationId: attempt.organizationId,
          channelId: exception.channelId,
          correlationId: attempt.hubCorrelationId,
          attemptId: attempt.id,
          // Ahead of whatever the attempt already stored, so the terminal answer
          // is not discarded as stale.
          deliveryRevision: (result.deliveryRevision ?? attempt.deliveryRevision) + 1,
          providerMessageId: result.providerMessageId ?? undefined,
          status: result.status,
          reasonCode: result.reasonCode ?? undefined,
          occurredAt: now.toISOString(),
        },
        now,
      )
      exception.acknowledgedAt = now
      exception.acknowledgeReason = `reconciled_${result.status}`
    }
    // Still inconclusive: leave it open. Escalation is the operator's queue,
    // not an invented outcome.
  }

  await em.flush()
}

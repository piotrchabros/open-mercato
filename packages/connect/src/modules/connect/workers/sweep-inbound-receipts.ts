import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ConnectInboundReceipt } from '../data/entities'
import { CONNECT_QUEUES } from '../lib/queue'
import { completeReceipt } from '../lib/receipt-claim'
import { stageDomainEvent } from '../lib/domain-outbox'

const logger = createLogger('connect').child({ component: 'sweep-inbound-receipts' })

/**
 * Recover inbound receipts stranded in `processing`.
 *
 * A receipt is claimed before the work it describes, so a crash mid-ingest
 * leaves one behind with an expired lease. Without this sweep that message is
 * never processed AND never redelivered — the claim already told the bus we had
 * it. The sweep is therefore not an optimization; it is the other half of the
 * claim-before-work design.
 *
 * Exhausted receipts are dead-lettered rather than retried forever, so a
 * permanently unprocessable message becomes visible to an operator (who can
 * replay or acknowledge it through the receipts API) instead of consuming the
 * queue indefinitely.
 */
export const metadata: WorkerMeta = {
  queue: CONNECT_QUEUES.inboundReceipts,
  id: 'connect:sweep-inbound-receipts',
  concurrency: 1,
}

export const CONNECT_RECEIPT_MAX_ATTEMPTS = 5
export const CONNECT_RECEIPT_SWEEP_BATCH = 50

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(
  _job: QueuedJob<Record<string, unknown>>,
  ctx: HandlerContext,
): Promise<void> {
  const em = (ctx.resolve<EntityManager>('em')).fork()
  const now = new Date()

  const stranded = await em.find(
    ConnectInboundReceipt,
    {
      status: 'processing',
      leaseExpiresAt: { $lt: now },
    },
    { orderBy: { createdAt: 'asc' }, limit: CONNECT_RECEIPT_SWEEP_BATCH },
  )
  if (stranded.length === 0) return

  for (const receipt of stranded) {
    if (receipt.attempts >= CONNECT_RECEIPT_MAX_ATTEMPTS) {
      // Terminal, but evidence is preserved: the operator decides whether to
      // replay it or acknowledge it, and neither deletes the row.
      completeReceipt(receipt, { disposition: 'dead_lettered', terminalReason: 'attempts_exhausted' }, now)
      // Announce the terminal disposition on the receipt's ORIGINAL claim
      // cohort. Without this the reconciliation equation for that day is short
      // by one and looks like an unexplained gap rather than a dead letter.
      stageDomainEvent(em, {
        tenantId: receipt.tenantId,
        organizationId: receipt.organizationId,
        sourceEventId: `connect.inbound.disposed:${receipt.id}`,
        aggregateId: receipt.id,
        aggregateVersion: receipt.attempts,
        eventType: 'connect.inbound.disposed',
        payload: {
          receiptId: receipt.id,
          channelId: receipt.channelId,
          disposition: 'dead_lettered',
          reason: 'attempts_exhausted',
          claimCohortUtcDate: receipt.claimCohortUtcDate,
          occurredAt: now.toISOString(),
        },
      })
      logger.error('inbound receipt dead-lettered after exhausting attempts', {
        receiptId: receipt.id,
        attempts: receipt.attempts,
      })
      continue
    }
    // Release the lease so the next delivery or replay can reclaim it. The
    // attempt counter is bumped by the claim itself, not here, so a sweep pass
    // cannot exhaust a receipt it never actually retried.
    receipt.leaseExpiresAt = null
  }
  await em.flush()
}

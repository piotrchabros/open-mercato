import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { claimOutboxBatch, markOutboxPublished } from '../lib/domain-outbox'
import { CONNECT_QUEUES } from '../lib/queue'
import { emitConnectEvent, type ConnectEventId } from '../events'

const logger = createLogger('connect').child({ component: 'publish-domain-outbox' })

/**
 * Drain the transactional domain outbox.
 *
 * Runs from two triggers on purpose: a best-effort wake job enqueued after
 * commit (low latency in the happy path) and a scheduled sweep (correctness
 * when the wake job was never enqueued because the process died). Either alone
 * is insufficient — the wake job can be lost, and a sweep-only design makes
 * every event wait for the next tick.
 *
 * Publication is at-least-once. Each entry carries a stable `sourceEventId`, so
 * a subscriber that sees the same event twice can deduplicate; marking published
 * AFTER a successful emit means a crash in between re-publishes rather than
 * silently drops.
 */
export const metadata: WorkerMeta = {
  queue: CONNECT_QUEUES.domainOutbox,
  id: 'connect:publish-domain-outbox',
  concurrency: 2,
}

export const CONNECT_OUTBOX_BATCH_SIZE = 100

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(
  _job: QueuedJob<Record<string, unknown>>,
  ctx: HandlerContext,
): Promise<void> {
  const em = (ctx.resolve<EntityManager>('em')).fork()
  const batch = await claimOutboxBatch(em, CONNECT_OUTBOX_BATCH_SIZE)
  if (batch.length === 0) return

  for (const entry of batch) {
    try {
      await emitConnectEvent(
        entry.eventType as ConnectEventId,
        { ...entry.payload, tenantId: entry.tenantId, organizationId: entry.organizationId },
        { persistent: true },
      )
      await markOutboxPublished(em, entry.id)
    } catch (err) {
      // Leave it pending and leased. The lease expires and a later run retries;
      // failing the whole job would re-claim entries that already published.
      logger.warn('outbox entry publish failed; leaving it for retry', {
        entryId: entry.id,
        eventType: entry.eventType,
        err,
      })
    }
  }
}

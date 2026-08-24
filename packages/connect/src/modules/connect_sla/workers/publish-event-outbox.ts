import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { emitConnectSlaEvent, type ConnectSlaEventId } from '../events'
import { CONNECT_SLA_QUEUES } from '../lib/async'
import { claimClockEventBatch, markClockEventPublished } from '../lib/event-outbox'

const logger = createLogger('connect_sla').child({ component: 'publish-event-outbox' })
export const metadata: WorkerMeta = { queue: CONNECT_SLA_QUEUES.eventOutbox, id: 'connect_sla:publish-event-outbox', concurrency: 2 }

export default async function handle(_job: QueuedJob<unknown>, context: JobContext & { resolve: <T>(name: string) => T }): Promise<void> {
  const em = context.resolve<EntityManager>('em').fork()
  for (const row of await claimClockEventBatch(em, 100)) {
    try {
      await emitConnectSlaEvent(row.event_type as ConnectSlaEventId, row.payload, { persistent: true })
      await markClockEventPublished(em, row.id)
    } catch (error) {
      logger.warn('SLA event outbox publish failed; lease expiry will retry it', { entryId: row.id, error })
    }
  }
}

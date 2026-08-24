import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { CONNECT_SLA_QUEUES, deadlineSweepPayloadSchema, type SlaScope } from '../lib/async'
export const metadata: WorkerMeta = { queue: CONNECT_SLA_QUEUES.deadlineSweep, id: 'connect_sla:deadline-sweep', concurrency: 1 }
type Service = { sweep: (scope: SlaScope, now: Date) => Promise<number> }
export default async function handle(job: QueuedJob<unknown>, context: JobContext & { resolve: <T>(name: string) => T }): Promise<void> {
  const payload = deadlineSweepPayloadSchema.parse(job?.payload ?? {})
  const service = context.resolve<Service>('connectSlaDeadlineSweepService')
  await service.sweep({ tenantId: payload.tenantId, organizationId: payload.organizationId }, payload.now ? new Date(payload.now) : new Date())
}

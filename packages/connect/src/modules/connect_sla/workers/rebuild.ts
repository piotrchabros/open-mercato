import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { CONNECT_SLA_QUEUES, rebuildPayloadSchema, type SlaScope } from '../lib/async'
export const metadata: WorkerMeta = { queue: CONNECT_SLA_QUEUES.rebuild, id: 'connect_sla:rebuild', concurrency: 1 }
type Service = { rebuild: (scope: SlaScope, runId: string, pageSize: number) => Promise<unknown> }
export default async function handle(job: QueuedJob<unknown>, context: JobContext & { resolve: <T>(name: string) => T }): Promise<void> {
  const payload = rebuildPayloadSchema.parse(job?.payload ?? {})
  const service = context.resolve<Service>('connectSlaRebuildService')
  await service.rebuild({ tenantId: payload.tenantId, organizationId: payload.organizationId }, payload.runId, payload.pageSize)
}

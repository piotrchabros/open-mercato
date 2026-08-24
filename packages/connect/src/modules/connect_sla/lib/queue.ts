import { createModuleQueue, type Queue } from '@open-mercato/queue'
import { CONNECT_SLA_QUEUES } from './async'

type RebuildJob = {
  tenantId: string
  organizationId: string
  runId: string
  pageSize: number
}

let rebuildQueue: Queue<RebuildJob> | null = null

export function getConnectSlaRebuildQueue(): Queue<RebuildJob> {
  rebuildQueue ??= createModuleQueue<RebuildJob>(CONNECT_SLA_QUEUES.rebuild, { concurrency: 1 })
  return rebuildQueue
}

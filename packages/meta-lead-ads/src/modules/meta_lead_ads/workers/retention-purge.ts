import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { QUEUES, WORKER_IDS } from '../lib/constants'
import { purgeLeadEventPayloads } from '../lib/purge'
import { resolveJobScope, type ScopedJob } from '../lib/queue'
import { getOrgSettings } from '../lib/settings'

const logger = createLogger('meta_lead_ads').child({ component: 'retention-purge' })

const DAY_MS = 24 * 60 * 60 * 1000

export const metadata: WorkerMeta = {
  queue: QUEUES.retentionPurge,
  id: WORKER_IDS.retentionPurge,
  concurrency: 1,
}

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(job: QueuedJob<ScopedJob>, ctx: HandlerContext): Promise<void> {
  const scope = resolveJobScope(job?.payload ?? {})
  if (!scope) return

  const em = (ctx.resolve('em') as EntityManager).fork()
  const { retentionDays } = await getOrgSettings(em, scope)
  const cutoff = new Date(Date.now() - retentionDays * DAY_MS)
  const purged = await purgeLeadEventPayloads(
    em,
    {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      createdAt: { $lt: cutoff },
      payloadPurgedAt: null,
    },
    { clearHashes: false },
  )
  logger.info('retention purge finished', { purged })
}

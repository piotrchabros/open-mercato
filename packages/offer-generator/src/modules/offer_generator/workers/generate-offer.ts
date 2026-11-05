import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import type { GenerateOfferJob } from '../data/validators'
import { QUEUES, WORKER_IDS } from '../lib/constants'
import { executeGenerationRun } from '../lib/generation'

export const metadata: WorkerMeta = {
  queue: QUEUES.generate,
  id: WORKER_IDS.generate,
  concurrency: 2,
}

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

export default async function handle(job: QueuedJob<GenerateOfferJob>, ctx: HandlerContext): Promise<void> {
  const payload = job.payload
  if (!payload?.runId || !payload.tenantId || !payload.organizationId) return
  await executeGenerationRun({ resolve: ctx.resolve }, payload)
}

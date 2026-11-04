import { createModuleQueue, type Queue } from '@open-mercato/queue'
import { QUEUES, type MetaScope } from './constants'

export type ProcessLeadJob = {
  leadEventId: string
  tenantId: string | null
  organizationId: string | null
}

export type BackfillJob = {
  runId: string
  formId: string
  from: string
  to: string
  after?: string | null
  tenantId: string
  organizationId: string
  progressJobId: string | null
}

export type ScopedJob = {
  scope?: MetaScope
  tenantId?: string | null
  organizationId?: string | null
}

export type ScopeJob = { scope: MetaScope }

export function resolveJobScope(payload: ScopedJob): MetaScope | null {
  if (payload.scope?.tenantId && payload.scope.organizationId) return payload.scope
  if (payload.tenantId && payload.organizationId) {
    return { tenantId: payload.tenantId, organizationId: payload.organizationId }
  }
  return null
}

function coalesceByOrganization(payload: ScopedJob): string | null {
  const scope = resolveJobScope(payload)
  return scope ? `organization:${scope.organizationId}` : null
}

function lazyQueue<T>(factory: () => Queue<T>): () => Queue<T> {
  let instance: Queue<T> | null = null
  return () => {
    if (!instance) instance = factory()
    return instance
  }
}

export const getProcessQueue = lazyQueue(() =>
  createModuleQueue<ProcessLeadJob>(QUEUES.process, { attempts: 1, concurrency: 5 }),
)

export const getBackfillQueue = lazyQueue(() =>
  createModuleQueue<BackfillJob>(QUEUES.backfill, { attempts: 1, concurrency: 1 }),
)

export const getReconcileQueue = lazyQueue(() =>
  createModuleQueue<ScopeJob>(QUEUES.reconcile, {
    attempts: 1,
    concurrency: 1,
    coalesceBy: coalesceByOrganization,
  }),
)

export const getTokenHealthQueue = lazyQueue(() =>
  createModuleQueue<ScopeJob>(QUEUES.tokenHealth, {
    attempts: 1,
    concurrency: 2,
    coalesceBy: coalesceByOrganization,
  }),
)

export const getRetentionPurgeQueue = lazyQueue(() =>
  createModuleQueue<ScopeJob>(QUEUES.retentionPurge, {
    attempts: 1,
    concurrency: 1,
    coalesceBy: coalesceByOrganization,
  }),
)

export type EnqueueOptions = { delayMs?: number }

export function enqueueProcessLead(job: ProcessLeadJob, opts?: EnqueueOptions): Promise<string> {
  return getProcessQueue().enqueue(job, opts)
}

export function enqueueBackfill(job: BackfillJob, opts?: EnqueueOptions): Promise<string> {
  return getBackfillQueue().enqueue(job, opts)
}

export function enqueueReconcile(scope: MetaScope): Promise<string> {
  return getReconcileQueue().enqueue({ scope })
}

export function enqueueTokenHealth(scope: MetaScope): Promise<string> {
  return getTokenHealthQueue().enqueue({ scope })
}

export function enqueueRetentionPurge(scope: MetaScope): Promise<string> {
  return getRetentionPurgeQueue().enqueue({ scope })
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ConnectMetricDaily } from '../../../data/entities'
import { enumerateDays } from '../../../lib/metrics-aggregate'
import { CONNECT_QUEUES } from '../../../lib/queue'
import { resolveInboxContext } from '../../../lib/inbox-route-context'

const logger = createLogger('connect').child({ component: 'metrics-rebuild' })

/**
 * Recompute aggregates for a bounded range.
 *
 * Returns 202 and an operation id rather than doing the work inline: a
 * three-month rebuild is not a request-scoped amount of computation, and an
 * operator wants to navigate away from it.
 *
 * Two properties make this safe to press twice:
 *
 *   - Aggregation is a pure function of immutable facts, so a rerun cannot
 *     double-count.
 *   - The affected days are marked STALE rather than deleted, so the screen
 *     keeps showing last-good numbers with a warning instead of blanking to
 *     "not aggregated" — which would read as data loss.
 *
 * The job is scoped to the caller's own organization by the server. There is no
 * request shape that can rebuild a sibling organization's aggregates.
 */

export const metadata = {
  path: '/connect/metrics/rebuild',
  POST: {
    requireAuth: true,
    requireFeatures: ['connect.metrics.manage'],
  },
}

export const CONNECT_METRICS_MAX_REBUILD_DAYS = 92

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const bodySchema = z.object({
  from: DATE,
  to: DATE,
})

type ProgressServiceLike = {
  createJob: (
    input: Record<string, unknown>,
    ctx: { tenantId: string; organizationId?: string | null; userId?: string | null },
  ) => Promise<{ id: string }>
}

type QueueLike = { enqueue: (payload: Record<string, unknown>) => Promise<unknown> }
type QueueFactoryLike = { getQueue?: (name: string) => QueueLike | undefined }

export async function POST(req: Request): Promise<Response> {
  const resolved = await resolveInboxContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await readJsonSafe(req, null))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      { status: 422 },
    )
  }

  const days = enumerateDays(body.from, body.to)
  if (days.length === 0) {
    return NextResponse.json({ error: 'The range starts after it ends.' }, { status: 422 })
  }
  if (days.length > CONNECT_METRICS_MAX_REBUILD_DAYS) {
    return NextResponse.json(
      {
        error: `Rebuilds are limited to ${CONNECT_METRICS_MAX_REBUILD_DAYS} days.`,
        code: 'range_too_large',
      },
      { status: 422 },
    )
  }

  const guard = await runRouteMutationGuards({
    container: container as never,
    req,
    auth: { userId: actor.userId, tenantId: actor.tenantId, organizationId: actor.organizationId },
    input: {
      resourceKind: 'connect.metrics',
      resourceId: actor.organizationId,
      operation: 'update',
      mutationPayload: { action: 'rebuild', from: body.from, to: body.to },
    },
  })
  if (!guard.ok) return guard.response

  // Without a queue the job would be accepted and never run, which is worse
  // than refusing it: the operator would wait for numbers that never change.
  let queue: QueueLike | undefined
  try {
    queue = (container.resolve('queueFactory') as QueueFactoryLike)?.getQueue?.(
      CONNECT_QUEUES.metricsAggregate,
    )
  } catch {
    queue = undefined
  }
  if (!queue) {
    return NextResponse.json(
      { error: 'Background processing is unavailable, so a rebuild cannot be started.', code: 'queue_unavailable' },
      { status: 503 },
    )
  }

  const em = (container.resolve('em') as EntityManager).fork()
  // Mark last-good rows stale rather than clearing them. The UI shows the old
  // numbers with a "rebuilding" flag, which is honest; an empty screen would
  // read as data loss.
  await em.nativeUpdate(
    ConnectMetricDaily,
    {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      utcDate: { $gte: body.from, $lte: body.to },
    },
    { stale: true },
  )

  let operationId: string | null = null
  try {
    const progress = container.resolve('progressService') as ProgressServiceLike
    const job = await progress.createJob(
      {
        jobType: 'connect.metrics.rebuild',
        name: 'Connect metrics rebuild',
        description: `Recomputing ${days.length} day(s) of Connect operational aggregates.`,
        totalCount: days.length,
        cancellable: true,
        meta: { from: body.from, to: body.to, organizationId: actor.organizationId },
      },
      { tenantId: actor.tenantId, organizationId: actor.organizationId, userId: actor.userId },
    )
    operationId = job.id
  } catch (err) {
    // Progress reporting is a convenience; the rebuild itself is not.
    logger.warn('progress service unavailable; rebuilding without an operation id', { err })
  }

  await queue.enqueue({
    // Server-scoped. A caller cannot name another organization.
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
    from: body.from,
    to: body.to,
    operationId,
  })

  await guard.runAfterSuccess()

  return NextResponse.json(
    { status: 'queued', operationId, from: body.from, to: body.to, days: days.length },
    { status: 202 },
  )
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    POST: {
      summary: 'Queue a rebuild of Connect metric aggregates for a date range',
      tags: ['Connect'],
      responses: [
        { status: 202, description: 'Rebuild queued' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 422, description: 'Invalid or oversized range' },
        { status: 503, description: 'Background processing is unavailable' },
      ],
    },
  },
}

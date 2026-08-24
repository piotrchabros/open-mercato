import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi/types'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { getAllMutationGuardInstances } from '@open-mercato/shared/lib/crud/mutation-guard-store'
import { bridgeLegacyGuard, runMutationGuards } from '@open-mercato/shared/lib/crud/mutation-guard-registry'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { RebuildRun } from '../../../data/entities'
import { rebuildClocksSchema, SLA_REBUILD_STATUSES } from '../../../data/validators'
import { getConnectSlaRebuildQueue } from '../../../lib/queue'
import type { RebuildRequestResult } from '../../../lib/rebuild-runs'
import { apiError, resolveClockRouteContext } from '../../clock-context'

const logger = createLogger('connect_sla').child({ component: 'clock-rebuild-route' })

export const metadata = {
  path: '/connect-sla/clocks/rebuild',
  POST: { requireAuth: true, requireFeatures: ['connect_sla.clock.rebuild'] },
}

const responseSchema = z.object({ id: z.string().uuid(), status: z.enum(SLA_REBUILD_STATUSES), progressJobId: z.string().uuid().nullable() })
const errorSchema = z.object({ error: z.string(), code: z.string() })
type ProgressService = { createJob: (input: Record<string, unknown>, scope: Record<string, unknown>) => Promise<{ id: string }> }
type Coordinator = { request: (scope: { tenantId: string; organizationId: string }, input: { commandKey: string; reason: string; progressJobId: string | null }) => Promise<RebuildRequestResult | { outcome: 'dependency_unavailable' }> }

export async function POST(req: Request): Promise<Response> {
  const resolved = await resolveClockRouteContext(req)
  if (!resolved.ok) return resolved.response
  const parsed = rebuildClocksSchema.safeParse(await readJsonSafe(req, null))
  if (!parsed.success) return apiError(400, 'invalid_rebuild_request', 'Invalid rebuild request')
  const { container, tenantId, organizationId, userId, features } = resolved.value
  const guardInput = {
    tenantId, organizationId, userId, resourceKind: 'connect_sla.case_clock', resourceId: organizationId,
    operation: 'update' as const, requestMethod: req.method, requestHeaders: req.headers,
    mutationPayload: { action: 'rebuild', ...parsed.data },
  }
  const legacy = bridgeLegacyGuard(container)
  const guardResult = await runMutationGuards([...getAllMutationGuardInstances(), ...(legacy ? [legacy] : [])], guardInput, { userFeatures: features })
  if (!guardResult.ok) return NextResponse.json(guardResult.errorBody ?? { error: 'Operation blocked' }, { status: guardResult.errorStatus ?? 422 })
  const input = rebuildClocksSchema.parse({ ...parsed.data, ...(guardResult.modifiedPayload ?? {}) })
  let queue: ReturnType<typeof getConnectSlaRebuildQueue>
  try { queue = getConnectSlaRebuildQueue() } catch { return apiError(503, 'queue_unavailable', 'Background processing is unavailable') }
  const em = (container.resolve('em') as EntityManager).fork()
  const existing = await em.findOne(RebuildRun, { tenantId, organizationId, commandKey: input.commandKey })
  if (existing) return NextResponse.json(responseSchema.parse({ id: existing.id, status: existing.status, progressJobId: existing.progressJobId }), { status: 202 })
  const overlap = await em.findOne(RebuildRun, { tenantId, organizationId, status: { $in: ['pending', 'running'] } })
  if (overlap && (overlap.status === 'pending' || !overlap.leaseExpiresAt || overlap.leaseExpiresAt > new Date())) return apiError(409, 'rebuild_overlap', 'A clock rebuild is already active')
  let progressJobId: string | null = null
  try {
    progressJobId = (await (container.resolve('progressService') as ProgressService).createJob({
      jobType: 'connect_sla.rebuild', name: 'Connect SLA clock rebuild', description: input.reason, cancellable: true,
    }, { tenantId, organizationId, userId })).id
  } catch (err) { logger.warn('Progress service unavailable; rebuilding without progress tracking', { err }) }
  const coordinator = container.resolve('connectSlaRebuildRunCoordinator') as Coordinator
  let requested: Awaited<ReturnType<Coordinator['request']>>
  try { requested = await coordinator.request({ tenantId, organizationId }, { commandKey: input.commandKey, reason: input.reason, progressJobId }) } catch { return apiError(409, 'rebuild_conflict', 'A conflicting rebuild request already exists') }
  if (requested.outcome === 'dependency_unavailable') return apiError(503, 'dependency_unavailable', 'Connect SLA source reader is unavailable')
  if (requested.outcome === 'overlap') return apiError(409, 'rebuild_overlap', 'A clock rebuild is already active')
  const run = requested.run
  if (requested.outcome === 'replay') return NextResponse.json(responseSchema.parse({ id: run.id, status: run.status, progressJobId: run.progressJobId }), { status: 202 })
  await queue.enqueue({ tenantId, organizationId, runId: run.id, pageSize: 100 })
  for (const callback of guardResult.afterSuccessCallbacks) {
    try { await callback.guard.afterSuccess?.({ ...guardInput, metadata: callback.metadata ?? null }) } catch (err) { logger.warn('Mutation guard afterSuccess callback failed', { err }) }
  }
  return NextResponse.json(responseSchema.parse({ id: run.id, status: 'pending', progressJobId }), { status: 202 })
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Connect SLA', summary: 'Queue Connect SLA clock reconciliation',
  methods: { POST: { summary: 'Queue a scoped SLA clock rebuild', tags: ['Connect SLA'], requestBody: { schema: rebuildClocksSchema }, responses: [
    { status: 202, description: 'Rebuild queued or idempotently replayed', schema: responseSchema }, { status: 400, description: 'Invalid request or scope', schema: errorSchema },
    { status: 401, description: 'Unauthorized', schema: errorSchema }, { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 409, description: 'Overlapping or conflicting rebuild', schema: errorSchema }, { status: 422, description: 'Mutation guard rejected rebuild', schema: errorSchema },
    { status: 503, description: 'Connect or queue dependency unavailable', schema: errorSchema },
  ] } },
}

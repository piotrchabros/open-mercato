import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi/types'
import { RebuildRun } from '../../../../data/entities'
import { SLA_REBUILD_STATUSES } from '../../../../data/validators'
import { apiError, resolveClockRouteContext } from '../../../clock-context'

export const metadata = {
  path: '/connect-sla/clocks/rebuild/[id]',
  GET: { requireAuth: true, requireFeatures: ['connect_sla.clock.rebuild'] },
}

const responseSchema = z.object({
  id: z.string().uuid(), commandKey: z.string(), reason: z.string(), status: z.enum(SLA_REBUILD_STATUSES), watermark: z.string().nullable(),
  generationCursor: z.string().nullable(), waitCursor: z.string().nullable(), deliveryCursor: z.string().nullable(),
  processedCount: z.number().int(), errorCount: z.number().int(), progressJobId: z.string().uuid().nullable(), internalVersion: z.number().int(), leaseExpiresAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
})
const errorSchema = z.object({ error: z.string(), code: z.string() })

export async function GET(req: Request, context: { params: Promise<{ id: string }> | { id: string } }): Promise<Response> {
  const resolved = await resolveClockRouteContext(req)
  if (!resolved.ok) return resolved.response
  const id = z.string().uuid().safeParse((await context.params).id)
  if (!id.success) return apiError(400, 'invalid_rebuild_id', 'Invalid rebuild id')
  const { container, tenantId, organizationId } = resolved.value
  const run = await (container.resolve('em') as EntityManager).fork().findOne(RebuildRun, { id: id.data, tenantId, organizationId })
  if (!run) return apiError(404, 'rebuild_not_found', 'Rebuild not found')
  return NextResponse.json(responseSchema.parse({
    id: run.id, commandKey: run.commandKey, reason: run.reason, status: run.status, watermark: run.watermark, generationCursor: run.generationCursor,
    waitCursor: run.waitCursor, deliveryCursor: run.deliveryCursor, processedCount: run.processedCount, errorCount: run.errorCount,
    progressJobId: run.progressJobId, internalVersion: run.internalVersion, leaseExpiresAt: run.leaseExpiresAt?.toISOString() ?? null, createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(),
  }))
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Connect SLA', summary: 'Read a scoped SLA rebuild run', pathParams: z.object({ id: z.string().uuid() }),
  methods: { GET: { summary: 'Read SLA rebuild progress', tags: ['Connect SLA'], responses: [
    { status: 200, description: 'Scoped rebuild state', schema: responseSchema }, { status: 400, description: 'Invalid scope or id', schema: errorSchema },
    { status: 401, description: 'Unauthorized', schema: errorSchema }, { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'Rebuild hidden or absent', schema: errorSchema }, { status: 503, description: 'Connect dependency unavailable', schema: errorSchema },
  ] } },
}

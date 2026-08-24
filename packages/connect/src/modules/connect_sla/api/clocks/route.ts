import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { z } from 'zod'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi/types'
import { CaseClock } from '../../data/entities'
import { caseClockListQuerySchema, SLA_RESOLUTION_STATES, SLA_RESPONSE_STATES } from '../../data/validators'
import { apiError, resolveClockRouteContext } from '../clock-context'

export const metadata = {
  path: '/connect-sla/clocks',
  GET: { requireAuth: true, requireFeatures: ['connect_sla.clock.view'] },
}

const cursorSchema = z.object({ createdAt: z.string().datetime({ offset: true }), id: z.string().uuid() }).strict()
const errorSchema = z.object({ error: z.string(), code: z.string() })
const clockSchema = z.object({
  id: z.string().uuid(), caseId: z.string().uuid(), generation: z.number().int(), policyVersionId: z.string().uuid(), calendarVersionId: z.string().uuid(),
  startedAt: z.string(), responseDueAt: z.string(), resolutionDueAt: z.string(), responseState: z.enum(SLA_RESPONSE_STATES), resolutionState: z.enum(SLA_RESOLUTION_STATES),
  respondedAt: z.string().nullable(), resolvedAt: z.string().nullable(), resolutionPausedSeconds: z.number().int(), waitStartedAt: z.string().nullable(), parentClockId: z.string().uuid().nullable(),
  supersededByClockId: z.string().uuid().nullable(), nextDueAt: z.string().nullable(), internalVersion: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
})
const responseSchema = z.object({ items: z.array(clockSchema), nextCursor: z.string().nullable() })

function encodeCursor(clock: CaseClock): string {
  return Buffer.from(JSON.stringify({ createdAt: clock.createdAt.toISOString(), id: clock.id }), 'utf8').toString('base64url')
}

function decodeCursor(value: string | undefined): z.infer<typeof cursorSchema> | null {
  if (!value) return null
  try { return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))) } catch { return null }
}

function serialize(clock: CaseClock) {
  const iso = (value: Date | null) => value?.toISOString() ?? null
  return {
    id: clock.id, caseId: clock.caseId, generation: clock.generation, policyVersionId: clock.policyVersionId, calendarVersionId: clock.calendarVersionId,
    startedAt: clock.startedAt.toISOString(), responseDueAt: clock.responseDueAt.toISOString(), resolutionDueAt: clock.resolutionDueAt.toISOString(), responseState: clock.responseState,
    resolutionState: clock.resolutionState, respondedAt: iso(clock.respondedAt), resolvedAt: iso(clock.resolvedAt), resolutionPausedSeconds: clock.resolutionPausedSeconds,
    waitStartedAt: iso(clock.waitStartedAt), parentClockId: clock.parentClockId, supersededByClockId: clock.supersededByClockId, nextDueAt: iso(clock.nextDueAt),
    internalVersion: clock.internalVersion, createdAt: clock.createdAt.toISOString(), updatedAt: clock.updatedAt.toISOString(),
  }
}

export async function GET(req: Request): Promise<Response> {
  const resolved = await resolveClockRouteContext(req)
  if (!resolved.ok) return resolved.response
  const query = caseClockListQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams))
  if (!query.success) return apiError(400, 'invalid_query', 'Invalid clock query')
  const cursor = decodeCursor(query.data.cursor)
  if (query.data.cursor && !cursor) return apiError(400, 'invalid_cursor', 'Invalid cursor')
  const { container, tenantId, organizationId, userId, reader } = resolved.value
  if (query.data.caseId && !(await reader.canReadCase({ tenantId, organizationId, userId }, query.data.caseId))) {
    return apiError(404, 'clock_not_found', 'Clock not found')
  }
  const em = (container.resolve('em') as EntityManager).fork()
  const visible: CaseClock[] = []
  let scanCursor = cursor
  let nextCursor: string | null = null
  const chunkSize = query.data.pageSize + 1
  while (visible.length < query.data.pageSize) {
    const candidates = await em.find(CaseClock, {
      tenantId, organizationId,
      ...(query.data.id ? { id: query.data.id } : {}),
      ...(query.data.caseId ? { caseId: query.data.caseId } : {}),
      ...(query.data.generation === undefined ? {} : { generation: query.data.generation }),
      ...(query.data.responseState ? { responseState: query.data.responseState } : {}),
      ...(query.data.resolutionState ? { resolutionState: query.data.resolutionState } : {}),
      ...(scanCursor ? { $or: [{ createdAt: { $gt: new Date(scanCursor.createdAt) } }, { createdAt: new Date(scanCursor.createdAt), id: { $gt: scanCursor.id } }] } : {}),
    }, { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], limit: chunkSize })
    if (candidates.length === 0) break
    let processed = 0
    for (const clock of candidates) {
      processed += 1
      scanCursor = { createdAt: clock.createdAt.toISOString(), id: clock.id }
      if (query.data.caseId || await reader.canReadCase({ tenantId, organizationId, userId }, clock.caseId)) visible.push(clock)
      if (visible.length === query.data.pageSize) {
        if (processed < candidates.length || candidates.length === chunkSize) nextCursor = encodeCursor(clock)
        break
      }
    }
    if (visible.length === query.data.pageSize || candidates.length < chunkSize || query.data.id) break
  }
  if (query.data.id && visible.length === 0) return apiError(404, 'clock_not_found', 'Clock not found')
  return NextResponse.json(responseSchema.parse({ items: visible.map(serialize), nextCursor }))
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Connect SLA', summary: 'Read scoped Connect SLA clocks',
  methods: { GET: { summary: 'List visible SLA clocks', tags: ['Connect SLA'], query: caseClockListQuerySchema, responses: [
    { status: 200, description: 'Visible clocks', schema: responseSchema }, { status: 400, description: 'Invalid scope, query, or cursor', schema: errorSchema },
    { status: 401, description: 'Unauthorized', schema: errorSchema }, { status: 403, description: 'Forbidden', schema: errorSchema },
    { status: 404, description: 'Clock hidden or absent', schema: errorSchema }, { status: 503, description: 'Connect dependency unavailable', schema: errorSchema },
  ] } },
}

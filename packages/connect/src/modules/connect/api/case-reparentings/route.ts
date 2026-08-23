import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectCaseReparenting } from '../../data/entities'
import { reparentingCursorSchema } from '../../data/validators'
import { resolveInboxContext } from '../../lib/inbox-route-context'
import {
  decodeReparentingCursor,
  encodeReparentingCursor,
  countReparentingItems,
} from '../../lib/reparent-audit'

/**
 * The reparenting audit list.
 *
 * Deliberately omits `reason` and the before-snapshots. This list is a
 * supervisory overview — who corrected what, when — and the reason is free text
 * that names the customer and the mistake. Reading it is the detail endpoint's
 * job, behind the same feature but as an explicit act.
 */

export const metadata = {
  path: '/connect/case-reparentings',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect.cases.reparent.audit'],
  },
}

const querySchema = z.object({
  caseId: z.string().uuid().optional(),
  cursor: z.string().max(512).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

export async function GET(req: Request): Promise<Response> {
  const resolved = await resolveInboxContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context

  let query: z.infer<typeof querySchema>
  try {
    query = querySchema.parse(Object.fromEntries(new URL(req.url).searchParams))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid query' },
      { status: 422 },
    )
  }

  let cursor: z.infer<typeof reparentingCursorSchema> | null = null
  if (query.cursor) {
    cursor = decodeReparentingCursor(query.cursor)
    if (!cursor) {
      return NextResponse.json({ error: 'Invalid cursor', code: 'invalid_cursor' }, { status: 422 })
    }
  }

  const em = (container.resolve('em') as EntityManager).fork()
  const where: Record<string, unknown> = {
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
  }
  if (query.caseId) {
    where.$or = [{ sourceCaseId: query.caseId }, { destinationCaseId: query.caseId }]
  }
  if (cursor) {
    // Keyset on `(occurredAt, id)`. An offset page would skip or repeat rows as
    // corrections continue to be made underneath a paging reader.
    const at = new Date(cursor.occurredAt)
    const keyset = [{ occurredAt: { $gt: at } }, { occurredAt: at, id: { $gt: cursor.id } }]
    where.$and = [{ $or: keyset }, ...(where.$or ? [{ $or: where.$or }] : [])]
    delete where.$or
  }

  const rows = await em.find(ConnectCaseReparenting, where, {
    orderBy: { occurredAt: 'asc', id: 'asc' },
    limit: query.pageSize + 1,
  })
  const page = rows.slice(0, query.pageSize)
  const counts = await countReparentingItems(
    em,
    { tenantId: actor.tenantId, organizationId: actor.organizationId },
    page.map((row) => row.id),
  )
  const last = page[page.length - 1]

  return NextResponse.json({
    items: page.map((row) => ({
      id: row.id,
      operation: row.operation,
      sourceCaseId: row.sourceCaseId,
      destinationCaseId: row.destinationCaseId,
      reversesReparentingId: row.reversesReparentingId ?? null,
      movedConversationCount: counts.get(row.id) ?? 0,
      occurredAt: row.occurredAt.toISOString(),
      status: row.status,
    })),
    nextCursor:
      rows.length > query.pageSize && last
        ? encodeReparentingCursor({ occurredAt: last.occurredAt.toISOString(), id: last.id })
        : null,
    pageSize: query.pageSize,
  })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    GET: {
      summary: 'List case reparenting audit entries (keyset paginated)',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Reparenting audit entries, without reasons or snapshots' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 403, description: 'Missing the reparent audit feature' },
        { status: 422, description: 'Invalid query or cursor' },
      ],
    },
  },
}

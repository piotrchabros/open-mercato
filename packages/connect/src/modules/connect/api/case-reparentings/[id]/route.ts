import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { ConnectCaseReparenting, ConnectCaseReparentingItem } from '../../../data/entities'
import { resolveInboxContext } from '../../../lib/inbox-route-context'
import { lineageInstructionFor, REPARENT_LINEAGE_VERSION } from '../../../lib/case-reparenting'

/**
 * One reparenting entry, including its decrypted reason and its moved items.
 *
 * The reason is the only free text on the row and describes both the customer
 * and the operator's mistake, so it is read with `findOneWithDecryption` under
 * the tenant/organization scope and behind the dedicated audit feature — never
 * as part of the list.
 */

export const metadata = {
  path: '/connect/case-reparentings/[id]',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect.cases.reparent.audit'],
  },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

const querySchema = z.object({
  itemCursor: z.string().uuid().optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

export async function GET(req: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid reparenting id' }, { status: 400 })
  }

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

  const em = (container.resolve('em') as EntityManager).fork()
  const row = await findOneWithDecryption<ConnectCaseReparenting>(
    em,
    ConnectCaseReparenting as never,
    { id, tenantId: actor.tenantId, organizationId: actor.organizationId },
    undefined,
    { tenantId: actor.tenantId, organizationId: actor.organizationId },
  )
  // Out of scope and absent are the same answer: a cross-organization id must
  // not be distinguishable from one that never existed.
  if (!row) return NextResponse.json({ error: 'Reparenting not found' }, { status: 404 })

  const itemWhere: Record<string, unknown> = {
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
    reparentingId: row.id,
  }
  // Keyset by conversation id — stable, unique within the entry, and already
  // indexed alongside `reparenting_id`.
  if (query.itemCursor) itemWhere.conversationId = { $gt: query.itemCursor }

  const items = await em.find(ConnectCaseReparentingItem, itemWhere, {
    orderBy: { conversationId: 'asc' },
    limit: query.pageSize + 1,
  })
  const page = items.slice(0, query.pageSize)
  const last = page[page.length - 1]

  return NextResponse.json({
    id: row.id,
    operation: row.operation,
    sourceCaseId: row.sourceCaseId,
    destinationCaseId: row.destinationCaseId,
    reversesReparentingId: row.reversesReparentingId ?? null,
    lineageInstruction: lineageInstructionFor(row.operation),
    lineageVersion: REPARENT_LINEAGE_VERSION,
    status: row.status,
    actorUserId: row.actorUserId,
    reason: row.reason,
    sourceBefore: row.sourceBefore,
    destinationBefore: row.destinationBefore ?? null,
    sourcePostUpdatedAt: row.sourcePostUpdatedAt.toISOString(),
    destinationPostUpdatedAt: row.destinationPostUpdatedAt.toISOString(),
    occurredAt: row.occurredAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    items: page.map((item) => ({
      conversationId: item.conversationId,
      fromCaseId: item.fromCaseId,
      toCaseId: item.toCaseId,
      beforeBindingId: item.beforeBindingId,
      afterBindingId: item.afterBindingId,
      lastMessageAtAtExecution: item.lastMessageAtAtExecution?.toISOString() ?? null,
    })),
    nextItemCursor: items.length > query.pageSize && last ? last.conversationId : null,
  })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    GET: {
      summary: 'Read one case reparenting entry, its reason and its moved conversations',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Reparenting entry' },
        { status: 400, description: 'No organization selected, or an invalid id' },
        { status: 401, description: 'Unauthorized' },
        { status: 403, description: 'Missing the reparent audit feature' },
        { status: 404, description: 'Reparenting not found or out of scope' },
        { status: 422, description: 'Invalid query' },
      ],
    },
  },
}

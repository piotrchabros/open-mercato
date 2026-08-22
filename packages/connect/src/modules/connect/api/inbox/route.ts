import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectCase, ConnectCaseReadState } from '../../data/entities'
import {
  CONNECT_VIEW_ALL_FEATURE,
  CONNECT_ASSIGN_FEATURE,
  CONNECT_MANAGE_FEATURE,
  CONNECT_HANDLE_FEATURE,
} from '../../lib/case-access'
import { resolveInboxContext } from '../../lib/inbox-route-context'
import { authorizeFeatures } from '@open-mercato/shared/security/featurePolicy'

/**
 * The agent's triage list.
 *
 * The default predicate is UNASSIGNED plus MINE, which is the fix for the
 * earlier design's central failure: filtering agents to their own Cases alone
 * left a new agent with an empty Inbox and no way to pick up work.
 *
 * The list projection carries no message content, no decrypted handle, no
 * subject and no wrap-up — a triage list is read by everyone with the handle
 * feature, so it shows the masked display label instead.
 */

export const metadata = {
  path: '/connect/inbox',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect.inbox.handle'],
  },
}

const querySchema = z.object({
  filter: z.enum(['triage', 'mine', 'unassigned', 'all']).default('triage'),
  includeClosed: z.enum(['true', 'false']).default('false'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

export async function GET(req: Request): Promise<Response> {
  const resolved = await resolveInboxContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context

  const url = new URL(req.url)
  let query: z.infer<typeof querySchema>
  try {
    query = querySchema.parse(Object.fromEntries(url.searchParams))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid query' },
      { status: 422 },
    )
  }

  const grantedFeatures = [...actor.features]
  const seesAll = authorizeFeatures([CONNECT_VIEW_ALL_FEATURE], { grantedFeatures }) ||
    authorizeFeatures([CONNECT_ASSIGN_FEATURE], { grantedFeatures }) ||
    authorizeFeatures([CONNECT_MANAGE_FEATURE], { grantedFeatures })
  const isHandler = authorizeFeatures([CONNECT_HANDLE_FEATURE], { grantedFeatures })

  const em = (container.resolve('em') as EntityManager).fork()
  const where: Record<string, unknown> = {
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
    deletedAt: null,
  }
  if (query.includeClosed === 'false') where.status = { $ne: 'closed' }

  // `all` is only honoured for a caller who may actually see all. Without that
  // check the filter would be a client-side privilege escalation.
  const effectiveFilter = query.filter === 'all' && !seesAll ? 'triage' : query.filter
  if (effectiveFilter === 'mine') {
    where.assigneeUserId = actor.userId
  } else if (effectiveFilter === 'unassigned') {
    where.assigneeUserId = null
  } else if (effectiveFilter === 'triage' && !seesAll) {
    where.$or = [{ assigneeUserId: null }, { assigneeUserId: actor.userId }]
  } else if (effectiveFilter === 'triage') {
    where.$or = [{ assigneeUserId: null }, { assigneeUserId: actor.userId }]
  }
  if (!seesAll && !isHandler) {
    return NextResponse.json({ items: [], total: 0, page: query.page, pageSize: query.pageSize })
  }

  const [rows, total] = await em.findAndCount(ConnectCase, where, {
    orderBy: { lastInboundAt: 'desc', id: 'asc' },
    limit: query.pageSize,
    offset: (query.page - 1) * query.pageSize,
  })

  // Unread is per user, so it is read for THIS caller only — a manager viewing
  // another agent's Case must not clear or observe their unread state.
  const readStates = rows.length
    ? await em.find(ConnectCaseReadState, {
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
        userId: actor.userId,
        caseId: { $in: rows.map((row) => row.id) },
      })
    : []
  const readByCase = new Map(readStates.map((state) => [state.caseId, state.lastReadAt ?? null]))

  return NextResponse.json({
    items: rows.map((row) => ({
      id: row.id,
      number: row.number,
      // Masked label only — never the subject, which is the customer's own words.
      displayLabel: row.displayLabel,
      status: row.status,
      priority: row.priority,
      assigneeUserId: row.assigneeUserId ?? null,
      customerId: row.customerId ?? null,
      lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
      unread: isUnread(row.lastInboundAt ?? null, readByCase.get(row.id) ?? null),
      updatedAt: row.updatedAt.toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  })
}

function isUnread(lastInboundAt: Date | null, lastReadAt: Date | null): boolean {
  if (!lastInboundAt) return false
  if (!lastReadAt) return true
  return lastInboundAt.getTime() > lastReadAt.getTime()
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    GET: {
      summary: 'List cases for triage (unassigned plus mine, or all with the feature)',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Cases' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 422, description: 'Invalid query' },
      ],
    },
  },
}

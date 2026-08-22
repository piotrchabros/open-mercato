import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { ConnectCase } from '../../data/entities'
import { evaluateCaseAccess } from '../../lib/case-access'
import { inboxNotFound, resolveInboxContext } from '../../lib/inbox-route-context'

/**
 * Case read surface, plus the ONE field generic CRUD may change.
 *
 * `priority` is the only mutable field here. Status, assignee, customer,
 * channel, conversation binding, lifecycle timestamps, subject, wrap-up and
 * reply-target provenance all change exclusively through named commands or
 * ingest — a generic PUT would bypass their guards, audit rows and windows,
 * which is precisely how a lifecycle model rots.
 *
 * Manual Case creation is deliberately absent: a Case originates from an
 * authorized inbound receipt, so hand-creating one would produce a Case with no
 * conversation, no identity and nothing to reply to. Cases are closed through
 * the lifecycle command and never generically deleted.
 */

export const metadata = {
  path: '/connect/cases',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect.inbox.handle'],
  },
  PUT: {
    requireAuth: true,
    requireFeatures: ['connect.inbox.handle'],
  },
}

const querySchema = z.object({
  id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
})

function projectCase(row: ConnectCase) {
  return {
    id: row.id,
    number: row.number,
    // The subject is the customer's own words about their problem; the list and
    // detail projections expose only the masked label.
    displayLabel: row.displayLabel,
    status: row.status,
    priority: row.priority,
    assigneeUserId: row.assigneeUserId ?? null,
    customerKind: row.customerKind ?? null,
    customerId: row.customerId ?? null,
    channelId: row.channelId,
    firstInboundAt: row.firstInboundAt?.toISOString() ?? null,
    lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    previousCaseId: row.previousCaseId ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

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

  const em = (container.resolve('em') as EntityManager).fork()

  if (query.id) {
    const row = await em.findOne(ConnectCase, {
      id: query.id,
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      deletedAt: null,
    })
    if (!row || !evaluateCaseAccess(row, actor).canRead) return inboxNotFound()
    return NextResponse.json({ items: [projectCase(row)], total: 1 })
  }

  const [rows, total] = await em.findAndCount(
    ConnectCase,
    { tenantId: actor.tenantId, organizationId: actor.organizationId, deletedAt: null },
    { orderBy: { lastInboundAt: 'desc', id: 'asc' }, limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
  )
  // Filter after the query rather than encoding the matrix in SQL: the matrix is
  // one implementation, and duplicating it as a predicate is how the two drift.
  const visible = rows.filter((row) => evaluateCaseAccess(row, actor).canRead)

  return NextResponse.json({
    items: visible.map(projectCase),
    total,
    page: query.page,
    pageSize: query.pageSize,
  })
}

const updateSchema = z.object({
  id: z.string().uuid(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  expectedUpdatedAt: z.string().optional(),
})

export async function PUT(req: Request): Promise<Response> {
  const resolved = await resolveInboxContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context

  let body: z.infer<typeof updateSchema>
  try {
    // `.strict()` is not used; instead the schema simply has no other fields, so
    // an attempt to send `status` or `assigneeUserId` is silently ignored rather
    // than partially applied.
    body = updateSchema.parse(await readJsonSafe(req, null))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      { status: 422 },
    )
  }

  const guard = await runRouteMutationGuards({
    container: container as never,
    req,
    auth: { userId: actor.userId, tenantId: actor.tenantId, organizationId: actor.organizationId },
    input: {
      resourceKind: 'connect.case',
      resourceId: body.id,
      operation: 'update',
      mutationPayload: { priority: body.priority },
    },
  })
  if (!guard.ok) return guard.response

  const em = (container.resolve('em') as EntityManager).fork()
  const row = await em.findOne(ConnectCase, {
    id: body.id,
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
    deletedAt: null,
  })
  if (!row) return inboxNotFound()
  const access = evaluateCaseAccess(row, actor)
  if (!access.canRead) return inboxNotFound()
  if (!access.canAct) {
    return NextResponse.json(
      { error: 'You can only change a case assigned to you.', code: 'not_owner' },
      { status: 403 },
    )
  }

  if (body.expectedUpdatedAt) {
    const current = row.updatedAt.toISOString()
    if (new Date(body.expectedUpdatedAt).toISOString() !== current) {
      return NextResponse.json(
        {
          error: 'This case changed since you loaded it.',
          code: 'optimistic_lock_conflict',
          currentUpdatedAt: current,
        },
        { status: 409 },
      )
    }
  }

  row.priority = body.priority
  await em.flush()

  await guard.runAfterSuccess()
  return NextResponse.json(projectCase(row))
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    GET: {
      summary: 'List or read cases visible to the caller',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Cases' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Case not found or not readable' },
        { status: 422, description: 'Invalid query' },
      ],
    },
    PUT: {
      summary: 'Change a case priority (the only generically mutable field)',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Priority updated' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 403, description: 'Case is not assigned to you' },
        { status: 404, description: 'Case not found' },
        { status: 409, description: 'Case changed since it was loaded' },
        { status: 422, description: 'Invalid body' },
      ],
    },
  },
}

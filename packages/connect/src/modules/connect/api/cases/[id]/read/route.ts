import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectCase, ConnectCaseReadState } from '../../../../data/entities'
import { evaluateCaseAccess } from '../../../../lib/case-access'
import { inboxNotFound, resolveInboxContext } from '../../../../lib/inbox-route-context'

/**
 * Advance the caller's own read watermark.
 *
 * Strictly own-user: the route ignores any user id in the request and writes
 * the authenticated caller's row. Unread is one agent's attention, so a manager
 * opening a Case must not clear it for its owner, and a reassignment must not
 * carry the previous owner's read state to the new one.
 *
 * Idempotent and monotonic — a watermark never moves backwards, so an
 * out-of-order request cannot resurrect unread state.
 */

export const metadata = {
  path: '/connect/cases/[id]/read',
  POST: {
    requireAuth: true,
    requireFeatures: ['connect.inbox.handle'],
  },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid case id' }, { status: 400 })
  }

  const resolved = await resolveInboxContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context

  const em = (container.resolve('em') as EntityManager).fork()
  const target = await em.findOne(ConnectCase, {
    id,
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
    deletedAt: null,
  })
  if (!target) return inboxNotFound()
  if (!evaluateCaseAccess(target, actor).canRead) return inboxNotFound()

  const now = new Date()
  const existing = await em.findOne(ConnectCaseReadState, {
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
    caseId: target.id,
    userId: actor.userId,
  })

  if (existing) {
    // Monotonic: an out-of-order request must not move the watermark back and
    // make already-read messages unread again.
    if (!existing.lastReadAt || existing.lastReadAt.getTime() < now.getTime()) {
      existing.lastReadAt = now
      existing.lastReadExternalMessageId = target.id
    }
  } else {
    em.persist(
      em.create(ConnectCaseReadState, {
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
        caseId: target.id,
        userId: actor.userId,
        lastReadAt: now,
      }),
    )
  }
  await em.flush()

  return NextResponse.json({ caseId: target.id, lastReadAt: now.toISOString() })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    POST: {
      summary: 'Mark a case read for the authenticated user',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Read watermark advanced' },
        { status: 400, description: 'Invalid case id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Case not found or not readable' },
      ],
    },
  },
}

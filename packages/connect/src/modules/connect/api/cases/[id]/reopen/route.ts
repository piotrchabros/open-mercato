import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { transitionCase } from '../../../../commands/transition-case'
import { inboxNotFound, resolveInboxContext } from '../../../../lib/inbox-route-context'

/**
 * Named lifecycle command. Generic CRUD deliberately cannot perform it: status
 * changes carry audit, guard and window semantics that a PUT would bypass.
 */

export const metadata = {
  path: '/connect/cases/[id]/reopen',
  POST: {
    requireAuth: true,
    requireFeatures: ['connect.inbox.handle'],
  },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

const bodySchema = z.object({
  wrapUp: z.string().max(5000).optional(),
  reason: z.string().max(500).optional(),
  expectedUpdatedAt: z.string().optional(),
})

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid case id' }, { status: 400 })
  }

  const resolved = await resolveInboxContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse((await readJsonSafe(req, {})) ?? {})
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
      resourceId: id,
      operation: 'update',
      mutationPayload: { action: 'reopen' },
    },
  })
  if (!guard.ok) return guard.response

  const result = await transitionCase(container as never, {
    caseId: id,
    action: 'reopen',
    actor: { ...actor, features: [...actor.features], userId: actor.userId, kind: 'user' },
    wrapUp: body.wrapUp,
    reason: body.reason,
    expectedUpdatedAt: body.expectedUpdatedAt,
  })

  if (result.status === 'not_found') return inboxNotFound()
  if (result.status === 'forbidden') {
    return NextResponse.json(
      {
        error:
          result.reason === 'requires_manage'
            ? 'Closing a case requires the manage permission.'
            : 'You can only act on a case assigned to you.',
        code: result.reason,
      },
      { status: 403 },
    )
  }
  if (result.status === 'wrap_up_required') {
    return NextResponse.json(
      { error: 'Add a wrap-up note before resolving.', code: 'wrap_up_required' },
      { status: 422 },
    )
  }
  if (result.status === 'invalid_transition') {
    return NextResponse.json(
      {
        error: 'That change is not allowed from the case’s current state.',
        code: result.reason,
        from: result.from,
        to: result.to,
      },
      { status: 409 },
    )
  }
  if (result.status === 'conflict') {
    return NextResponse.json(
      {
        error: 'This case changed since you loaded it.',
        code: 'optimistic_lock_conflict',
        currentUpdatedAt: result.currentUpdatedAt,
      },
      { status: 409 },
    )
  }

  await guard.runAfterSuccess()
  return NextResponse.json(result)
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    POST: {
      summary: 'Transition a case (reopen)',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Transitioned' },
        { status: 400, description: 'Invalid case id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 403, description: 'Not permitted for this case' },
        { status: 404, description: 'Case not found' },
        { status: 409, description: 'Illegal transition, or the case changed since it was loaded' },
        { status: 422, description: 'Invalid body or missing wrap-up' },
      ],
    },
  },
}

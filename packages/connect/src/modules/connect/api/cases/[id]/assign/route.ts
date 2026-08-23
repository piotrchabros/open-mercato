import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { assignCase, type AssignCaseResult } from '../../../../commands/assign-case'
import { caseMergedConflict, inboxNotFound, resolveInboxContext } from '../../../../lib/inbox-route-context'

/**
 * Self-claim, assign, transfer and unassign — one route, one command.
 *
 * Splitting claim from assign is what produced the earlier design's dead end,
 * where an agent could see unassigned Cases but had no way to take one.
 */

export const metadata = {
  path: '/connect/cases/[id]/assign',
  POST: {
    requireAuth: true,
    requireFeatures: ['connect.inbox.handle'],
  },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

const bodySchema = z.object({
  assigneeUserId: z.string().uuid().nullable(),
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
  const { container, auth, actor } = resolved.context

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await readJsonSafe(req, null))
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
      mutationPayload: { action: 'assign', assigneeUserId: body.assigneeUserId },
    },
  })
  if (!guard.ok) return guard.response

  const result: AssignCaseResult = await assignCase(container as never, {
    caseId: id,
    assigneeUserId: body.assigneeUserId,
    actor: { ...actor, features: [...actor.features] },
    reason: body.reason,
    expectedUpdatedAt: body.expectedUpdatedAt,
  })

  if (result.status === 'not_found') return inboxNotFound()
  if (result.status === 'forbidden') {
    return NextResponse.json(
      {
        error:
          result.reason === 'already_owned'
            ? 'This case is already assigned. Ask a manager to reassign it.'
            : 'You are not allowed to assign this case.',
        code: result.reason,
      },
      { status: 403 },
    )
  }
  if (result.status === 'invalid_target') {
    return NextResponse.json(
      { error: 'That user cannot be assigned to this case.', code: 'invalid_target' },
      { status: 422 },
    )
  }
  if (result.status === 'case_merged') return caseMergedConflict(result.canonicalCaseId)
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
      summary: 'Claim, assign, transfer or unassign a case',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Assignment applied (or already in that state)' },
        { status: 400, description: 'Invalid case id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 403, description: 'Not allowed to assign this case' },
        { status: 404, description: 'Case not found' },
        { status: 409, description: 'Case changed since it was loaded' },
        { status: 422, description: 'Invalid body or unassignable target' },
      ],
    },
  },
}

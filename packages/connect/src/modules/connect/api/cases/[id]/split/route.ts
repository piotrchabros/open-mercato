import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { splitCaseRequestSchema } from '../../../../data/validators'
import { resolveInboxContext } from '../../../../lib/inbox-route-context'
import { executeReparentRoute, reparentOpenApiResponses } from '../../../../lib/reparent-route'

/**
 * Split selected Conversations out of a Case into a new child Case.
 *
 * A named action, not a PUT: the operation moves binding intervals, allocates a
 * Case number, writes an audit row and stages a lineage event, all atomically.
 * Generic CRUD would bypass every one of those.
 */

export const metadata = {
  path: '/connect/cases/[id]/split',
  POST: {
    requireAuth: true,
    requireFeatures: ['connect.cases.reparent'],
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

  const raw = await readJsonSafe(req, null)
  let body: z.infer<typeof splitCaseRequestSchema>
  try {
    body = splitCaseRequestSchema.parse(raw)
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
      mutationPayload: { action: 'split', conversationIds: body.conversationIds },
    },
  })
  if (!guard.ok) return guard.response

  // A guard may rewrite the selection (narrowing which conversations an operator
  // may move is exactly the kind of policy guards exist for), so the modified
  // payload is re-parsed rather than trusted.
  if (guard.modifiedPayload) {
    const merged = splitCaseRequestSchema.safeParse({ ...body, ...guard.modifiedPayload })
    if (!merged.success) {
      return NextResponse.json({ error: merged.error.message }, { status: 422 })
    }
    body = merged.data
  }

  return executeReparentRoute({
    container,
    actor,
    guard,
    request: req,
    input: {
      operation: 'split',
      sourceCaseId: id,
      conversationIds: body.conversationIds,
      expectedSourceUpdatedAt: body.expectedUpdatedAt,
      clientCommandKey: body.clientCommandKey,
      reason: body.reason,
      actor: {
        userId: actor.userId,
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
        features: [...actor.features],
      },
    },
  })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    POST: {
      summary: 'Split selected conversations out of a case into a new child case',
      tags: ['Connect'],
      responses: reparentOpenApiResponses('split'),
    },
  },
}

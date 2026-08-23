import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { mergeCaseRequestSchema } from '../../../../data/validators'
import { resolveInboxContext } from '../../../../lib/inbox-route-context'
import { executeReparentRoute, reparentOpenApiResponses } from '../../../../lib/reparent-route'

/**
 * Merge this Case into a canonical target.
 *
 * The path id is the SOURCE — the Case that becomes historical — and the body
 * names the survivor. Deliberately that way round: the destructive half of the
 * operation is the one the URL identifies, so a mis-sent request cannot quietly
 * retire the Case an operator meant to keep.
 */

export const metadata = {
  path: '/connect/cases/[id]/merge',
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

  let body: z.infer<typeof mergeCaseRequestSchema>
  try {
    body = mergeCaseRequestSchema.parse(await readJsonSafe(req, null))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      { status: 422 },
    )
  }

  if (body.targetCaseId === id) {
    return NextResponse.json(
      { error: 'A case cannot be merged into itself.', code: 'invalid_selection', reason: 'same_case' },
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
      mutationPayload: { action: 'merge', targetCaseId: body.targetCaseId },
    },
  })
  if (!guard.ok) return guard.response

  if (guard.modifiedPayload) {
    const merged = mergeCaseRequestSchema.safeParse({ ...body, ...guard.modifiedPayload })
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
      operation: 'merge',
      sourceCaseId: id,
      targetCaseId: body.targetCaseId,
      expectedSourceUpdatedAt: body.expectedSourceUpdatedAt,
      expectedTargetUpdatedAt: body.expectedTargetUpdatedAt,
      clientCommandKey: body.clientCommandKey,
      reason: body.reason,
      allowCustomerMismatch: body.allowCustomerMismatch,
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
      summary: 'Merge this case into a canonical target case',
      tags: ['Connect'],
      responses: reparentOpenApiResponses('merge'),
    },
  },
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { unlinkIdentity } from '../../../../commands/unlink-identity'
import { inboxNotFound, resolveInboxContext } from '../../../../lib/inbox-route-context'

/**
 * Unlink an identity and retract everything the link projected.
 *
 * The reason is REQUIRED: an unlink hides a customer's timeline entries, and a
 * later reviewer needs to know on whose judgement.
 *
 * Every non-success is retryable-with-the-same-request, so the client can poll
 * `unlink-status` and re-issue rather than inventing compensations of its own.
 */

export const metadata = {
  path: '/connect/contact-identities/[id]/unlink',
  POST: {
    requireAuth: true,
    requireFeatures: ['connect.customer_match.unlink'],
  },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

const bodySchema = z.object({
  reason: z.string().min(1).max(500),
  expectedUpdatedAt: z.string().optional(),
})

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid identity id' }, { status: 400 })
  }

  const resolved = await resolveInboxContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context

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
      resourceKind: 'connect.contact_identity',
      resourceId: id,
      operation: 'update',
      mutationPayload: { action: 'unlink' },
    },
  })
  if (!guard.ok) return guard.response

  const result = await unlinkIdentity(container as never, {
    identityId: id,
    reason: body.reason,
    expectedUpdatedAt: body.expectedUpdatedAt,
    actor: { ...actor, features: [...actor.features] },
  })

  if (result.status === 'not_found') return inboxNotFound()
  if (result.status === 'conflict') {
    return NextResponse.json(
      {
        error: 'This identity changed since you loaded it.',
        code: 'optimistic_lock_conflict',
        currentUpdatedAt: result.currentUpdatedAt,
      },
      { status: 409 },
    )
  }
  if (result.status === 'in_progress') {
    return NextResponse.json(
      {
        error: 'An unlink is already running for this identity.',
        code: 'unlink_in_progress',
        sagaId: result.sagaId,
      },
      { status: 409 },
    )
  }
  // 502, not 500: the source refused or could not answer, and the saga is
  // durable — the caller may safely re-issue the identical request, and
  // recovery converges it even if they never do.
  if (result.status === 'source_unavailable' || result.status === 'inventory_conflict') {
    return NextResponse.json(
      {
        error:
          result.status === 'inventory_conflict'
            ? 'The set of projected interactions changed while unlinking. Retry to recompute it.'
            : 'The customer timeline service could not complete the retraction. Retry shortly.',
        code: result.status,
        sagaId: result.sagaId,
        retryable: true,
      },
      { status: 502 },
    )
  }

  await guard.runAfterSuccess()
  return NextResponse.json(result)
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    POST: {
      summary: 'Unlink a contact identity and retract its customer projections',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Unlinked, or already not linked' },
        { status: 400, description: 'Invalid identity id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Identity not found' },
        { status: 409, description: 'Unlink already running, or the identity changed since it was loaded' },
        { status: 422, description: 'Invalid body (a reason is required)' },
        { status: 502, description: 'Retraction could not complete at the source; safe to retry' },
      ],
    },
  },
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { linkIdentity } from '../../../../commands/link-identity'
import { inboxNotFound, resolveInboxContext } from '../../../../lib/inbox-route-context'

/**
 * Link a contact identity to a customer.
 *
 * The customer reference is revalidated server-side through the source-owned
 * contract before any Connect row is written, and every way it can be wrong —
 * stale, forged, deleted, wrong kind, sibling organization, foreign tenant —
 * produces the same 404. The client's `confidence` and `matchMethod` are
 * explanatory evidence in the UI, never authorization.
 */

export const metadata = {
  path: '/connect/contact-identities/[id]/link',
  POST: {
    requireAuth: true,
    requireFeatures: ['connect.customer_match.link'],
  },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

const bodySchema = z.object({
  customerKind: z.enum(['person', 'company']),
  customerId: z.string().uuid(),
  reason: z.string().max(500).optional(),
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
      mutationPayload: { action: 'link', customerKind: body.customerKind },
    },
  })
  if (!guard.ok) return guard.response

  const result = await linkIdentity(container as never, {
    identityId: id,
    customerKind: body.customerKind,
    customerId: body.customerId,
    reason: body.reason,
    expectedUpdatedAt: body.expectedUpdatedAt,
    actor: { ...actor, features: [...actor.features] },
  })

  if (result.status === 'not_found') return inboxNotFound()
  // Deliberately the same 404 as a missing identity: a caller must not learn
  // which customer ids exist by probing this endpoint.
  if (result.status === 'customer_missing') {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }
  if (result.status === 'unlink_in_progress') {
    return NextResponse.json(
      {
        error: 'This identity is being unlinked. Wait for that to finish before linking it again.',
        code: 'unlink_in_progress',
        sagaId: result.sagaId,
      },
      { status: 409 },
    )
  }
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

  await guard.runAfterSuccess()
  return NextResponse.json(result)
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    POST: {
      summary: 'Link a contact identity to a customer',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Linked (or already linked to that customer)' },
        { status: 400, description: 'Invalid identity id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Identity or customer not found' },
        { status: 409, description: 'Unlink in progress, or the identity changed since it was loaded' },
        { status: 422, description: 'Invalid body' },
      ],
    },
  },
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectCase } from '../../../../data/entities'
import { evaluateCaseAccess } from '../../../../lib/case-access'
import { readCustomerContexts } from '../../../../lib/customer-context'
import { inboxNotFound, resolveInboxContext } from '../../../../lib/inbox-route-context'

/**
 * The customer currently associated with a Case, as seen from the Case.
 *
 * Two properties make this safe to render in the Inbox:
 *
 *   - It reads the Case's LIVE `customerKind`/`customerId`. An unlink clears
 *     those in the same transaction that fences the identity, so the previous
 *     customer disappears from this response immediately — before, not after,
 *     the upstream tombstones drain.
 *   - It never touches the link audit. The audit is the only place a prior
 *     customer survives, and it is gated behind `.audit` precisely so that an
 *     agent's Case screen cannot become a way to read it.
 *
 * Case visibility uses the Inbox access matrix, so an agent who cannot open the
 * Case cannot learn its customer either.
 */

export const metadata = {
  path: '/connect/cases/[id]/customer-context',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect.customer_match.read'],
  },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function GET(req: Request, context: RouteContext): Promise<Response> {
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

  if (!target.customerId || !target.customerKind) {
    return NextResponse.json({ caseId: target.id, customer: null, context: null })
  }

  const ref = { kind: target.customerKind, id: target.customerId }
  const [customerContext] = await readCustomerContexts(
    em,
    { tenantId: actor.tenantId, organizationId: actor.organizationId },
    [ref],
  )

  return NextResponse.json({
    caseId: target.id,
    // Opaque reference only. The Case screen resolves the display name through
    // the authorized customers API, so no customer PII is copied into Connect.
    customer: ref,
    context: customerContext ?? { ...ref, openCaseCount: 0, lastCaseAt: null, lastCaseStatus: null },
  })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    GET: {
      summary: 'Read the customer currently associated with a case',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Current association, or null when the case is unlinked' },
        { status: 400, description: 'Invalid case id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Case not found' },
      ],
    },
  },
}

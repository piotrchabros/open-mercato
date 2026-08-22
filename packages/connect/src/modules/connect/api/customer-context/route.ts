import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { readCustomerContexts } from '../../lib/customer-context'
import { resolveInboxContext } from '../../lib/inbox-route-context'

/**
 * Connect context for ONE customer reference.
 *
 * The single-reference form exists for detail widgets. Lists must use the
 * batch route instead — one request per row is what `POST /query` was added to
 * prevent.
 */

export const metadata = {
  path: '/connect/customer-context',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect.customer_match.read'],
  },
}

const querySchema = z.object({
  kind: z.enum(['person', 'company']),
  id: z.string().uuid(),
})

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
  const [context] = await readCustomerContexts(
    em,
    { tenantId: actor.tenantId, organizationId: actor.organizationId },
    [query],
  )

  // A customer with no Connect traffic and a customer in another organization
  // produce the identical answer: an empty context, never a 404. A distinct
  // status here would turn this route into an existence oracle.
  return NextResponse.json({
    context: context ?? {
      kind: query.kind,
      id: query.id,
      openCaseCount: 0,
      lastCaseAt: null,
      lastCaseStatus: null,
    },
  })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    GET: {
      summary: 'Read Connect case context for one customer reference',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Context (all-zero when there is no in-scope traffic)' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 422, description: 'Invalid query' },
      ],
    },
  },
}

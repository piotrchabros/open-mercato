import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { CUSTOMER_CONTEXT_BATCH_LIMIT, readCustomerContexts } from '../../../lib/customer-context'
import { resolveInboxContext } from '../../../lib/inbox-route-context'

/**
 * Batched Connect context for a page of customer references.
 *
 * A POST because a hundred kind/id pairs do not belong in a URL, not because it
 * mutates anything — it is a pure read, and carries no mutation guard.
 *
 * The batch is CAPPED rather than truncated: silently answering the first 100 of
 * 500 references would render a customer list where some rows show no Connect
 * activity because nobody asked, which is indistinguishable from having none.
 */

export const metadata = {
  path: '/connect/customer-context/query',
  POST: {
    requireAuth: true,
    requireFeatures: ['connect.customer_match.read'],
  },
}

const bodySchema = z.object({
  refs: z
    .array(z.object({ kind: z.enum(['person', 'company']), id: z.string().uuid() }))
    .min(1)
    .max(CUSTOMER_CONTEXT_BATCH_LIMIT),
})

export async function POST(req: Request): Promise<Response> {
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

  const em = (container.resolve('em') as EntityManager).fork()
  const items = await readCustomerContexts(
    em,
    { tenantId: actor.tenantId, organizationId: actor.organizationId },
    body.refs,
  )

  // Only contributing references come back. Absence means "nothing in scope",
  // which is the same answer for a foreign reference and an idle one.
  return NextResponse.json({ items })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    POST: {
      summary: 'Read Connect case context for up to 100 customer references',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Contexts for the in-scope references that have Connect traffic' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 422, description: 'Invalid body or more than 100 references' },
      ],
    },
  },
}

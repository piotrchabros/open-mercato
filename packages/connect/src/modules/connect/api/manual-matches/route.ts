import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectContactIdentity, ConnectManualMatchTask } from '../../data/entities'
import { resolveInboxContext } from '../../lib/inbox-route-context'

/**
 * The customer-matching queue.
 *
 * Oldest-first and organization-wide: Phase 1 has no assignee, because routing
 * rules are a separate decision from having a queue at all.
 *
 * The projection shows the MASKED handle and never the decrypted value — the
 * queue is read by everyone with `customer_match.read`, and the whole point of
 * encrypting the handle is that reading a list should not disclose it.
 */

export const metadata = {
  path: '/connect/manual-matches',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect.customer_match.read'],
  },
}

const querySchema = z.object({
  status: z.enum(['open', 'resolved', 'superseded']).default('open'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
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
  const [tasks, total] = await em.findAndCount(
    ConnectManualMatchTask,
    { tenantId: actor.tenantId, organizationId: actor.organizationId, status: query.status },
    { orderBy: { createdAt: 'asc' }, limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
  )

  const identities = tasks.length
    ? await em.find(ConnectContactIdentity, {
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
        id: { $in: tasks.map((task) => task.identityId) },
      })
    : []
  const identityById = new Map(identities.map((identity) => [identity.id, identity]))

  return NextResponse.json({
    items: tasks.map((task) => {
      const identity = identityById.get(task.identityId)
      return {
        id: task.id,
        identityId: task.identityId,
        status: task.status,
        // Masked only. The decrypted handle never leaves the module.
        handleType: identity?.handleType ?? null,
        handleDisplayLabel: identity?.handleDisplayLabel ?? null,
        confidence: identity?.confidence ?? null,
        matchMethod: identity?.matchMethod ?? null,
        // Surfaced so the UI can disable link controls while an unlink is in
        // flight rather than letting the command reject the click.
        unlinkInProgress: Boolean(identity?.unlinkPendingSagaId),
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
        identityUpdatedAt: identity?.updatedAt.toISOString() ?? null,
      }
    }),
    total,
    page: query.page,
    pageSize: query.pageSize,
  })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    GET: {
      summary: 'List identities awaiting a manual customer match',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Queue page' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 422, description: 'Invalid query' },
      ],
    },
  },
}

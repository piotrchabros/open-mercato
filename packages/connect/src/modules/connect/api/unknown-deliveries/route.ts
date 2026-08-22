import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { ConnectOutboundAttempt, ConnectUnknownDelivery } from '../../data/entities'
import { resolveInboxContext } from '../../lib/inbox-route-context'

/**
 * The unknown-delivery recovery queue.
 *
 * Deliberately **refresh and acknowledge only**. Phase 1 has no force-sent or
 * force-failed override: asserting an outcome the provider never confirmed is
 * exactly how a customer gets a duplicate reply, or how a lost one is quietly
 * marked delivered. Retry stays disabled here because a retry is only safe once
 * the source has proved a terminal failure.
 *
 * Owned by Inbox, not Metrics, so it works with Metrics uninstalled.
 */

export const metadata = {
  path: '/connect/unknown-deliveries',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect.inbox.recovery.view'],
  },
  POST: {
    requireAuth: true,
    requireFeatures: ['connect.inbox.recovery.acknowledge'],
  },
}

export async function GET(req: Request): Promise<Response> {
  const resolved = await resolveInboxContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context

  const em = (container.resolve('em') as EntityManager).fork()
  const rows = await em.find(
    ConnectUnknownDelivery,
    { tenantId: actor.tenantId, organizationId: actor.organizationId, acknowledgedAt: null },
    { orderBy: { createdAt: 'asc' }, limit: 100 },
  )

  const attempts = rows.length
    ? await em.find(ConnectOutboundAttempt, {
        tenantId: actor.tenantId,
        id: { $in: rows.map((row) => row.attemptId) },
      })
    : []
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]))
  const now = Date.now()

  return NextResponse.json({
    items: rows.map((row) => ({
      id: row.id,
      caseId: row.caseId,
      attemptId: row.attemptId,
      channelId: row.channelId,
      // Whether the provider can corroborate at all — the operator needs this
      // to know if waiting will ever help.
      lookupSupported: row.lookupSupported ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      ageMinutes: Math.floor((now - row.createdAt.getTime()) / 60_000),
      attemptStatus: attemptById.get(row.attemptId)?.status ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  })
}

const acknowledgeSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().min(1).max(500),
})

export async function POST(req: Request): Promise<Response> {
  const resolved = await resolveInboxContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context

  let body: z.infer<typeof acknowledgeSchema>
  try {
    body = acknowledgeSchema.parse(await readJsonSafe(req, null))
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
      resourceKind: 'connect.unknown_delivery',
      resourceId: body.id,
      operation: 'update',
      mutationPayload: { action: 'acknowledge' },
    },
  })
  if (!guard.ok) return guard.response

  const em = (container.resolve('em') as EntityManager).fork()
  const row = await em.findOne(ConnectUnknownDelivery, {
    id: body.id,
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
  })
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Acknowledging records a human decision; it does NOT assert an outcome. The
  // attempt stays `unknown`, because that is still the truth.
  row.acknowledgedAt = new Date()
  row.acknowledgedByUserId = actor.userId
  row.acknowledgeReason = body.reason
  await em.flush()

  await guard.runAfterSuccess()
  return NextResponse.json({ id: row.id, acknowledged: true })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    GET: {
      summary: 'List deliveries whose outcome could not be determined',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Open unknown deliveries' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
      ],
    },
    POST: {
      summary: 'Acknowledge an unknown delivery without asserting an outcome',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Acknowledged' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Not found' },
        { status: 422, description: 'Invalid body' },
      ],
    },
  },
}

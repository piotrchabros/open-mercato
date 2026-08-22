import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  ConnectInboundReceipt,
  ConnectPendingProjection,
  ConnectUnknownDelivery,
} from '../../../data/entities'
import { resolveInboxContext } from '../../../lib/inbox-route-context'

/**
 * The actionable exceptions behind the numbers.
 *
 * A metrics screen that shows "3 unreconciled" and nothing else is not
 * operable, so each exception type resolves to the identifiers an operator
 * needs to act — and to nothing more. Reason codes, ids, scopes and timestamps
 * only: no handle, no subject, no body. A reporting surface must not become the
 * place where message content is easiest to read.
 *
 * Metrics never mutates. Replay and acknowledgement stay on the
 * Foundation-owned receipt routes, which enforce their own guards; this route
 * only points at the rows.
 */

export const metadata = {
  path: '/connect/metrics/exceptions',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect.metrics.view'],
  },
}

const EXCEPTION_TYPES = ['unreconciled_inbound', 'dead_lettered', 'unknown_send', 'projection_failed'] as const

const querySchema = z.object({
  type: z.enum(EXCEPTION_TYPES),
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
  const scope = { tenantId: actor.tenantId, organizationId: actor.organizationId }
  const offset = (query.page - 1) * query.pageSize
  const now = new Date()

  if (query.type === 'unreconciled_inbound') {
    // Still `processing` with an expired lease: the receipt that makes a day's
    // equation fail to balance.
    const [rows, total] = await em.findAndCount(
      ConnectInboundReceipt,
      { ...scope, status: 'processing', leaseExpiresAt: { $lt: now } },
      { orderBy: { createdAt: 'asc' }, limit: query.pageSize, offset },
    )
    return NextResponse.json({
      type: query.type,
      total,
      page: query.page,
      pageSize: query.pageSize,
      items: rows.map((row) => ({
        receiptId: row.id,
        channelId: row.channelId,
        claimCohortUtcDate: row.claimCohortUtcDate,
        attempts: row.attempts,
        leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        // Foundation owns the remediation; Metrics only names the row.
        replayPath: `/api/connect/inbound-receipts/${row.id}/replay`,
      })),
    })
  }

  if (query.type === 'dead_lettered') {
    const [rows, total] = await em.findAndCount(
      ConnectInboundReceipt,
      { ...scope, disposition: 'dead_lettered' },
      { orderBy: { lastAttemptAt: 'desc' }, limit: query.pageSize, offset },
    )
    return NextResponse.json({
      type: query.type,
      total,
      page: query.page,
      pageSize: query.pageSize,
      items: rows.map((row) => ({
        receiptId: row.id,
        channelId: row.channelId,
        claimCohortUtcDate: row.claimCohortUtcDate,
        // A safe reason code, never the message that failed.
        terminalReason: row.terminalReason ?? null,
        attempts: row.attempts,
        lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
        replayPath: `/api/connect/inbound-receipts/${row.id}/replay`,
        acknowledgePath: `/api/connect/inbound-receipts/${row.id}/acknowledge`,
      })),
    })
  }

  if (query.type === 'unknown_send') {
    const [rows, total] = await em.findAndCount(
      ConnectUnknownDelivery,
      { ...scope, acknowledgedAt: null },
      { orderBy: { createdAt: 'asc' }, limit: query.pageSize, offset },
    )
    return NextResponse.json({
      type: query.type,
      total,
      page: query.page,
      pageSize: query.pageSize,
      items: rows.map((row) => ({
        attemptId: row.attemptId,
        caseId: row.caseId,
        channelId: row.channelId,
        // Age is the actionable part: an unknown send from ten minutes ago is
        // normal, one from three days ago is not.
        ageSeconds: Math.floor((now.getTime() - row.createdAt.getTime()) / 1000),
        lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    })
  }

  const [rows, total] = await em.findAndCount(
    ConnectPendingProjection,
    { ...scope, status: 'failed' },
    { orderBy: { updatedAt: 'desc' }, limit: query.pageSize, offset },
  )
  return NextResponse.json({
    type: query.type,
    total,
    page: query.page,
    pageSize: query.pageSize,
    items: rows.map((row) => ({
      projectionKey: row.projectionKey,
      caseId: row.caseId,
      identityId: row.identityId,
      lastError: row.lastError ?? null,
      attempts: row.attempts,
      updatedAt: row.updatedAt.toISOString(),
    })),
  })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    GET: {
      summary: 'List actionable Connect operational exceptions',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Exception page for the requested type' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 422, description: 'Unknown exception type or invalid paging' },
      ],
    },
  },
}

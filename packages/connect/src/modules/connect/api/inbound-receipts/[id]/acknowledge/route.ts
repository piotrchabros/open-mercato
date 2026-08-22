import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { ConnectInboundReceipt } from '../../../../data/entities'
import { receiptRemediationSchema } from '../../../../data/validators'

/**
 * Acknowledge a dead-lettered inbound receipt.
 *
 * Records that a human looked at it and decided not to replay. It deliberately
 * DELETES NOTHING: the receipt, its terminal reason and the acknowledging actor
 * all remain, because "we dropped a customer's message on purpose" is exactly
 * the kind of decision that needs an audit trail.
 */

export const metadata = {
  path: '/connect/inbound-receipts/[id]/acknowledge',
  POST: {
    requireAuth: true,
    requireFeatures: ['connect.inbound.remediate'],
  },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid receipt id' }, { status: 400 })
  }

  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth?.tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const organizationId = (auth as { orgId?: string | null }).orgId ?? null
  if (!organizationId) {
    return NextResponse.json(
      { error: 'Select an organization to remediate its inbound receipts.', code: 'organization_required' },
      { status: 400 },
    )
  }

  let body: z.infer<typeof receiptRemediationSchema>
  try {
    body = receiptRemediationSchema.parse(await readJsonSafe(req, null))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      { status: 422 },
    )
  }

  const container = await createRequestContainer()
  const guard = await runRouteMutationGuards({
    container: container as never,
    req,
    auth: { userId: auth.sub as string, tenantId: auth.tenantId as string, organizationId },
    input: {
      resourceKind: 'connect.inbound_receipt',
      resourceId: id,
      operation: 'update',
      mutationPayload: { action: 'acknowledge', reason: body.reason },
    },
  })
  if (!guard.ok) return guard.response

  const em = (container.resolve('em') as EntityManager).fork()
  const receipt = await em.findOne(ConnectInboundReceipt, {
    id,
    tenantId: auth.tenantId as string,
    organizationId,
  })
  if (!receipt) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 })

  if (receipt.disposition !== 'dead_lettered') {
    return NextResponse.json(
      {
        error: 'Only a dead-lettered receipt can be acknowledged.',
        code: 'not_acknowledgeable',
        disposition: receipt.disposition,
      },
      { status: 409 },
    )
  }

  // The reason and actor are appended to the terminal reason rather than
  // replacing it: the ORIGINAL failure is the evidence, and overwriting it
  // would erase why the message was lost in the first place.
  receipt.terminalReason = `${receipt.terminalReason ?? 'unknown'}; acknowledged_by=${auth.sub}; reason=${body.reason}`
  await em.flush()

  await guard.runAfterSuccess()
  return NextResponse.json({ receiptId: receipt.id, acknowledged: true })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    POST: {
      summary: 'Acknowledge a dead-lettered inbound receipt without replaying it',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Acknowledged; evidence preserved' },
        { status: 400, description: 'Invalid id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Receipt not found' },
        { status: 409, description: 'Receipt is not dead-lettered' },
        { status: 422, description: 'Invalid body' },
      ],
    },
  },
}

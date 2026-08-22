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
 * Replay a dead-lettered inbound receipt.
 *
 * Replay does NOT create a second receipt: it resets the SAME row to
 * `processing` so the original idempotency scope still arbitrates. Creating a
 * new receipt would defeat the unique key that stops a message being ingested
 * twice — the exact failure the receipt exists to prevent.
 *
 * Only a dead-lettered receipt is replayable. A suppressed one was a deliberate
 * classification, and a completed open/attach already has its Case; re-running
 * either would produce a duplicate the operator did not ask for.
 */

export const metadata = {
  path: '/connect/inbound-receipts/[id]/replay',
  POST: {
    requireAuth: true,
    requireFeatures: ['connect.inbound.remediate'],
  },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

/** Reasons a replay can actually fix. Anything else stays dead-lettered. */
const REMEDIABLE_REASONS = new Set(['attempts_exhausted', 'inbound_envelope_transient'])

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
      mutationPayload: { action: 'replay', reason: body.reason },
    },
  })
  if (!guard.ok) return guard.response

  const em = (container.resolve('em') as EntityManager).fork()
  const receipt = await em.findOne(ConnectInboundReceipt, {
    id,
    tenantId: auth.tenantId as string,
    organizationId,
  })
  // A receipt in another tenant or organization is indistinguishable from a
  // missing one.
  if (!receipt) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 })

  if (receipt.disposition !== 'dead_lettered') {
    return NextResponse.json(
      {
        error: 'Only a dead-lettered receipt can be replayed.',
        code: 'not_replayable',
        disposition: receipt.disposition,
      },
      { status: 409 },
    )
  }
  if (receipt.terminalReason && !REMEDIABLE_REASONS.has(receipt.terminalReason)) {
    return NextResponse.json(
      {
        error: 'This receipt failed for a reason a replay cannot fix.',
        code: 'not_remediable',
        terminalReason: receipt.terminalReason,
      },
      { status: 409 },
    )
  }

  // Reuse the same row and the same idempotency scope. Attempts are reset so
  // the sweep gives it a fresh budget rather than dead-lettering it instantly.
  receipt.status = 'processing'
  receipt.disposition = null
  receipt.terminalReason = null
  receipt.caseId = null
  receipt.attempts = 0
  receipt.leaseExpiresAt = null
  await em.flush()

  await guard.runAfterSuccess()
  return NextResponse.json({ receiptId: receipt.id, status: receipt.status })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    POST: {
      summary: 'Replay a dead-lettered inbound receipt',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Receipt queued for reprocessing' },
        { status: 400, description: 'Invalid id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Receipt not found' },
        { status: 409, description: 'Receipt is not dead-lettered, or its reason is not remediable' },
        { status: 422, description: 'Invalid body' },
      ],
    },
  },
}

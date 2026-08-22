import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  ConnectContactIdentity,
  ConnectPendingRetraction,
  ConnectRetractionSaga,
} from '../../../../data/entities'
import { inboxNotFound, resolveInboxContext } from '../../../../lib/inbox-route-context'

/**
 * Resumable status for the most recent unlink saga on an identity.
 *
 * This exists so a client that lost its response — a timeout, a closed tab, a
 * reload — can find out what actually happened instead of re-deciding. It is
 * gated on `.recover` rather than `.read` because the phase names describe the
 * retraction machinery, which is operator information.
 *
 * `retryable` is the actionable part: an undecided saga may be re-issued with
 * the identical request, whereas a decided one must not be "retried" — the
 * decision is monotonic and a second call would only report the same outcome.
 */

export const metadata = {
  path: '/connect/contact-identities/[id]/unlink-status',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect.customer_match.recover'],
  },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function GET(req: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid identity id' }, { status: 400 })
  }

  const resolved = await resolveInboxContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context

  const em = (container.resolve('em') as EntityManager).fork()
  const scope = { tenantId: actor.tenantId, organizationId: actor.organizationId }

  // Scope the identity first: an identity in a sibling organization must be
  // indistinguishable from one that does not exist, saga or no saga.
  const identity = await em.findOne(ConnectContactIdentity, { id, ...scope })
  if (!identity) return inboxNotFound()

  const saga = await em.findOne(
    ConnectRetractionSaga,
    { ...scope, identityId: id },
    { orderBy: { epoch: 'desc', createdAt: 'desc' } },
  )
  if (!saga) {
    return NextResponse.json({
      identityId: id,
      state: 'none',
      unlinkInProgress: false,
      retryable: true,
      updatedAt: identity.updatedAt.toISOString(),
    })
  }

  const [pendingFinalize, failedFinalize] = await Promise.all([
    em.count(ConnectPendingRetraction, { ...scope, sagaId: saga.sagaId, status: 'pending' }),
    em.count(ConnectPendingRetraction, { ...scope, sagaId: saga.sagaId, status: 'failed' }),
  ])

  return NextResponse.json({
    identityId: id,
    sagaId: saga.sagaId,
    epoch: saga.epoch,
    // `phase` is where the machinery is; `decision` is what is already true and
    // can never change. A client should branch on the decision.
    state: saga.phase,
    decision: saga.decision,
    // The fence, not the phase: this is what makes link/unlink controls unsafe.
    unlinkInProgress: identity.unlinkPendingSagaId === saga.sagaId,
    inventorySize: saga.inventory.length,
    pendingFinalizeCount: pendingFinalize,
    // Non-zero means the interactions stay hidden upstream and an operator must
    // look — it is never a reason to show the old customer data again.
    failedFinalizeCount: failedFinalize,
    // Undecided sagas converge by recovery or by re-issuing the same unlink;
    // a decided one is already final.
    retryable: saga.decision === 'undecided',
    lastError: saga.lastError ?? null,
    attempts: saga.attempts,
    completedAt: saga.completedAt?.toISOString() ?? null,
    updatedAt: saga.updatedAt.toISOString(),
  })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    GET: {
      summary: 'Read the resumable status of an identity unlink saga',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Saga status, or `none` when the identity was never unlinked' },
        { status: 400, description: 'Invalid identity id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Identity not found' },
      ],
    },
  },
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { retryOutbound } from '../../../../../../commands/retry-outbound'
import { inboxNotFound, resolveInboxContext } from '../../../../../../lib/inbox-route-context'
import { CONNECT_QUEUES } from '../../../../../../lib/queue'

/**
 * Retry a FAILED delivery attempt.
 *
 * Only `failed` is retryable. `unknown` means the message may already be in the
 * customer's mailbox, and retrying it would send a second copy — so the command
 * refuses it and the UI disables the affordance rather than relying on the user
 * to understand the difference.
 */

export const metadata = {
  path: '/connect/cases/[id]/messages/[attemptId]/retry',
  POST: {
    requireAuth: true,
    requireFeatures: ['connect.inbox.handle'],
  },
}

type RouteContext = {
  params: Promise<{ id: string; attemptId: string }> | { id: string; attemptId: string }
}

type QueueFactoryLike = { getQueue?: (name: string) => { enqueue: (p: Record<string, unknown>) => Promise<unknown> } | undefined }

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  const { id, attemptId } = await context.params
  if (!z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(attemptId).success) {
    return NextResponse.json({ error: 'Invalid identifier' }, { status: 400 })
  }

  const resolved = await resolveInboxContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context

  const guard = await runRouteMutationGuards({
    container: container as never,
    req,
    auth: { userId: actor.userId, tenantId: actor.tenantId, organizationId: actor.organizationId },
    input: {
      resourceKind: 'connect.outbound_message',
      resourceId: attemptId,
      operation: 'update',
      mutationPayload: { action: 'retry', caseId: id },
    },
  })
  if (!guard.ok) return guard.response

  const result = await retryOutbound(container as never, {
    caseId: id,
    attemptId,
    actor: { ...actor, features: [...actor.features] },
  })

  if (result.status === 'not_found') return inboxNotFound()
  if (result.status === 'forbidden') {
    return NextResponse.json(
      { error: 'You can only retry from a case assigned to you.', code: result.reason },
      { status: 403 },
    )
  }
  if (result.status === 'not_retryable') {
    return NextResponse.json(
      {
        error:
          result.attemptStatus === 'unknown'
            ? 'This delivery is still being checked. It may already have reached the customer, so it cannot be retried.'
            : 'Only a failed delivery can be retried.',
        code: 'not_retryable',
        attemptStatus: result.attemptStatus,
      },
      { status: 409 },
    )
  }
  if (result.status === 'already_retried') {
    return NextResponse.json(
      { error: 'This attempt has already been retried.', code: 'already_retried' },
      { status: 409 },
    )
  }

  try {
    const factory = container.resolve('queueFactory') as QueueFactoryLike
    await factory?.getQueue?.(CONNECT_QUEUES.outboundDispatch)?.enqueue({ reason: 'retry_wake' })
  } catch {
    /* the sweep will pick it up */
  }

  await guard.runAfterSuccess()
  return NextResponse.json(result, { status: 202 })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    POST: {
      summary: 'Retry a failed delivery attempt',
      tags: ['Connect'],
      responses: [
        { status: 202, description: 'A new attempt was queued' },
        { status: 400, description: 'Invalid identifier or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 403, description: 'Case is not assigned to you' },
        { status: 404, description: 'Case or attempt not found' },
        { status: 409, description: 'Attempt is not failed, or was already retried' },
      ],
    },
  },
}

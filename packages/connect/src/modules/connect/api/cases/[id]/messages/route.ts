import { NextResponse } from 'next/server'
import { z } from 'zod'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import { runRouteMutationGuards } from '@open-mercato/shared/lib/crud/route-mutation-guard'
import { enqueueOutbound } from '../../../../commands/enqueue-outbound'
import { inboxNotFound, resolveInboxContext } from '../../../../lib/inbox-route-context'
import { CONNECT_QUEUES } from '../../../../lib/queue'

/**
 * Enqueue an agent's reply.
 *
 * Returns 202 as soon as the reply is DURABLE, not when it is delivered: the
 * provider call happens in the hub, and a synchronous answer would either block
 * the agent on a mail server or lie about the outcome.
 *
 * The client command key is what makes a lost 202 safe. The browser keeps it
 * for the life of the draft and resends it unchanged; this route then returns
 * the original message instead of queueing a second reply to the customer.
 */

export const metadata = {
  path: '/connect/cases/[id]/messages',
  POST: {
    requireAuth: true,
    requireFeatures: ['connect.inbox.handle'],
  },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

const bodySchema = z.object({
  conversationId: z.string().uuid(),
  clientCommandKey: z.string().min(1).max(200),
  body: z.string().min(1).max(50_000),
})

type QueueFactoryLike = { getQueue?: (name: string) => { enqueue: (p: Record<string, unknown>) => Promise<unknown> } | undefined }

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid case id' }, { status: 400 })
  }

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

  const guard = await runRouteMutationGuards({
    container: container as never,
    req,
    auth: { userId: actor.userId, tenantId: actor.tenantId, organizationId: actor.organizationId },
    input: {
      resourceKind: 'connect.outbound_message',
      resourceId: id,
      operation: 'create',
      // The reply text is deliberately withheld from guards — it is the
      // customer-facing message, and guards are user-authored extension points.
      mutationPayload: { caseId: id, conversationId: body.conversationId },
    },
  })
  if (!guard.ok) return guard.response

  const result = await enqueueOutbound(container as never, {
    caseId: id,
    conversationId: body.conversationId,
    clientCommandKey: body.clientCommandKey,
    body: body.body,
    actor: { ...actor, features: [...actor.features] },
  })

  if (result.status === 'not_found') return inboxNotFound()
  if (result.status === 'forbidden') {
    return NextResponse.json(
      { error: 'You can only reply from a case assigned to you.', code: result.reason },
      { status: 403 },
    )
  }
  if (result.status === 'case_closed') {
    return NextResponse.json(
      { error: 'This case is closed. A new message from the customer opens a new case.', code: 'case_closed' },
      { status: 409 },
    )
  }
  if (result.status === 'conversation_mismatch') {
    return NextResponse.json(
      { error: 'That conversation no longer belongs to this case.', code: 'conversation_mismatch' },
      { status: 409 },
    )
  }
  if (result.status === 'fingerprint_mismatch') {
    return NextResponse.json(
      {
        error: 'This draft changed since it was first submitted. Start a new reply.',
        code: 'fingerprint_mismatch',
      },
      { status: 409 },
    )
  }
  if (result.status === 'reply_target_transient') {
    return NextResponse.json(
      { error: 'The reply address could not be checked right now. Try again shortly.', code: 'reply_target_transient' },
      { status: 503 },
    )
  }
  if (result.status === 'reply_target_unavailable') {
    return NextResponse.json(
      {
        error: 'There is no address to reply to on this conversation.',
        code: 'reply_target_unavailable',
        reason: result.reason,
      },
      { status: 422 },
    )
  }

  // Best-effort wake. The durable outbox row is the instruction; the scheduled
  // sweep dispatches it if this never runs.
  if (!result.duplicate) {
    try {
      const factory = container.resolve('queueFactory') as QueueFactoryLike
      await factory?.getQueue?.(CONNECT_QUEUES.outboundDispatch)?.enqueue({ reason: 'after_commit_wake' })
    } catch {
      /* the sweep will pick it up */
    }
  }

  await guard.runAfterSuccess()
  return NextResponse.json(
    {
      messageId: result.messageId,
      attemptId: result.attemptId,
      status: 'queued',
      duplicate: result.duplicate,
      maskedRecipientLabel: result.maskedRecipientLabel,
      updatedAt: result.updatedAt,
    },
    { status: 202 },
  )
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    POST: {
      summary: 'Queue a reply to the customer',
      tags: ['Connect'],
      responses: [
        { status: 202, description: 'Reply durably queued (or the existing one for a repeated command key)' },
        { status: 400, description: 'Invalid case id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 403, description: 'Case is not assigned to you' },
        { status: 404, description: 'Case not found' },
        { status: 409, description: 'Case closed, conversation moved, or the draft changed' },
        { status: 422, description: 'Invalid body, or no reply address on the conversation' },
        { status: 503, description: 'Reply address could not be checked; retry' },
      ],
    },
  },
}

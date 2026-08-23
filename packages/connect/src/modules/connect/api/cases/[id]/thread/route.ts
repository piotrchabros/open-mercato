import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectCase, ConnectConversation } from '../../../../data/entities'
import { computeCaseAccessEpoch, evaluateCaseAccess } from '../../../../lib/case-access'
import { inboxNotFound, resolveInboxContext } from '../../../../lib/inbox-route-context'

/**
 * Render a Case's transport thread.
 *
 * Every message body comes from Contract C, never from a Connect table: the hub
 * owns the transport conversation, and Connect only knows which conversations
 * belong to this Case. Two gates therefore run in order:
 *
 *   1. **Case authorization** — the access matrix, evaluated on the CURRENT
 *      assignment. A Case transferred away since the tab was opened returns an
 *      indistinguishable 404, and the already-open UI goes read-only.
 *   2. **Contract C** — which re-checks shared-inbox membership itself and
 *      narrows to the exact conversation allowlist Connect supplies.
 *
 * Neither gate trusts the other. The allowlist is built from Connect rows
 * scoped to this tenant, organization and Case, so a caller cannot ask for a
 * conversation belonging to someone else's Case.
 */

export const metadata = {
  path: '/connect/cases/[id]/thread',
  GET: {
    requireAuth: true,
    requireFeatures: ['connect.inbox.handle'],
  },
}

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

type ThreadReaderLike = (
  container: unknown,
  actor: { userId: string; tenantId: string; organizationId: string; features: readonly string[] },
  input: { channelId: string; externalConversationIds: string[]; pageSize?: number; cursor?: string | null },
) => Promise<Record<string, unknown>>

const querySchema = z.object({
  cursor: z.string().max(4096).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
})

export async function GET(req: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid case id' }, { status: 400 })
  }

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
  const target = await em.findOne(ConnectCase, {
    id,
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
    deletedAt: null,
  })
  if (!target) return inboxNotFound()

  // Re-evaluated on every request AND every cursor continuation, so a transfer
  // mid-read fails closed rather than continuing to feed the old owner a
  // conversation they can no longer see.
  const access = evaluateCaseAccess(target, actor)
  if (!access.canRead) return inboxNotFound()

  // A merged source owns no conversations any more, so this read would otherwise
  // return an empty thread indistinguishable from a Case awaiting its first
  // message. Naming the canonical target lets the UI send the agent to where the
  // conversation actually is instead of showing them nothing. After the access
  // check, so a caller who cannot see the Case learns nothing from the 409.
  if (target.mergedIntoCaseId) {
    return NextResponse.json(
      {
        error: 'record_conflict',
        code: 'case_merged',
        canonicalCaseId: target.mergedIntoCaseId,
        currentUpdatedAt: target.updatedAt.toISOString(),
      },
      { status: 409 },
    )
  }

  const conversations = await em.find(ConnectConversation, {
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
    currentCaseId: target.id,
  })
  if (conversations.length === 0) {
    // A Case with no bound conversation is a real state (a successor before its
    // first inbound), distinct from a thread that exists and is empty.
    return NextResponse.json({
      items: [],
      nextCursor: null,
      accessEpoch: computeCaseAccessEpoch(target),
      binding: 'missing',
    })
  }

  let reader: ThreadReaderLike
  try {
    reader = container.resolve('communicationChannelsThreadReader') as ThreadReaderLike
  } catch {
    // The reader is an optional peer from Connect's point of view; without it
    // the thread pane degrades rather than the whole Case becoming unreadable.
    return NextResponse.json(
      { error: 'The message reader is unavailable.', code: 'thread_reader_unavailable' },
      { status: 503 },
    )
  }

  const result = await reader(
    container,
    actor,
    {
      channelId: target.channelId,
      externalConversationIds: conversations.map((row) => row.externalConversationId),
      pageSize: query.pageSize,
      cursor: query.cursor ?? null,
    },
  )

  const status = (result as { status?: string }).status
  // Contract C's denial reasons are source-internal. Collapsing them to 404
  // keeps the two gates from leaking each other's detail.
  if (status === 'denied') return inboxNotFound()
  if (status === 'invalid') {
    return NextResponse.json(
      { error: 'That thread page is no longer valid.', code: 'invalid_cursor' },
      { status: 409 },
    )
  }

  return NextResponse.json({
    items: (result as { items?: unknown[] }).items ?? [],
    nextCursor: (result as { nextCursor?: string | null }).nextCursor ?? null,
    accessEpoch: computeCaseAccessEpoch(target),
    binding: 'bound',
  })
}

export const openApi = {
  tags: ['Connect'],
  methods: {
    GET: {
      summary: 'Read the transport thread bound to a case',
      tags: ['Connect'],
      responses: [
        { status: 200, description: 'Thread page' },
        { status: 400, description: 'Invalid case id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Case not found or not readable' },
        { status: 409, description: 'Cursor no longer valid, or the case is a merged historical source' },
        { status: 503, description: 'Message reader unavailable' },
      ],
    },
  },
}

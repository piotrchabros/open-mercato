import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import {
  COMMUNICATION_CHANNELS_SHARED_INBOX_GRANT_MEMBER_COMMAND_ID,
  type GrantSharedInboxMemberInput,
  type GrantSharedInboxMemberResult,
} from '../../../../../commands/shared-inbox-membership'
import { validateRouteMutationGuard } from '../../../../../lib/route-mutation-guard'
import {
  resolveSharedInboxAdminContext,
  sharedInboxDenialResponse,
} from '../../../../../lib/shared-inbox-route-context'

/**
 * Grant a user membership of a shared inbox (Connect upstream Contract E).
 *
 * Membership alone grants nothing — the member still needs
 * `communication_channels.shared_inbox.read` / `.send`. This route only ever
 * adds the membership conjunct, so an administrator cannot use it to escalate
 * their own or anyone else's feature grants.
 */

export const metadata = {
  path: '/communication_channels/shared-inboxes/[channelId]/members',
  POST: {
    requireAuth: true,
    requireFeatures: ['communication_channels.shared_inbox.manage'],
  },
}

type RouteContext = {
  params: Promise<{ channelId: string }> | { channelId: string }
}

const bodySchema = z.object({
  userId: z.string().uuid(),
})

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  const { channelId } = await context.params
  if (!z.string().uuid().safeParse(channelId).success) {
    return NextResponse.json({ error: 'Invalid channel id' }, { status: 400 })
  }

  const resolved = await resolveSharedInboxAdminContext(req)
  if (!resolved.ok) return resolved.response
  const { container, auth, actor } = resolved.context

  let body: z.infer<typeof bodySchema>
  try {
    body = bodySchema.parse(await readJsonSafe(req, null))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      { status: 422 },
    )
  }

  const guard = await validateRouteMutationGuard({
    container,
    req,
    auth: auth as never,
    input: {
      resourceKind: 'communication_channels.shared_inbox_member',
      resourceId: channelId,
      operation: 'create',
      mutationPayload: { channelId, userId: body.userId },
    },
  })
  if ('response' in guard) return guard.response

  const commandBus = container.resolve('commandBus') as CommandBus
  const input: GrantSharedInboxMemberInput = { channelId, targetUserId: body.userId, actor }
  const { result } = await commandBus.execute<
    GrantSharedInboxMemberInput,
    GrantSharedInboxMemberResult
  >(COMMUNICATION_CHANNELS_SHARED_INBOX_GRANT_MEMBER_COMMAND_ID, {
    input,
    ctx: {
      container,
      auth: auth as never,
      organizationScope: null,
      selectedOrganizationId: actor.organizationId,
      organizationIds: [actor.organizationId],
    },
  })

  if (result.status === 'forbidden' || result.status === 'not_found') {
    return sharedInboxDenialResponse()
  }
  if (result.status === 'invalid_member') {
    return NextResponse.json(
      {
        error: 'That user is not an active member of this organization.',
        code: result.reason,
      },
      { status: 422 },
    )
  }
  if (result.status === 'already_member') {
    return NextResponse.json({ membershipId: result.membershipId, alreadyMember: true }, { status: 200 })
  }

  await guard.afterSuccess()
  return NextResponse.json(
    { membershipId: result.membershipId, reactivated: result.reactivated },
    { status: 201 },
  )
}

export const openApi = {
  tags: ['CommunicationChannels'],
  methods: {
    POST: {
      summary: 'Grant a user membership of a shared inbox',
      tags: ['CommunicationChannels'],
      responses: [
        { status: 200, description: 'User was already an active member' },
        { status: 201, description: 'Membership granted' },
        { status: 400, description: 'Invalid channel id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Shared inbox not found or not administrable' },
        { status: 422, description: 'User is not an active member of the organization' },
      ],
    },
  },
}

export default POST

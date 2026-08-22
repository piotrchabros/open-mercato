import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import {
  COMMUNICATION_CHANNELS_SHARED_INBOX_REVOKE_MEMBER_COMMAND_ID,
  type RevokeSharedInboxMemberInput,
  type RevokeSharedInboxMemberResult,
} from '../../../../../commands/shared-inbox-membership'
import { validateRouteMutationGuard } from '../../../../../lib/route-mutation-guard'
import {
  resolveSharedInboxAdminContext,
  sharedInboxDenialResponse,
} from '../../../../../lib/shared-inbox-route-context'

/**
 * Revoke a user's shared-inbox membership (Connect upstream Contract E).
 *
 * The revoked user id travels in a VALIDATED BODY rather than the URL so it is
 * never captured in access logs or browser history alongside the channel id.
 *
 * Revocation is a soft transition: the row is kept with `revokedAt` /
 * `revokedByUserId` so the recovery view can show, and undo, a mistake.
 */

export const metadata = {
  path: '/communication_channels/shared-inboxes/[channelId]/members',
  DELETE: {
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

export async function DELETE(req: Request, context: RouteContext): Promise<Response> {
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
      operation: 'delete',
      mutationPayload: { channelId, userId: body.userId },
    },
  })
  if ('response' in guard) return guard.response

  const commandBus = container.resolve('commandBus') as CommandBus
  const input: RevokeSharedInboxMemberInput = { channelId, targetUserId: body.userId, actor }
  const { result } = await commandBus.execute<
    RevokeSharedInboxMemberInput,
    RevokeSharedInboxMemberResult
  >(COMMUNICATION_CHANNELS_SHARED_INBOX_REVOKE_MEMBER_COMMAND_ID, {
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
  if (result.status === 'last_manager') {
    return NextResponse.json(
      {
        error:
          'This is the last member who can manage the shared inbox. Grant another manager before revoking this one.',
        code: 'last_manager',
      },
      { status: 409 },
    )
  }
  if (result.status === 'already_revoked') {
    return NextResponse.json({ membershipId: result.membershipId, alreadyRevoked: true }, { status: 200 })
  }

  await guard.afterSuccess()
  return NextResponse.json({ membershipId: result.membershipId }, { status: 200 })
}

export const openApi = {
  tags: ['CommunicationChannels'],
  methods: {
    DELETE: {
      summary: 'Revoke a shared-inbox membership',
      tags: ['CommunicationChannels'],
      responses: [
        { status: 200, description: 'Membership revoked (or already revoked)' },
        { status: 400, description: 'Invalid channel id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Shared inbox not found or not administrable' },
        { status: 409, description: 'Refused: last member able to manage the inbox' },
      ],
    },
  },
}

export default DELETE

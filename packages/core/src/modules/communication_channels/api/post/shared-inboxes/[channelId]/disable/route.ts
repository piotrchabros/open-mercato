import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import {
  COMMUNICATION_CHANNELS_DISABLE_SHARED_INBOX_COMMAND_ID,
  type DisableSharedInboxInput,
  type DisableSharedInboxResult,
} from '../../../../../commands/shared-inbox-recovery'
import { validateRouteMutationGuard } from '../../../../../lib/route-mutation-guard'
import {
  resolveSharedInboxAdminContext,
  sharedInboxDenialResponse,
} from '../../../../../lib/shared-inbox-route-context'

/**
 * Disable a shared inbox's provider connection (Connect upstream Contract E,
 * AUTH-UP-RECOVER-01).
 *
 * Blocks new sends and claims and classifies in-flight outbound work in one
 * transaction. The response reports how much work was terminated versus left
 * unresolved so the operator knows what still needs reconciling.
 */

export const metadata = {
  path: '/communication_channels/shared-inboxes/[channelId]/disable',
  POST: {
    requireAuth: true,
    requireFeatures: ['communication_channels.shared_inbox.manage'],
  },
}

type RouteContext = {
  params: Promise<{ channelId: string }> | { channelId: string }
}

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  const { channelId } = await context.params
  if (!z.string().uuid().safeParse(channelId).success) {
    return NextResponse.json({ error: 'Invalid channel id' }, { status: 400 })
  }

  const resolved = await resolveSharedInboxAdminContext(req)
  if (!resolved.ok) return resolved.response
  const { container, auth, actor } = resolved.context

  const guard = await validateRouteMutationGuard({
    container,
    req,
    auth: auth as never,
    input: {
      resourceKind: 'communication_channels.shared_inbox',
      resourceId: channelId,
      operation: 'update',
      mutationPayload: { action: 'disable' },
    },
  })
  if ('response' in guard) return guard.response

  const commandBus = container.resolve('commandBus') as CommandBus
  const input: DisableSharedInboxInput = { channelId, actor }
  const { result } = await commandBus.execute<DisableSharedInboxInput, DisableSharedInboxResult>(
    COMMUNICATION_CHANNELS_DISABLE_SHARED_INBOX_COMMAND_ID,
    {
      input,
      ctx: {
        container,
        auth: auth as never,
        organizationScope: null,
        selectedOrganizationId: actor.organizationId,
        organizationIds: [actor.organizationId],
      },
    },
  )

  if (result.status === 'forbidden' || result.status === 'not_found') {
    return sharedInboxDenialResponse()
  }
  if (result.status === 'already_disabled') {
    return NextResponse.json({ channelId: result.channelId, alreadyDisabled: true }, { status: 200 })
  }

  await guard.afterSuccess()
  return NextResponse.json(
    {
      channelId: result.channelId,
      terminatedCount: result.terminatedCount,
      unknownCount: result.unknownCount,
    },
    { status: 200 },
  )
}

export const openApi = {
  tags: ['CommunicationChannels'],
  methods: {
    POST: {
      summary: 'Disable a shared inbox provider connection',
      tags: ['CommunicationChannels'],
      responses: [
        { status: 200, description: 'Disabled; in-flight work classified' },
        { status: 400, description: 'Invalid channel id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Shared inbox not found or not administrable' },
      ],
    },
  },
}

export default POST

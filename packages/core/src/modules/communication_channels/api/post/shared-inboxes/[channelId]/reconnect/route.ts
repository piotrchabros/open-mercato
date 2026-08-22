import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import {
  COMMUNICATION_CHANNELS_RECONNECT_SHARED_INBOX_COMMAND_ID,
  type ReconnectSharedInboxInput,
  type ReconnectSharedInboxResult,
} from '../../../../../commands/shared-inbox-recovery'
import { validateRouteMutationGuard } from '../../../../../lib/route-mutation-guard'
import {
  resolveSharedInboxAdminContext,
  sharedInboxDenialResponse,
} from '../../../../../lib/shared-inbox-route-context'

/**
 * Re-enable a disabled shared inbox (Connect upstream Contract E,
 * AUTH-UP-RECOVER-01).
 *
 * Only NEW sends become possible again. Attempts the disable terminated stay
 * terminal (an operator retries them explicitly) and attempts left `unknown`
 * stay unknown — reconnect never auto-resends work that may already have
 * reached the recipient.
 */

export const metadata = {
  path: '/communication_channels/shared-inboxes/[channelId]/reconnect',
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
      mutationPayload: { action: 'reconnect' },
    },
  })
  if ('response' in guard) return guard.response

  const commandBus = container.resolve('commandBus') as CommandBus
  const input: ReconnectSharedInboxInput = { channelId, actor }
  const { result } = await commandBus.execute<ReconnectSharedInboxInput, ReconnectSharedInboxResult>(
    COMMUNICATION_CHANNELS_RECONNECT_SHARED_INBOX_COMMAND_ID,
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
  if (result.status === 'credentials_missing') {
    return NextResponse.json(
      {
        error: 'This shared inbox has no stored credentials. Rotate or re-authorize them first.',
        code: 'credentials_missing',
      },
      { status: 409 },
    )
  }
  if (result.status === 'already_connected') {
    return NextResponse.json({ channelId: result.channelId, alreadyConnected: true }, { status: 200 })
  }

  await guard.afterSuccess()
  return NextResponse.json({ channelId: result.channelId }, { status: 200 })
}

export const openApi = {
  tags: ['CommunicationChannels'],
  methods: {
    POST: {
      summary: 'Re-enable a disabled shared inbox',
      tags: ['CommunicationChannels'],
      responses: [
        { status: 200, description: 'Reconnected' },
        { status: 400, description: 'Invalid channel id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Shared inbox not found or not administrable' },
        { status: 409, description: 'No stored credentials to reconnect with' },
      ],
    },
  },
}

export default POST

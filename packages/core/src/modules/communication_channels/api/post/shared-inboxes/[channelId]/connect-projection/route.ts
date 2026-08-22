import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import {
  COMMUNICATION_CHANNELS_ENABLE_SHARED_INBOX_CONNECT_COMMAND_ID,
  type EnableSharedInboxConnectInput,
  type EnableSharedInboxConnectResult,
} from '../../../../../commands/enable-shared-inbox-connect'
import { validateRouteMutationGuard } from '../../../../../lib/route-mutation-guard'
import {
  resolveSharedInboxAdminContext,
  sharedInboxDenialResponse,
} from '../../../../../lib/shared-inbox-route-context'

/**
 * Cut a shared inbox over to Connect-managed projection (Connect upstream
 * Contract E, AUTH-UP-02).
 *
 * Fails with the specific missing capabilities when Connect is absent or
 * incomplete, so the admin page can tell the operator what to install rather
 * than showing a generic error.
 */

export const metadata = {
  path: '/communication_channels/shared-inboxes/[channelId]/connect-projection',
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
      mutationPayload: { action: 'enable_connect_projection' },
    },
  })
  if ('response' in guard) return guard.response

  const commandBus = container.resolve('commandBus') as CommandBus
  const input: EnableSharedInboxConnectInput = { channelId, actor }
  const { result } = await commandBus.execute<
    EnableSharedInboxConnectInput,
    EnableSharedInboxConnectResult
  >(COMMUNICATION_CHANNELS_ENABLE_SHARED_INBOX_CONNECT_COMMAND_ID, {
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
  if (result.status === 'connect_unavailable') {
    return NextResponse.json(
      {
        error: 'Connect is not ready to own this inbox’s Customer timeline.',
        code: 'connect_unavailable',
        missing: result.missing,
      },
      { status: 409 },
    )
  }
  if (result.status === 'has_traffic') {
    return NextResponse.json(
      {
        error:
          'This inbox already has messages, so its projection owner is fixed. Migrating existing history is not supported.',
        code: 'has_traffic',
      },
      { status: 409 },
    )
  }
  if (result.status === 'already_enabled') {
    return NextResponse.json({ channelId: result.channelId, alreadyEnabled: true }, { status: 200 })
  }

  await guard.afterSuccess()
  return NextResponse.json({ channelId: result.channelId }, { status: 200 })
}

export const openApi = {
  tags: ['CommunicationChannels'],
  methods: {
    POST: {
      summary: 'Switch a shared inbox to Connect-managed projection',
      tags: ['CommunicationChannels'],
      responses: [
        { status: 200, description: 'Connect projection enabled' },
        { status: 400, description: 'Invalid channel id or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Shared inbox not found or not administrable' },
        { status: 409, description: 'Connect unavailable, or the inbox already has traffic' },
      ],
    },
  },
}

export default POST

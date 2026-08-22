import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import {
  COMMUNICATION_CHANNELS_ROTATE_SHARED_INBOX_CREDENTIALS_COMMAND_ID,
  type RotateSharedInboxCredentialsInput,
  type RotateSharedInboxCredentialsResult,
} from '../../../../../../commands/shared-inbox-recovery'
import { validateRouteMutationGuard } from '../../../../../../lib/route-mutation-guard'
import {
  resolveSharedInboxAdminContext,
  sharedInboxDenialResponse,
} from '../../../../../../lib/shared-inbox-route-context'

/**
 * Rotate and validate a shared inbox's stored secret (Connect upstream
 * Contract E, AUTH-UP-RECOVER-01).
 *
 * Channel identity is preserved: the mailbox address in the new credential bag
 * must match the channel's, so a rotation can never silently re-point a team's
 * inbox — with all of its history and membership — at a different address.
 *
 * The response never echoes any submitted secret.
 */

export const metadata = {
  path: '/communication_channels/shared-inboxes/[channelId]/imap/rotate',
  POST: {
    requireAuth: true,
    requireFeatures: ['communication_channels.shared_inbox.manage'],
  },
}

type RouteContext = {
  params: Promise<{ channelId: string }> | { channelId: string }
}

const bodySchema = z.object({
  credentials: z.record(z.string(), z.unknown()),
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
      resourceKind: 'communication_channels.shared_inbox',
      resourceId: channelId,
      operation: 'update',
      // The secret itself is deliberately withheld from guards.
      mutationPayload: { action: 'rotate_credentials' },
    },
  })
  if ('response' in guard) return guard.response

  const commandBus = container.resolve('commandBus') as CommandBus
  const input: RotateSharedInboxCredentialsInput = { channelId, credentials: body.credentials, actor }
  const { result } = await commandBus.execute<
    RotateSharedInboxCredentialsInput,
    RotateSharedInboxCredentialsResult
  >(COMMUNICATION_CHANNELS_ROTATE_SHARED_INBOX_CREDENTIALS_COMMAND_ID, {
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
  if (result.status === 'provider_ineligible') {
    return NextResponse.json(
      { error: 'This provider does not use rotatable stored secrets.', code: 'provider_ineligible' },
      { status: 400 },
    )
  }
  if (result.status === 'mailbox_mismatch') {
    return NextResponse.json(
      {
        error: 'The new credentials are for a different mailbox. Rotation cannot change the inbox address.',
        code: 'mailbox_mismatch',
      },
      { status: 422 },
    )
  }
  if (result.status === 'validation_failed') {
    return NextResponse.json(
      {
        error: 'Credential validation failed',
        fieldErrors: result.errors,
        ...(result.errorCodes ? { fieldErrorCodes: result.errorCodes } : {}),
      },
      { status: 422 },
    )
  }
  if (result.status === 'credentials_unavailable') {
    return NextResponse.json(
      { error: 'The rotated credentials could not be stored securely.', code: 'credentials_unavailable' },
      { status: 503 },
    )
  }

  await guard.afterSuccess()
  return NextResponse.json({ channelId: result.channelId }, { status: 200 })
}

export const openApi = {
  tags: ['CommunicationChannels'],
  methods: {
    POST: {
      summary: 'Rotate and validate a shared inbox stored secret',
      tags: ['CommunicationChannels'],
      responses: [
        { status: 200, description: 'Secret rotated' },
        { status: 400, description: 'Provider ineligible, invalid channel id, or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Shared inbox not found or not administrable' },
        { status: 422, description: 'Mailbox mismatch or credential validation failed' },
        { status: 503, description: 'Credentials could not be stored' },
      ],
    },
  },
}

export default POST

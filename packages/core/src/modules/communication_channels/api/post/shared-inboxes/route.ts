import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { CommandBus } from '@open-mercato/shared/lib/commands'
import { readJsonSafe } from '@open-mercato/shared/lib/http/readJsonSafe'
import {
  COMMUNICATION_CHANNELS_PROVISION_SHARED_INBOX_COMMAND_ID,
  type ProvisionSharedInboxInput,
  type ProvisionSharedInboxResult,
} from '../../../commands/provision-shared-inbox'
import { validateRouteMutationGuard } from '../../../lib/route-mutation-guard'
import {
  resolveSharedInboxAdminContext,
  sharedInboxDenialResponse,
} from '../../../lib/shared-inbox-route-context'

/**
 * Provision an organization-owned shared email inbox from a credential bag
 * (Connect upstream Contract E, AUTH-UP-EMAIL-01) — the IMAP-style path.
 *
 * The response never echoes any part of the submitted credentials; a validation
 * failure returns only the provider's per-field messages and codes.
 */

export const metadata = {
  path: '/communication_channels/shared-inboxes',
  POST: {
    requireAuth: true,
    requireFeatures: ['communication_channels.shared_inbox.manage'],
  },
}

const bodySchema = z.object({
  providerKey: z.string().min(1).max(64),
  displayName: z.string().min(1).max(255),
  credentials: z.record(z.string(), z.unknown()),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
})

export async function POST(req: Request): Promise<Response> {
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
      resourceId: `new:${body.providerKey}`,
      operation: 'create',
      // Deliberately omits `credentials` — a mutation guard must never see a
      // provider secret, and guards are user-authored extension points.
      mutationPayload: {
        providerKey: body.providerKey,
        displayName: body.displayName,
        pollIntervalSeconds: body.pollIntervalSeconds,
      },
    },
  })
  if ('response' in guard) return guard.response

  const commandBus = container.resolve('commandBus') as CommandBus
  const input: ProvisionSharedInboxInput = {
    providerKey: body.providerKey,
    displayName: body.displayName,
    credentials: body.credentials,
    pollIntervalSeconds: body.pollIntervalSeconds,
    actor,
  }
  const { result } = await commandBus.execute<ProvisionSharedInboxInput, ProvisionSharedInboxResult>(
    COMMUNICATION_CHANNELS_PROVISION_SHARED_INBOX_COMMAND_ID,
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

  if (result.status === 'forbidden') return sharedInboxDenialResponse()
  if (result.status === 'provider_ineligible') {
    return NextResponse.json(
      { error: 'This provider cannot back a shared inbox.', code: result.reason },
      { status: 400 },
    )
  }
  if (result.status === 'missing_mailbox_address') {
    return NextResponse.json(
      { error: 'The credentials do not identify a mailbox address.', code: 'missing_mailbox_address' },
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
      {
        error: 'The mailbox credentials could not be stored securely; nothing was created.',
        code: 'credentials_unavailable',
      },
      { status: 503 },
    )
  }
  if (result.status === 'already_provisioned') {
    return NextResponse.json(
      {
        error: 'This mailbox is already provisioned as a shared inbox in this organization.',
        code: 'already_provisioned',
      },
      { status: 409 },
    )
  }

  await guard.afterSuccess()
  return NextResponse.json(
    { channelId: result.channelId, externalIdentifier: result.externalIdentifier },
    { status: 201 },
  )
}

export const openApi = {
  tags: ['CommunicationChannels'],
  methods: {
    POST: {
      summary: 'Provision an organization-owned shared email inbox',
      tags: ['CommunicationChannels'],
      responses: [
        { status: 201, description: 'Shared inbox provisioned' },
        { status: 400, description: 'Provider is not eligible, or no organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Not authorized to administer shared inboxes' },
        { status: 409, description: 'Mailbox already provisioned in this organization' },
        { status: 422, description: 'Invalid body or credential validation failed' },
        { status: 503, description: 'Credentials could not be stored' },
      ],
    },
  },
}

export default POST

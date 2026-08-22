import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CommunicationChannel, SharedChannelMembership } from '../../../../../data/entities'
import {
  resolveSharedInboxAdminContext,
  sharedInboxDenialResponse,
} from '../../../../../lib/shared-inbox-route-context'
import { authorizeSharedInboxAdmin } from '../../../../../lib/shared-inbox-authorization'

/**
 * List a shared inbox's members — active and revoked (Connect upstream
 * Contract E, AUTH-UP-UI-01).
 *
 * Revoked rows are included deliberately: they are the recovery/audit view an
 * administrator needs after a mistaken revocation, showing who removed whom and
 * when. Membership rows are never hard-deleted, so this list is complete.
 */

export const metadata = {
  path: '/communication_channels/shared-inboxes/[channelId]/members',
  GET: {
    requireAuth: true,
    requireFeatures: ['communication_channels.shared_inbox.manage'],
  },
}

type RouteContext = {
  params: Promise<{ channelId: string }> | { channelId: string }
}

export async function GET(req: Request, context: RouteContext): Promise<Response> {
  const resolved = await resolveSharedInboxAdminContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context
  if (!authorizeSharedInboxAdmin(actor)) return sharedInboxDenialResponse()

  const { channelId } = await context.params
  const em = (container.resolve('em') as EntityManager).fork()

  const channel = await em.findOne(CommunicationChannel, {
    id: channelId,
    tenantId: actor.tenantId,
    organizationId: actor.organizationId,
    isSharedInbox: true,
    deletedAt: null,
  })
  if (!channel) return sharedInboxDenialResponse()

  const memberships = await em.find(
    SharedChannelMembership,
    {
      channelId: channel.id,
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
    },
    { orderBy: { createdAt: 'asc' } },
  )

  return NextResponse.json({
    channelId: channel.id,
    items: memberships.map((membership) => ({
      id: membership.id,
      userId: membership.userId,
      isActive: membership.isActive,
      grantedByUserId: membership.grantedByUserId ?? null,
      revokedByUserId: membership.revokedByUserId ?? null,
      revokedAt: membership.revokedAt?.toISOString() ?? null,
      createdAt: membership.createdAt.toISOString(),
      updatedAt: membership.updatedAt.toISOString(),
    })),
  })
}

export const openApi = {
  tags: ['CommunicationChannels'],
  methods: {
    GET: {
      summary: 'List shared-inbox members (including revoked, for recovery/audit)',
      tags: ['CommunicationChannels'],
      responses: [
        { status: 200, description: 'Members' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Shared inbox not found or not administrable' },
      ],
    },
  },
}

export default GET

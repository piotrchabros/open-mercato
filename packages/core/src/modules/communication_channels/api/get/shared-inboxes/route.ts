import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CommunicationChannel, SharedChannelMembership } from '../../../data/entities'
import type { ChannelAdapterRegistry } from '../../../lib/registry'
import {
  resolveSharedInboxAdminContext,
  sharedInboxDenialResponse,
} from '../../../lib/shared-inbox-route-context'
import { authorizeSharedInboxAdmin } from '../../../lib/shared-inbox-authorization'

/**
 * List the shared inboxes of the caller's organization, plus the providers that
 * are eligible to back a new one (Connect upstream Contract E, AUTH-UP-UI-01).
 *
 * Also surfaces legacy tenant-wide email channels the Contract E migration
 * classified as `email_requires_reprovision`, so the admin page can show them
 * as "disabled legacy channel — reprovision to use it as a team inbox" instead
 * of leaving an operator wondering where their mailbox went.
 *
 * Never returns provider secrets or credential references.
 */

export const metadata = {
  path: '/communication_channels/shared-inboxes',
  GET: {
    requireAuth: true,
    requireFeatures: ['communication_channels.shared_inbox.manage'],
  },
}

export async function GET(req: Request): Promise<Response> {
  const resolved = await resolveSharedInboxAdminContext(req)
  if (!resolved.ok) return resolved.response
  const { container, actor } = resolved.context
  if (!authorizeSharedInboxAdmin(actor)) return sharedInboxDenialResponse()

  const em = (container.resolve('em') as EntityManager).fork()

  const channels = await em.find(
    CommunicationChannel,
    {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      isSharedInbox: true,
      deletedAt: null,
    },
    { orderBy: { displayName: 'asc' } },
  )

  const memberCounts = new Map<string, number>()
  if (channels.length > 0) {
    const memberships = await em.find(SharedChannelMembership, {
      tenantId: actor.tenantId,
      organizationId: actor.organizationId,
      channelId: { $in: channels.map((channel) => channel.id) },
      isActive: true,
    })
    for (const membership of memberships) {
      memberCounts.set(membership.channelId, (memberCounts.get(membership.channelId) ?? 0) + 1)
    }
  }

  // Legacy tenant-wide email channels (`user_id IS NULL AND organization_id IS
  // NULL`) the migration flagged. They are tenant-scoped, so they are read
  // without the organization filter.
  const legacyEmailChannels = await em.find(CommunicationChannel, {
    tenantId: actor.tenantId,
    legacySharedClassification: 'email_requires_reprovision',
    deletedAt: null,
  })

  const registry = container.resolve('channelAdapterRegistry') as ChannelAdapterRegistry
  const eligibleProviders = registry
    .list()
    .filter((adapter) => adapter.channelType === 'email' && adapter.sharedMailbox === true)
    .map((adapter) => ({ providerKey: adapter.providerKey, channelType: adapter.channelType }))

  return NextResponse.json({
    items: channels.map((channel) => ({
      id: channel.id,
      displayName: channel.displayName,
      providerKey: channel.providerKey,
      externalIdentifier: channel.externalIdentifier ?? null,
      status: channel.status,
      isActive: channel.isActive,
      projectionMode: channel.projectionMode,
      trafficEnabled: channel.trafficEnabledAt != null,
      ownershipFrozen: channel.ownershipFrozenAt != null,
      activeMemberCount: memberCounts.get(channel.id) ?? 0,
      updatedAt: channel.updatedAt?.toISOString() ?? null,
    })),
    legacyChannels: legacyEmailChannels.map((channel) => ({
      id: channel.id,
      displayName: channel.displayName,
      providerKey: channel.providerKey,
      externalIdentifier: channel.externalIdentifier ?? null,
      classification: channel.legacySharedClassification ?? null,
    })),
    eligibleProviders,
  })
}

export const openApi = {
  tags: ['CommunicationChannels'],
  methods: {
    GET: {
      summary: 'List organization-owned shared inboxes and eligible providers',
      tags: ['CommunicationChannels'],
      responses: [
        { status: 200, description: 'Shared inboxes' },
        { status: 400, description: 'No organization selected' },
        { status: 401, description: 'Unauthorized' },
        { status: 404, description: 'Not authorized to administer shared inboxes' },
      ],
    },
  },
}

export default GET

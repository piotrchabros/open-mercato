import { CommunicationChannel, SharedChannelMembership } from '../../data/entities'
import {
  COMMUNICATION_CHANNELS_SHARED_INBOX_GRANT_MEMBER_COMMAND_ID,
  COMMUNICATION_CHANNELS_SHARED_INBOX_REVOKE_MEMBER_COMMAND_ID,
  grantSharedInboxMemberCommand,
  revokeSharedInboxMemberCommand,
} from '../shared-inbox-membership'

jest.mock('../../events', () => ({
  emitCommunicationChannelsEvent: jest.fn(async () => undefined),
}))

/**
 * Behavioural tests for the two membership mutations. They cover the rules an
 * administrator can lock themselves out with — organization membership
 * validation and last-manager protection — plus the existence masking that
 * keeps a foreign channel indistinguishable from a missing one.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const CHANNEL = '44444444-4444-4444-8444-444444444444'
const ADMIN = '55555555-5555-4555-8555-555555555555'
const TARGET = '66666666-6666-4666-8666-666666666666'
const OTHER_MEMBER = '77777777-7777-4777-8777-777777777777'

const admin = {
  userId: ADMIN,
  tenantId: TENANT,
  organizationId: ORG,
  features: ['communication_channels.shared_inbox.manage'],
  isOrganizationAdmin: true,
}

type Membership = {
  id: string
  channelId: string
  userId: string
  tenantId: string
  organizationId: string
  isActive: boolean
  revokedAt?: Date | null
  revokedByUserId?: string | null
  grantedByUserId?: string | null
}

type Fixture = {
  channel: Partial<CommunicationChannel> | null
  memberships: Membership[]
  /** Users the auth module considers active organization members. */
  organizationMembers: string[]
  /** Users effectively holding `…shared_inbox.manage`. */
  managers: string[]
}

function createCtx(fixture: Fixture) {
  const created: Membership[] = []

  const em = {
    findOne: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
      if (entity === CommunicationChannel) {
        const channel = fixture.channel
        if (!channel) return null
        return channel.id === where.id &&
          channel.tenantId === where.tenantId &&
          channel.organizationId === where.organizationId
          ? channel
          : null
      }
      if (entity === SharedChannelMembership) {
        return (
          fixture.memberships.find(
            (membership) =>
              membership.channelId === where.channelId &&
              membership.userId === where.userId &&
              membership.tenantId === where.tenantId &&
              membership.organizationId === where.organizationId,
          ) ?? null
        )
      }
      // `isActiveOrganizationMember` looks up the user row by entity name.
      if (entity === 'User') {
        const userId = where.id as string
        return fixture.organizationMembers.includes(userId) ? { id: userId, tenantId: TENANT } : null
      }
      return null
    }),
    find: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
      if (entity !== SharedChannelMembership) return []
      const excludedId = (where.id as { $ne?: string } | undefined)?.$ne
      return fixture.memberships.filter(
        (membership) =>
          membership.channelId === where.channelId &&
          membership.isActive &&
          membership.id !== excludedId,
      )
    }),
    create: jest.fn((_entity: unknown, data: Membership) => {
      const row = { id: `membership-${created.length + 1}`, ...data }
      created.push(row)
      fixture.memberships.push(row)
      return row
    }),
    flush: jest.fn(async () => undefined),
    transactional: jest.fn(async (callback: (em: unknown) => Promise<unknown>) => callback(em)),
  }

  const rbacService = {
    loadAcl: jest.fn(async (userId: string) => ({
      isSuperAdmin: false,
      features: fixture.managers.includes(userId)
        ? ['communication_channels.shared_inbox.manage']
        : [],
      organizations: fixture.organizationMembers.includes(userId) ? [ORG] : [],
    })),
  }

  return {
    ctx: {
      container: {
        resolve: (name: string) => {
          if (name === 'em') return { fork: () => em }
          if (name === 'rbacService') return rbacService
          return null
        },
      },
      auth: null,
      organizationScope: null,
      selectedOrganizationId: ORG,
      organizationIds: [ORG],
    } as never,
    em,
    created,
  }
}

function sharedChannel(overrides: Partial<CommunicationChannel> = {}): Partial<CommunicationChannel> {
  return {
    id: CHANNEL,
    tenantId: TENANT,
    organizationId: ORG,
    isSharedInbox: true,
    ownershipFrozenAt: null,
    ...overrides,
  }
}

describe('shared-inbox membership command ids', () => {
  it('exports stable canonical command ids', () => {
    expect(COMMUNICATION_CHANNELS_SHARED_INBOX_GRANT_MEMBER_COMMAND_ID).toBe(
      'communication_channels.shared_inbox.grant_member',
    )
    expect(COMMUNICATION_CHANNELS_SHARED_INBOX_REVOKE_MEMBER_COMMAND_ID).toBe(
      'communication_channels.shared_inbox.revoke_member',
    )
  })
})

describe('grantSharedInboxMemberCommand', () => {
  it('refuses a caller without organization-admin scope', async () => {
    const { ctx } = createCtx({
      channel: sharedChannel(),
      memberships: [],
      organizationMembers: [TARGET],
      managers: [ADMIN],
    })
    const result = await grantSharedInboxMemberCommand.execute(
      { channelId: CHANNEL, targetUserId: TARGET, actor: { ...admin, isOrganizationAdmin: false } },
      ctx,
    )
    expect(result).toEqual({ status: 'forbidden' })
  })

  it('grants membership and freezes ownership on the first member', async () => {
    const channel = sharedChannel()
    const { ctx, created } = createCtx({
      channel,
      memberships: [],
      organizationMembers: [TARGET],
      managers: [ADMIN],
    })
    const result = await grantSharedInboxMemberCommand.execute(
      { channelId: CHANNEL, targetUserId: TARGET, actor: admin },
      ctx,
    )
    expect(result).toMatchObject({ status: 'granted', reactivated: false })
    expect(created).toHaveLength(1)
    // The first membership makes the owning organization immutable.
    expect(channel.ownershipFrozenAt).toBeInstanceOf(Date)
  })

  it('rejects a user who is not an active member of the organization', async () => {
    const { ctx, created } = createCtx({
      channel: sharedChannel(),
      memberships: [],
      organizationMembers: [],
      managers: [ADMIN],
    })
    const result = await grantSharedInboxMemberCommand.execute(
      { channelId: CHANNEL, targetUserId: TARGET, actor: admin },
      ctx,
    )
    expect(result).toEqual({ status: 'invalid_member', reason: 'not_in_organization' })
    expect(created).toHaveLength(0)
  })

  it('reactivates a revoked membership in place instead of inserting a duplicate', async () => {
    const revoked: Membership = {
      id: 'membership-existing',
      channelId: CHANNEL,
      userId: TARGET,
      tenantId: TENANT,
      organizationId: ORG,
      isActive: false,
      revokedAt: new Date(),
      revokedByUserId: ADMIN,
    }
    const { ctx, created } = createCtx({
      channel: sharedChannel(),
      memberships: [revoked],
      organizationMembers: [TARGET],
      managers: [ADMIN],
    })
    const result = await grantSharedInboxMemberCommand.execute(
      { channelId: CHANNEL, targetUserId: TARGET, actor: admin },
      ctx,
    )
    expect(result).toEqual({ status: 'granted', membershipId: 'membership-existing', reactivated: true })
    expect(created).toHaveLength(0)
    expect(revoked.isActive).toBe(true)
    expect(revoked.revokedAt).toBeNull()
  })

  it('masks a channel outside the caller scope as not_found', async () => {
    const { ctx } = createCtx({
      channel: sharedChannel({ organizationId: 'other-org' }),
      memberships: [],
      organizationMembers: [TARGET],
      managers: [ADMIN],
    })
    const result = await grantSharedInboxMemberCommand.execute(
      { channelId: CHANNEL, targetUserId: TARGET, actor: admin },
      ctx,
    )
    expect(result).toEqual({ status: 'not_found' })
  })
})

describe('revokeSharedInboxMemberCommand', () => {
  function membership(userId: string, id: string, isActive = true): Membership {
    return {
      id,
      channelId: CHANNEL,
      userId,
      tenantId: TENANT,
      organizationId: ORG,
      isActive,
    }
  }

  it('revokes a non-manager member', async () => {
    const target = membership(TARGET, 'membership-target')
    const { ctx } = createCtx({
      channel: sharedChannel(),
      memberships: [target, membership(OTHER_MEMBER, 'membership-other')],
      organizationMembers: [TARGET, OTHER_MEMBER],
      managers: [OTHER_MEMBER],
    })
    const result = await revokeSharedInboxMemberCommand.execute(
      { channelId: CHANNEL, targetUserId: TARGET, actor: admin },
      ctx,
    )
    expect(result).toEqual({ status: 'revoked', membershipId: 'membership-target' })
    expect(target.isActive).toBe(false)
    expect(target.revokedByUserId).toBe(ADMIN)
  })

  // Without this, an administrator can leave a team inbox that nobody is able
  // to administer — no member add, no reconnect, no disable.
  it('refuses to revoke the last member who can manage the inbox', async () => {
    const onlyManager = membership(TARGET, 'membership-target')
    const { ctx } = createCtx({
      channel: sharedChannel(),
      memberships: [onlyManager, membership(OTHER_MEMBER, 'membership-other')],
      organizationMembers: [TARGET, OTHER_MEMBER],
      managers: [TARGET],
    })
    const result = await revokeSharedInboxMemberCommand.execute(
      { channelId: CHANNEL, targetUserId: TARGET, actor: admin },
      ctx,
    )
    expect(result).toEqual({ status: 'last_manager' })
    expect(onlyManager.isActive).toBe(true)
  })

  it('allows revoking a manager while another manager remains', async () => {
    const target = membership(TARGET, 'membership-target')
    const { ctx } = createCtx({
      channel: sharedChannel(),
      memberships: [target, membership(OTHER_MEMBER, 'membership-other')],
      organizationMembers: [TARGET, OTHER_MEMBER],
      managers: [TARGET, OTHER_MEMBER],
    })
    const result = await revokeSharedInboxMemberCommand.execute(
      { channelId: CHANNEL, targetUserId: TARGET, actor: admin },
      ctx,
    )
    expect(result).toEqual({ status: 'revoked', membershipId: 'membership-target' })
    expect(target.isActive).toBe(false)
  })

  it('is idempotent for an already revoked member', async () => {
    const { ctx } = createCtx({
      channel: sharedChannel(),
      memberships: [membership(TARGET, 'membership-target', false)],
      organizationMembers: [TARGET],
      managers: [ADMIN],
    })
    const result = await revokeSharedInboxMemberCommand.execute(
      { channelId: CHANNEL, targetUserId: TARGET, actor: admin },
      ctx,
    )
    expect(result).toEqual({ status: 'already_revoked', membershipId: 'membership-target' })
  })

  it('refuses a caller without the manage feature', async () => {
    const { ctx } = createCtx({
      channel: sharedChannel(),
      memberships: [membership(TARGET, 'membership-target')],
      organizationMembers: [TARGET],
      managers: [],
    })
    const result = await revokeSharedInboxMemberCommand.execute(
      { channelId: CHANNEL, targetUserId: TARGET, actor: { ...admin, features: [] } },
      ctx,
    )
    expect(result).toEqual({ status: 'forbidden' })
  })
})

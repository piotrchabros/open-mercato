import type { EntityManager } from '@mikro-orm/postgresql'
import { CommunicationChannel, SharedChannelMembership } from '../../data/entities'
import {
  SHARED_INBOX_MANAGE_FEATURE,
  SHARED_INBOX_READ_FEATURE,
  SHARED_INBOX_SEND_FEATURE,
  authorizeSharedInbox,
  authorizeSharedInboxAdmin,
} from '../shared-inbox-authorization'

/**
 * Contract E authorization is the conjunction of scope + active membership +
 * feature. These tests pin every way that conjunction can fail, and pin the
 * existence masking that keeps a foreign channel id indistinguishable from a
 * missing one.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999'
const ORG = '22222222-2222-4222-8222-222222222222'
const SIBLING_ORG = '33333333-3333-4333-8333-333333333333'
const CHANNEL = '44444444-4444-4444-8444-444444444444'
const USER = '55555555-5555-4555-8555-555555555555'

type ChannelSeed = Partial<CommunicationChannel>
type MembershipSeed = Partial<SharedChannelMembership>

/**
 * Minimal EntityManager stand-in that answers the two `findOne` calls the
 * authorization path makes, applying the same equality filters MikroORM would.
 */
function createEm(options: {
  channel?: ChannelSeed | null
  membership?: MembershipSeed | null
}): EntityManager {
  const findOne = jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
    if (entity === CommunicationChannel) {
      const channel = options.channel
      if (!channel) return null
      const matches =
        channel.id === where.id &&
        channel.tenantId === where.tenantId &&
        channel.organizationId === where.organizationId &&
        channel.isSharedInbox === where.isSharedInbox
      return matches ? channel : null
    }
    if (entity === SharedChannelMembership) {
      const membership = options.membership
      if (!membership) return null
      const matches =
        membership.channelId === where.channelId &&
        membership.userId === where.userId &&
        membership.tenantId === where.tenantId &&
        membership.organizationId === where.organizationId
      return matches ? membership : null
    }
    return null
  })
  return { findOne } as unknown as EntityManager
}

function sharedChannel(overrides: ChannelSeed = {}): ChannelSeed {
  return {
    id: CHANNEL,
    tenantId: TENANT,
    organizationId: ORG,
    isSharedInbox: true,
    isActive: true,
    status: 'connected',
    projectionMode: 'legacy_customers',
    providerKey: 'imap',
    channelType: 'email',
    trafficEnabledAt: null,
    ...overrides,
  }
}

function activeMembership(overrides: MembershipSeed = {}): MembershipSeed {
  return {
    id: 'membership-1',
    channelId: CHANNEL,
    userId: USER,
    tenantId: TENANT,
    organizationId: ORG,
    isActive: true,
    ...overrides,
  }
}

const actor = {
  userId: USER,
  tenantId: TENANT,
  organizationId: ORG,
  features: [SHARED_INBOX_READ_FEATURE],
}

describe('authorizeSharedInbox', () => {
  it('authorizes a member holding the required feature in the owning scope', async () => {
    const em = createEm({ channel: sharedChannel(), membership: activeMembership() })
    const result = await authorizeSharedInbox(em, CHANNEL, actor, SHARED_INBOX_READ_FEATURE)
    expect(result.ok).toBe(true)
  })

  it('honors a wildcard grant rather than string-matching the feature id', async () => {
    const em = createEm({ channel: sharedChannel(), membership: activeMembership() })
    const result = await authorizeSharedInbox(
      em,
      CHANNEL,
      { ...actor, features: ['communication_channels.*'] },
      SHARED_INBOX_SEND_FEATURE,
    )
    expect(result.ok).toBe(true)
  })

  it('denies a member who does not hold the required feature', async () => {
    const em = createEm({ channel: sharedChannel(), membership: activeMembership() })
    const result = await authorizeSharedInbox(em, CHANNEL, actor, SHARED_INBOX_SEND_FEATURE)
    expect(result).toEqual({ ok: false, reason: 'missing_feature' })
  })

  it('denies a feature holder who is not a member', async () => {
    const em = createEm({ channel: sharedChannel(), membership: null })
    const result = await authorizeSharedInbox(em, CHANNEL, actor, SHARED_INBOX_READ_FEATURE)
    expect(result).toEqual({ ok: false, reason: 'not_a_member' })
  })

  it('denies a revoked member', async () => {
    const em = createEm({
      channel: sharedChannel(),
      membership: activeMembership({ isActive: false }),
    })
    const result = await authorizeSharedInbox(em, CHANNEL, actor, SHARED_INBOX_READ_FEATURE)
    expect(result).toEqual({ ok: false, reason: 'not_a_member' })
  })

  // Existence masking: a sibling organization, another tenant, and a personal
  // mailbox must all be indistinguishable from "no such channel".
  it('masks a channel owned by a sibling organization as not_found', async () => {
    const em = createEm({
      channel: sharedChannel({ organizationId: SIBLING_ORG }),
      membership: activeMembership(),
    })
    const result = await authorizeSharedInbox(em, CHANNEL, actor, SHARED_INBOX_READ_FEATURE)
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('masks a channel owned by another tenant as not_found', async () => {
    const em = createEm({
      channel: sharedChannel({ tenantId: OTHER_TENANT }),
      membership: activeMembership(),
    })
    const result = await authorizeSharedInbox(em, CHANNEL, actor, SHARED_INBOX_READ_FEATURE)
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('masks a non-shared (personal or legacy tenant-wide) channel as not_found', async () => {
    const em = createEm({
      channel: sharedChannel({ isSharedInbox: false }),
      membership: activeMembership(),
    })
    const result = await authorizeSharedInbox(em, CHANNEL, actor, SHARED_INBOX_READ_FEATURE)
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('denies an authorized member on a disabled channel', async () => {
    const em = createEm({
      channel: sharedChannel({ isActive: false, status: 'disconnected' }),
      membership: activeMembership(),
    })
    const result = await authorizeSharedInbox(em, CHANNEL, actor, SHARED_INBOX_READ_FEATURE)
    expect(result).toEqual({ ok: false, reason: 'channel_disabled' })
  })

  // A Connect-managed channel that has not been cut over yet has no live
  // projection owner, so traffic-bearing callers must be refused.
  it('refuses traffic on a connect_managed channel before cutover', async () => {
    const em = createEm({
      channel: sharedChannel({ projectionMode: 'connect_managed', trafficEnabledAt: null }),
      membership: activeMembership(),
    })
    const result = await authorizeSharedInbox(
      em,
      CHANNEL,
      { ...actor, features: [SHARED_INBOX_SEND_FEATURE] },
      SHARED_INBOX_SEND_FEATURE,
      { requireTrafficEnabled: true },
    )
    expect(result).toEqual({ ok: false, reason: 'traffic_not_enabled' })
  })

  it('allows traffic once the channel has been cut over', async () => {
    const em = createEm({
      channel: sharedChannel({ projectionMode: 'connect_managed', trafficEnabledAt: new Date() }),
      membership: activeMembership(),
    })
    const result = await authorizeSharedInbox(
      em,
      CHANNEL,
      { ...actor, features: [SHARED_INBOX_SEND_FEATURE] },
      SHARED_INBOX_SEND_FEATURE,
      { requireTrafficEnabled: true },
    )
    expect(result.ok).toBe(true)
  })

  // A legacy-mode shared inbox is unaffected by the Connect traffic gate.
  it('does not apply the traffic gate to a legacy_customers channel', async () => {
    const em = createEm({ channel: sharedChannel(), membership: activeMembership() })
    const result = await authorizeSharedInbox(
      em,
      CHANNEL,
      { ...actor, features: [SHARED_INBOX_SEND_FEATURE] },
      SHARED_INBOX_SEND_FEATURE,
      { requireTrafficEnabled: true },
    )
    expect(result.ok).toBe(true)
  })
})

describe('authorizeSharedInboxAdmin', () => {
  it('requires both organization-admin scope and the manage feature', () => {
    expect(
      authorizeSharedInboxAdmin({ features: [SHARED_INBOX_MANAGE_FEATURE], isOrganizationAdmin: true }),
    ).toBe(true)
  })

  it('denies a manage-feature holder who is not an organization admin', () => {
    expect(
      authorizeSharedInboxAdmin({ features: [SHARED_INBOX_MANAGE_FEATURE], isOrganizationAdmin: false }),
    ).toBe(false)
  })

  it('denies an organization admin who lacks the manage feature', () => {
    expect(
      authorizeSharedInboxAdmin({ features: [SHARED_INBOX_READ_FEATURE], isOrganizationAdmin: true }),
    ).toBe(false)
  })

  it('accepts a wildcard manage grant', () => {
    expect(authorizeSharedInboxAdmin({ features: ['*'], isOrganizationAdmin: true })).toBe(true)
  })
})

import type { EntityManager } from '@mikro-orm/postgresql'
import { CommunicationChannel, SharedChannelMembership } from '../../data/entities'
import { isSharedSendStillAuthorized } from '../shared-send-authorization'

/**
 * A queued send can sit for minutes. Re-checking authority immediately before
 * the provider call is what stops a revoked member's mail from still going out
 * under the organization's address.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const CHANNEL = '44444444-4444-4444-8444-444444444444'
const USER = '55555555-5555-4555-8555-555555555555'

type Fixture = {
  membershipActive?: boolean
  features?: string[]
  isSuperAdmin?: boolean
  rbacThrows?: boolean
  channel?: Partial<CommunicationChannel>
}

function createEm(fixture: Fixture): EntityManager {
  const channel: Partial<CommunicationChannel> = {
    id: CHANNEL,
    tenantId: TENANT,
    organizationId: ORG,
    isSharedInbox: true,
    isActive: true,
    status: 'connected',
    projectionMode: 'connect_managed',
    trafficEnabledAt: new Date(),
    ...fixture.channel,
  }
  return {
    findOne: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
      if (entity === CommunicationChannel) {
        return channel.id === where.id &&
          channel.tenantId === where.tenantId &&
          channel.organizationId === where.organizationId
          ? channel
          : null
      }
      if (entity === SharedChannelMembership) {
        if (fixture.membershipActive === undefined) return null
        return {
          id: 'membership-1',
          channelId: CHANNEL,
          userId: USER,
          tenantId: TENANT,
          organizationId: ORG,
          isActive: fixture.membershipActive,
        }
      }
      return null
    }),
  } as unknown as EntityManager
}

function createContainer(fixture: Fixture) {
  return {
    resolve: (name: string) => {
      if (name !== 'rbacService') return null
      return {
        loadAcl: jest.fn(async () => {
          if (fixture.rbacThrows) throw new Error('[internal] rbac unavailable')
          return {
            isSuperAdmin: fixture.isSuperAdmin ?? false,
            features: fixture.features ?? [],
            organizations: [ORG],
          }
        }),
      }
    },
  }
}

const channelRef = { id: CHANNEL, tenantId: TENANT, organizationId: ORG }

describe('isSharedSendStillAuthorized', () => {
  it('allows a still-authorized member', async () => {
    const fixture: Fixture = {
      membershipActive: true,
      features: ['communication_channels.shared_inbox.send'],
    }
    await expect(
      isSharedSendStillAuthorized(createContainer(fixture), createEm(fixture), channelRef, USER),
    ).resolves.toBe(true)
  })

  it('refuses a member revoked between enqueue and dispatch', async () => {
    const fixture: Fixture = {
      membershipActive: false,
      features: ['communication_channels.shared_inbox.send'],
    }
    await expect(
      isSharedSendStillAuthorized(createContainer(fixture), createEm(fixture), channelRef, USER),
    ).resolves.toBe(false)
  })

  it('refuses an actor whose send feature was withdrawn', async () => {
    const fixture: Fixture = { membershipActive: true, features: [] }
    await expect(
      isSharedSendStillAuthorized(createContainer(fixture), createEm(fixture), channelRef, USER),
    ).resolves.toBe(false)
  })

  // A Connect-managed channel whose cutover was rolled back has no live
  // projection owner, so its queued mail must not go out.
  it('refuses a connect_managed channel whose traffic was disabled', async () => {
    const fixture: Fixture = {
      membershipActive: true,
      features: ['communication_channels.shared_inbox.send'],
      channel: { trafficEnabledAt: null },
    }
    await expect(
      isSharedSendStillAuthorized(createContainer(fixture), createEm(fixture), channelRef, USER),
    ).resolves.toBe(false)
  })

  it('refuses a channel disabled between enqueue and dispatch', async () => {
    const fixture: Fixture = {
      membershipActive: true,
      features: ['communication_channels.shared_inbox.send'],
      channel: { isActive: false, status: 'disconnected' },
    }
    await expect(
      isSharedSendStillAuthorized(createContainer(fixture), createEm(fixture), channelRef, USER),
    ).resolves.toBe(false)
  })

  // Fail closed: an unresolvable ACL means we cannot prove the revocation did
  // NOT happen, and a refused send is recoverable while a wrongly-sent one is not.
  it('refuses the send when the actor\'s grants cannot be resolved', async () => {
    const fixture: Fixture = { membershipActive: true, rbacThrows: true }
    await expect(
      isSharedSendStillAuthorized(createContainer(fixture), createEm(fixture), channelRef, USER),
    ).resolves.toBe(false)
  })

  it('refuses a shared channel with no owning organization', async () => {
    const fixture: Fixture = {
      membershipActive: true,
      features: ['communication_channels.shared_inbox.send'],
    }
    await expect(
      isSharedSendStillAuthorized(
        createContainer(fixture),
        createEm(fixture),
        { id: CHANNEL, tenantId: TENANT, organizationId: null },
        USER,
      ),
    ).resolves.toBe(false)
  })
})

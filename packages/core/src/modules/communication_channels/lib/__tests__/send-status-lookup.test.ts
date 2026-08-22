import type { EntityManager } from '@mikro-orm/postgresql'
import { ChannelDeliveryAttempt, CommunicationChannel, SharedChannelMembership } from '../../data/entities'
import { lookupSendStatus } from '../send-status-lookup'

jest.mock('../adapter-registry-singleton', () => ({
  getChannelAdapter: jest.fn(),
}))

import { getChannelAdapter } from '../adapter-registry-singleton'

const mockGetAdapter = getChannelAdapter as jest.MockedFunction<typeof getChannelAdapter>

/**
 * The lookup is the sanctioned alternative to "resend and find out". It must
 * therefore be readable by exactly the actors who could have sent, and must
 * leak nothing about correlations that are not theirs.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999'
const ORG = '22222222-2222-4222-8222-222222222222'
const CHANNEL = '44444444-4444-4444-8444-444444444444'
const USER = '55555555-5555-4555-8555-555555555555'
const OTHER_USER = '66666666-6666-4666-8666-666666666666'

type Fixture = {
  channel?: Partial<CommunicationChannel> | null
  membership?: Partial<SharedChannelMembership> | null
  attempt?: Partial<ChannelDeliveryAttempt> | null
}

function createContainer(fixture: Fixture) {
  const em = {
    findOne: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
      if (entity === CommunicationChannel) {
        const channel = fixture.channel
        if (!channel) return null
        return channel.id === where.id && channel.tenantId === where.tenantId ? channel : null
      }
      if (entity === SharedChannelMembership) {
        const membership = fixture.membership
        if (!membership) return null
        return membership.channelId === where.channelId && membership.userId === where.userId
          ? membership
          : null
      }
      if (entity === ChannelDeliveryAttempt) {
        const attempt = fixture.attempt
        if (!attempt) return null
        return attempt.channelId === where.channelId &&
          attempt.tenantId === where.tenantId &&
          attempt.correlationId === where.correlationId
          ? attempt
          : null
      }
      return null
    }),
  }
  return {
    resolve: (name: string) => (name === 'em' ? { fork: () => em } : null),
  }
}

function personalChannel(overrides: Partial<CommunicationChannel> = {}): Partial<CommunicationChannel> {
  return {
    id: CHANNEL,
    tenantId: TENANT,
    organizationId: ORG,
    providerKey: 'gmail',
    isSharedInbox: false,
    userId: USER,
    ...overrides,
  }
}

function sentAttempt(overrides: Partial<ChannelDeliveryAttempt> = {}): Partial<ChannelDeliveryAttempt> {
  return {
    id: 'attempt-1',
    tenantId: TENANT,
    organizationId: ORG,
    channelId: CHANNEL,
    correlationId: 'corr-1',
    attemptId: 'att-1',
    status: 'sent',
    deliveryRevision: 1,
    providerMessageId: 'provider-1',
    occurredAt: new Date('2026-08-22T10:00:00Z'),
    ...overrides,
  }
}

const actor = { userId: USER, tenantId: TENANT, organizationId: ORG, features: [] as string[] }
const lookupInput = { channelId: CHANNEL, correlationId: 'corr-1', attemptId: 'att-1' }

beforeEach(() => {
  mockGetAdapter.mockReset()
  mockGetAdapter.mockReturnValue({ getStatus: jest.fn() } as never)
})

describe('lookupSendStatus', () => {
  it('returns a conclusive sent outcome to the channel owner', async () => {
    const container = createContainer({ channel: personalChannel(), attempt: sentAttempt() })
    const result = await lookupSendStatus(container, actor, lookupInput)
    expect(result).toMatchObject({
      status: 'sent',
      correlationId: 'corr-1',
      attemptId: 'att-1',
      deliveryRevision: 1,
      providerMessageId: 'provider-1',
      providerEvidence: 'supported',
    })
  })

  // An in-flight send and an unresolvable one are the same answer to the
  // caller: do not resend, ask again later.
  it('reports a still-pending attempt as unknown', async () => {
    const container = createContainer({
      channel: personalChannel(),
      attempt: sentAttempt({ status: 'pending', providerMessageId: null }),
    })
    const result = await lookupSendStatus(container, actor, lookupInput)
    expect(result).toMatchObject({ status: 'unknown' })
  })

  it('reports whether the provider can corroborate an indeterminate send', async () => {
    mockGetAdapter.mockReturnValue({} as never)
    const container = createContainer({
      channel: personalChannel(),
      attempt: sentAttempt({ status: 'unknown' }),
    })
    const result = await lookupSendStatus(container, actor, lookupInput)
    expect(result).toMatchObject({ status: 'unknown', providerEvidence: 'unsupported' })
  })

  it('never exposes another user\'s personal mailbox', async () => {
    const container = createContainer({
      channel: personalChannel({ userId: OTHER_USER }),
      attempt: sentAttempt(),
    })
    const result = await lookupSendStatus(container, actor, lookupInput)
    expect(result).toEqual({ status: 'not_found' })
  })

  it('never crosses a tenant boundary', async () => {
    const container = createContainer({
      channel: personalChannel({ tenantId: OTHER_TENANT }),
      attempt: sentAttempt(),
    })
    const result = await lookupSendStatus(container, actor, lookupInput)
    expect(result).toEqual({ status: 'not_found' })
  })

  // Telling a caller "that correlation exists, but the attempt is not yours" is
  // itself an information leak, so it reads as missing.
  it('masks a correlation bound to a different attempt as missing', async () => {
    const container = createContainer({
      channel: personalChannel(),
      attempt: sentAttempt({ attemptId: 'att-other' }),
    })
    const result = await lookupSendStatus(container, actor, lookupInput)
    expect(result).toEqual({ status: 'not_found' })
  })

  it('masks an unknown correlation as missing', async () => {
    const container = createContainer({ channel: personalChannel(), attempt: null })
    const result = await lookupSendStatus(container, actor, lookupInput)
    expect(result).toEqual({ status: 'not_found' })
  })

  describe('shared inboxes', () => {
    function sharedChannel(overrides: Partial<CommunicationChannel> = {}) {
      return personalChannel({
        isSharedInbox: true,
        userId: null,
        isActive: true,
        status: 'connected',
        projectionMode: 'legacy_customers',
        ...overrides,
      })
    }

    // Authorization mirrors the send path exactly, so a revoked member loses
    // read access to the outcome at the same moment they lose the right to send.
    it('requires active membership and the send feature', async () => {
      const container = createContainer({
        channel: sharedChannel(),
        membership: { channelId: CHANNEL, userId: USER, tenantId: TENANT, organizationId: ORG, isActive: true },
        attempt: sentAttempt(),
      })
      const authorized = await lookupSendStatus(
        container,
        { ...actor, features: ['communication_channels.shared_inbox.send'] },
        lookupInput,
      )
      expect(authorized).toMatchObject({ status: 'sent' })

      const withoutFeature = await lookupSendStatus(container, actor, lookupInput)
      expect(withoutFeature).toEqual({ status: 'not_found' })
    })

    it('refuses a revoked member', async () => {
      const container = createContainer({
        channel: sharedChannel(),
        membership: { channelId: CHANNEL, userId: USER, tenantId: TENANT, organizationId: ORG, isActive: false },
        attempt: sentAttempt(),
      })
      const result = await lookupSendStatus(
        container,
        { ...actor, features: ['communication_channels.shared_inbox.send'] },
        lookupInput,
      )
      expect(result).toEqual({ status: 'not_found' })
    })

    it('refuses a caller with no selected organization', async () => {
      const container = createContainer({ channel: sharedChannel(), attempt: sentAttempt() })
      const result = await lookupSendStatus(
        container,
        { ...actor, organizationId: null, features: ['communication_channels.shared_inbox.send'] },
        lookupInput,
      )
      expect(result).toEqual({ status: 'not_found' })
    })
  })
})

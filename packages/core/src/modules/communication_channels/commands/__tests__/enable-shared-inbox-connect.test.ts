import { CommunicationChannel, ExternalMessage } from '../../data/entities'
import { CONNECT_CAPABILITY_CONTRACT_VERSION } from '../../lib/connect-capability'
import enableSharedInboxConnectCommand, {
  COMMUNICATION_CHANNELS_ENABLE_SHARED_INBOX_CONNECT_COMMAND_ID,
} from '../enable-shared-inbox-connect'

jest.mock('../../events', () => ({
  emitCommunicationChannelsEvent: jest.fn(async () => undefined),
}))

/**
 * The cutover is the moment a channel's Customer timeline changes owner. It has
 * to be impossible to perform it without a live projection owner, and
 * impossible to perform it on a channel whose history was already projected by
 * the previous owner.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const CHANNEL = '44444444-4444-4444-8444-444444444444'
const ADMIN = '55555555-5555-4555-8555-555555555555'

const admin = {
  userId: ADMIN,
  tenantId: TENANT,
  organizationId: ORG,
  features: ['communication_channels.shared_inbox.manage'],
  isOrganizationAdmin: true,
}

function fullReport() {
  return {
    contractVersion: CONNECT_CAPABILITY_CONTRACT_VERSION,
    ingestActive: true,
    inboundEnvelopeContract: true,
    customerProjection: true,
    recoverySchedulesRegistered: true,
  }
}

function createCtx(options: {
  channel: Partial<CommunicationChannel> | null
  messageCount?: number
  reporter?: unknown
}) {
  const em = {
    findOne: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
      if (entity !== CommunicationChannel || !options.channel) return null
      const channel = options.channel
      return channel.id === where.id &&
        channel.tenantId === where.tenantId &&
        channel.organizationId === where.organizationId
        ? channel
        : null
    }),
    count: jest.fn(async (entity: unknown) =>
      entity === ExternalMessage ? (options.messageCount ?? 0) : 0,
    ),
    flush: jest.fn(async () => undefined),
    transactional: jest.fn(async (callback: (em: unknown) => Promise<unknown>) => callback(em)),
  }
  return {
    ctx: {
      container: {
        hasRegistration: (name: string) =>
          name === 'connectCapabilityReporter' && options.reporter !== undefined,
        resolve: (name: string) => {
          if (name === 'em') return { fork: () => em }
          if (name === 'connectCapabilityReporter') return options.reporter
          return null
        },
      },
      auth: null,
      organizationScope: null,
      selectedOrganizationId: ORG,
      organizationIds: [ORG],
    } as never,
    em,
  }
}

function sharedChannel(overrides: Partial<CommunicationChannel> = {}): Partial<CommunicationChannel> {
  return {
    id: CHANNEL,
    tenantId: TENANT,
    organizationId: ORG,
    isSharedInbox: true,
    projectionMode: 'legacy_customers',
    trafficEnabledAt: null,
    ownershipFrozenAt: null,
    ...overrides,
  }
}

describe('enableSharedInboxConnectCommand', () => {
  it('exports the stable canonical command id', () => {
    expect(COMMUNICATION_CHANNELS_ENABLE_SHARED_INBOX_CONNECT_COMMAND_ID).toBe(
      'communication_channels.shared_inbox.enable_connect',
    )
    expect(enableSharedInboxConnectCommand.id).toBe(
      COMMUNICATION_CHANNELS_ENABLE_SHARED_INBOX_CONNECT_COMMAND_ID,
    )
  })

  it('refuses a caller without shared-inbox administration', async () => {
    const { ctx } = createCtx({
      channel: sharedChannel(),
      reporter: { describeCapabilities: async () => fullReport() },
    })
    const result = await enableSharedInboxConnectCommand.execute(
      { channelId: CHANNEL, actor: { ...admin, isOrganizationAdmin: false } },
      ctx,
    )
    expect(result).toEqual({ status: 'forbidden' })
  })

  // Without a live projection owner the channel's traffic would be projected by
  // nobody, and the loss would be silent.
  it('refuses the cutover when Connect is not installed', async () => {
    const { ctx, em } = createCtx({ channel: sharedChannel() })
    const result = await enableSharedInboxConnectCommand.execute(
      { channelId: CHANNEL, actor: admin },
      ctx,
    )
    expect(result).toEqual({ status: 'connect_unavailable', missing: ['connect_not_installed'] })
    // The handshake fails before the channel is even loaded.
    expect(em.transactional).not.toHaveBeenCalled()
  })

  it('names the missing capabilities so the operator knows what to install', async () => {
    const { ctx } = createCtx({
      channel: sharedChannel(),
      reporter: {
        describeCapabilities: async () => ({ ...fullReport(), recoverySchedulesRegistered: false }),
      },
    })
    const result = await enableSharedInboxConnectCommand.execute(
      { channelId: CHANNEL, actor: admin },
      ctx,
    )
    expect(result).toEqual({
      status: 'connect_unavailable',
      missing: ['connect_recovery_schedules'],
    })
  })

  it('flips mode and traffic together and records the verified handshake', async () => {
    const channel = sharedChannel()
    const { ctx } = createCtx({
      channel,
      reporter: { describeCapabilities: async () => fullReport() },
    })
    const result = await enableSharedInboxConnectCommand.execute(
      { channelId: CHANNEL, actor: admin },
      ctx,
    )

    expect(result).toEqual({ status: 'enabled', channelId: CHANNEL })
    expect(channel.projectionMode).toBe('connect_managed')
    // Mode and traffic enablement are set together, so the channel is never
    // observable as Connect-managed-but-unprojected.
    expect(channel.trafficEnabledAt).toBeInstanceOf(Date)
    expect(channel.ownershipFrozenAt).toBeInstanceOf(Date)
    expect(channel.connectCapabilitySnapshot).toMatchObject({
      contractVersion: CONNECT_CAPABILITY_CONTRACT_VERSION,
      verifiedByUserId: ADMIN,
    })
  })

  // Projection mode is immutable once the channel has traffic: the existing
  // history was already projected by the legacy owner.
  it('refuses a channel that already has messages', async () => {
    const channel = sharedChannel()
    const { ctx } = createCtx({
      channel,
      messageCount: 1,
      reporter: { describeCapabilities: async () => fullReport() },
    })
    const result = await enableSharedInboxConnectCommand.execute(
      { channelId: CHANNEL, actor: admin },
      ctx,
    )
    expect(result).toEqual({ status: 'has_traffic' })
    expect(channel.projectionMode).toBe('legacy_customers')
  })

  it('is idempotent once the channel is already cut over', async () => {
    const channel = sharedChannel({
      projectionMode: 'connect_managed',
      trafficEnabledAt: new Date(),
    })
    const { ctx } = createCtx({
      channel,
      reporter: { describeCapabilities: async () => fullReport() },
    })
    const result = await enableSharedInboxConnectCommand.execute(
      { channelId: CHANNEL, actor: admin },
      ctx,
    )
    expect(result).toEqual({ status: 'already_enabled', channelId: CHANNEL })
  })

  it('masks a channel outside the caller scope as not_found', async () => {
    const { ctx } = createCtx({
      channel: sharedChannel({ organizationId: 'other-org' }),
      reporter: { describeCapabilities: async () => fullReport() },
    })
    const result = await enableSharedInboxConnectCommand.execute(
      { channelId: CHANNEL, actor: admin },
      ctx,
    )
    expect(result).toEqual({ status: 'not_found' })
  })
})

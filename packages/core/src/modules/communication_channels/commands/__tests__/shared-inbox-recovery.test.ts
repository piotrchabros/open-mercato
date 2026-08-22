import { CommunicationChannel } from '../../data/entities'
import {
  OUTBOUND_DELIVERY_STATUS_DISPATCHING,
  OUTBOUND_DELIVERY_STATUS_FAILED,
  OUTBOUND_DELIVERY_STATUS_PENDING,
  OUTBOUND_DELIVERY_STATUS_UNKNOWN,
} from '../../lib/delivery-status'
import {
  COMMUNICATION_CHANNELS_DISABLE_SHARED_INBOX_COMMAND_ID,
  COMMUNICATION_CHANNELS_RECONNECT_SHARED_INBOX_COMMAND_ID,
  disableSharedInboxCommand,
  reconnectSharedInboxCommand,
} from '../shared-inbox-recovery'

jest.mock('../../events', () => ({
  emitCommunicationChannelsEvent: jest.fn(async () => undefined),
}))

/**
 * Disable is the safety-critical half of shared-inbox recovery: it must block
 * new work and classify in-flight work in the same transaction, and reconnect
 * must never revive anything it terminated or left unresolved.
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

type ExecuteCall = { sql: string; params: unknown[] }

function createCtx(channel: Partial<CommunicationChannel> | null) {
  const executeCalls: ExecuteCall[] = []
  const em = {
    findOne: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
      if (entity !== CommunicationChannel || !channel) return null
      return channel.id === where.id &&
        channel.tenantId === where.tenantId &&
        channel.organizationId === where.organizationId
        ? channel
        : null
    }),
    execute: jest.fn(async (sql: string, params: unknown[]) => {
      executeCalls.push({ sql, params })
      // Two rows for the first (undispatched) update, one for the second.
      return executeCalls.length === 1 ? [{ id: 'link-1' }, { id: 'link-2' }] : [{ id: 'link-3' }]
    }),
    flush: jest.fn(async () => undefined),
    transactional: jest.fn(async (callback: (em: unknown) => Promise<unknown>) => callback(em)),
  }
  return {
    ctx: {
      container: { resolve: (name: string) => (name === 'em' ? { fork: () => em } : null) },
      auth: null,
      organizationScope: null,
      selectedOrganizationId: ORG,
      organizationIds: [ORG],
    } as never,
    em,
    executeCalls,
  }
}

function sharedChannel(overrides: Partial<CommunicationChannel> = {}): Partial<CommunicationChannel> {
  return {
    id: CHANNEL,
    tenantId: TENANT,
    organizationId: ORG,
    isSharedInbox: true,
    isActive: true,
    status: 'connected',
    credentialsRef: 'cred-1',
    lastError: null,
    ...overrides,
  }
}

describe('shared-inbox recovery command ids', () => {
  it('exports stable canonical command ids', () => {
    expect(COMMUNICATION_CHANNELS_DISABLE_SHARED_INBOX_COMMAND_ID).toBe(
      'communication_channels.shared_inbox.disable',
    )
    expect(COMMUNICATION_CHANNELS_RECONNECT_SHARED_INBOX_COMMAND_ID).toBe(
      'communication_channels.shared_inbox.reconnect',
    )
  })
})

describe('disableSharedInboxCommand', () => {
  it('refuses a caller without shared-inbox administration', async () => {
    const { ctx } = createCtx(sharedChannel())
    const result = await disableSharedInboxCommand.execute(
      { channelId: CHANNEL, actor: { ...admin, isOrganizationAdmin: false } },
      ctx,
    )
    expect(result).toEqual({ status: 'forbidden' })
  })

  it('masks a channel outside the caller scope as not_found', async () => {
    const { ctx, executeCalls } = createCtx(sharedChannel({ organizationId: 'other-org' }))
    const result = await disableSharedInboxCommand.execute({ channelId: CHANNEL, actor: admin }, ctx)
    expect(result).toEqual({ status: 'not_found' })
    expect(executeCalls).toHaveLength(0)
  })

  it('blocks the channel and classifies in-flight work in one transaction', async () => {
    const channel = sharedChannel()
    const { ctx, em, executeCalls } = createCtx(channel)
    const result = await disableSharedInboxCommand.execute({ channelId: CHANNEL, actor: admin }, ctx)

    expect(result).toEqual({
      status: 'disabled',
      channelId: CHANNEL,
      terminatedCount: 2,
      unknownCount: 1,
    })
    expect(channel.isActive).toBe(false)
    expect(channel.status).toBe('disconnected')
    expect(em.transactional).toHaveBeenCalledTimes(1)

    // Undispatched sends → terminal failed (retryable by an operator).
    expect(executeCalls[0].params).toContain(OUTBOUND_DELIVERY_STATUS_FAILED)
    expect(executeCalls[0].params).toContain(OUTBOUND_DELIVERY_STATUS_PENDING)
    // Possibly-dispatched sends → unknown, never auto-resent.
    expect(executeCalls[1].params).toContain(OUTBOUND_DELIVERY_STATUS_UNKNOWN)
    expect(executeCalls[1].params).toContain(OUTBOUND_DELIVERY_STATUS_DISPATCHING)
  })

  it('is idempotent for an already disabled channel and touches no delivery rows', async () => {
    const { ctx, executeCalls } = createCtx(
      sharedChannel({ isActive: false, status: 'disconnected' }),
    )
    const result = await disableSharedInboxCommand.execute({ channelId: CHANNEL, actor: admin }, ctx)
    expect(result).toEqual({ status: 'already_disabled', channelId: CHANNEL })
    expect(executeCalls).toHaveLength(0)
  })
})

describe('reconnectSharedInboxCommand', () => {
  it('re-enables the channel without touching any delivery row', async () => {
    const channel = sharedChannel({ isActive: false, status: 'disconnected', lastError: 'channel_disabled' })
    const { ctx, executeCalls } = createCtx(channel)
    const result = await reconnectSharedInboxCommand.execute({ channelId: CHANNEL, actor: admin }, ctx)

    expect(result).toEqual({ status: 'reconnected', channelId: CHANNEL })
    expect(channel.isActive).toBe(true)
    expect(channel.status).toBe('connected')
    expect(channel.lastError).toBeNull()
    // Terminal and unknown attempts stay exactly as the disable left them —
    // reviving them would resend without an operator decision.
    expect(executeCalls).toHaveLength(0)
  })

  it('refuses to reconnect a channel with no stored credentials', async () => {
    const { ctx } = createCtx(
      sharedChannel({ isActive: false, status: 'disconnected', credentialsRef: null }),
    )
    const result = await reconnectSharedInboxCommand.execute({ channelId: CHANNEL, actor: admin }, ctx)
    expect(result).toEqual({ status: 'credentials_missing' })
  })

  it('is idempotent for a connected channel', async () => {
    const { ctx } = createCtx(sharedChannel())
    const result = await reconnectSharedInboxCommand.execute({ channelId: CHANNEL, actor: admin }, ctx)
    expect(result).toEqual({ status: 'already_connected', channelId: CHANNEL })
  })

  it('refuses a caller without shared-inbox administration', async () => {
    const { ctx } = createCtx(sharedChannel({ isActive: false, status: 'disconnected' }))
    const result = await reconnectSharedInboxCommand.execute(
      { channelId: CHANNEL, actor: { ...admin, features: [] } },
      ctx,
    )
    expect(result).toEqual({ status: 'forbidden' })
  })
})

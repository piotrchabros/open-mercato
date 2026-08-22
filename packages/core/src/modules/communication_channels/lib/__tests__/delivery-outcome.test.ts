import type { EntityManager } from '@mikro-orm/postgresql'
import { ChannelDeliveryAttempt } from '../../data/entities'
import { isIndeterminateDispatchError, publishDeliveryOutcome } from '../delivery-outcome'

jest.mock('../../events', () => ({
  emitCommunicationChannelsEvent: jest.fn(async () => undefined),
}))

import { emitCommunicationChannelsEvent } from '../../events'

const mockEmit = emitCommunicationChannelsEvent as jest.MockedFunction<typeof emitCommunicationChannelsEvent>

/**
 * `communication_channels.delivery.outcome_recorded` is the authoritative
 * statement about a send. These tests pin what it may say and — just as
 * importantly — when it must stay silent.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const CHANNEL = '44444444-4444-4444-8444-444444444444'

function createEm(attempt: Partial<ChannelDeliveryAttempt>): EntityManager {
  return {
    findOne: jest.fn(async (entity: unknown) => (entity === ChannelDeliveryAttempt ? attempt : null)),
    flush: jest.fn(async () => undefined),
  } as unknown as EntityManager
}

function pendingAttempt(overrides: Partial<ChannelDeliveryAttempt> = {}): Partial<ChannelDeliveryAttempt> {
  return {
    id: 'attempt-1',
    tenantId: TENANT,
    organizationId: ORG,
    channelId: CHANNEL,
    correlationId: 'corr-1',
    attemptId: 'att-1',
    status: 'pending',
    deliveryRevision: 0,
    ...overrides,
  }
}

beforeEach(() => {
  mockEmit.mockClear()
})

describe('isIndeterminateDispatchError', () => {
  it.each([
    'Request timed out',
    'ETIMEDOUT connecting to smtp.example.com',
    'socket hang up',
    'ECONNRESET',
    'The operation was aborted',
    'write EPIPE',
  ])('treats %s as indeterminate', (message) => {
    expect(isIndeterminateDispatchError(message)).toBe(true)
  })

  // A provider that answered with a rejection is not indeterminate — we know
  // the message did not go out, so it is safe to report a terminal failure.
  it.each([
    'Invalid recipient address',
    '550 mailbox unavailable',
    'invalid_grant',
  ])('treats %s as determinate', (message) => {
    expect(isIndeterminateDispatchError(message)).toBe(false)
  })
})

describe('publishDeliveryOutcome', () => {
  it('publishes an identifier-only payload with no message content', async () => {
    const attempt = pendingAttempt()
    const result = await publishDeliveryOutcome({
      em: createEm(attempt),
      attempt: attempt as ChannelDeliveryAttempt,
      status: 'sent',
      providerMessageId: 'provider-1',
    })

    expect(result).toEqual({ published: true, deliveryRevision: 1 })
    expect(mockEmit).toHaveBeenCalledTimes(1)
    const [eventId, payload, options] = mockEmit.mock.calls[0]
    expect(eventId).toBe('communication_channels.delivery.outcome_recorded')
    expect(options).toEqual({ persistent: true })
    expect(payload).toMatchObject({
      tenantId: TENANT,
      organizationId: ORG,
      channelId: CHANNEL,
      correlationId: 'corr-1',
      attemptId: 'att-1',
      deliveryRevision: 1,
      status: 'sent',
      providerMessageId: 'provider-1',
    })
    // Persistent event storage must never hold recipients, subject or body.
    const payloadKeys = Object.keys(payload as Record<string, unknown>)
    expect(payloadKeys).not.toContain('to')
    expect(payloadKeys).not.toContain('subject')
    expect(payloadKeys).not.toContain('body')
  })

  it('carries the reason code for a definitive failure', async () => {
    const attempt = pendingAttempt()
    await publishDeliveryOutcome({
      em: createEm(attempt),
      attempt: attempt as ChannelDeliveryAttempt,
      status: 'failed',
      reasonCode: 'authorization_revoked',
    })
    expect(mockEmit.mock.calls[0][1]).toMatchObject({
      status: 'failed',
      reasonCode: 'authorization_revoked',
    })
  })

  // A second event for the same attempt would let a subscriber observe a
  // regression the store itself refused to make.
  it('publishes nothing when the outcome is fenced by a terminal state', async () => {
    const attempt = pendingAttempt({ status: 'sent', deliveryRevision: 2 })
    const result = await publishDeliveryOutcome({
      em: createEm(attempt),
      attempt: attempt as ChannelDeliveryAttempt,
      status: 'unknown',
    })
    expect(result).toEqual({ published: false, deliveryRevision: null })
    expect(mockEmit).not.toHaveBeenCalled()
  })

  // The record is durable before the event; the status lookup reads the record,
  // so a failed emit must not fail the delivery.
  it('still reports success when the event emit fails', async () => {
    mockEmit.mockRejectedValueOnce(new Error('[internal] bus down'))
    const attempt = pendingAttempt()
    const result = await publishDeliveryOutcome({
      em: createEm(attempt),
      attempt: attempt as ChannelDeliveryAttempt,
      status: 'sent',
    })
    expect(result).toEqual({ published: true, deliveryRevision: 1 })
    expect(attempt.status).toBe('sent')
  })
})

import handler from '../inbound-process'
import { getWebhookEndpointAdapter } from '../../lib/adapter-registry'

const mockProcessInbound = jest.fn()

jest.mock('../../lib/adapter-registry', () => ({
  getWebhookEndpointAdapter: jest.fn((key: string) => {
    if (key === 'test-provider') return { processInbound: mockProcessInbound }
    return null
  }),
}))

jest.mock('../../lib/inbound-registry', () => ({
  getWebhookSource: jest.fn((key: string) => (key === 'calcom' ? { key: 'calcom' } : undefined)),
}))

describe('webhooks inbound-process subscriber', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  it('calls adapter.processInbound with payload fields', async () => {
    mockProcessInbound.mockResolvedValue(undefined)

    await handler({
      providerKey: 'test-provider',
      eventType: 'shipment.update',
      payload: { trackingNumber: 'ABC123' },
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })

    expect(mockProcessInbound).toHaveBeenCalledWith({
      providerKey: 'test-provider',
      eventType: 'shipment.update',
      payload: { trackingNumber: 'ABC123' },
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })
  })

  it('re-throws when adapter.processInbound fails, so the queue can retry', async () => {
    const cause = new Error('Downstream failure')
    mockProcessInbound.mockRejectedValue(cause)

    await expect(
      handler({
        providerKey: 'test-provider',
        eventType: 'shipment.update',
        payload: { trackingNumber: 'ABC123' },
        tenantId: 'tenant-1',
        organizationId: 'org-1',
      }),
    ).rejects.toThrow('Downstream failure')
  })

  it('throws when the adapter is not registered', async () => {
    await expect(
      handler({
        providerKey: 'unknown-provider',
        eventType: 'shipment.update',
        payload: { foo: 'bar' },
      }),
    ).rejects.toThrow('"unknown-provider" is not registered')
  })

  it('skips providers handled by the inbound source registry', async () => {
    await expect(
      handler({
        providerKey: 'calcom',
        eventType: 'BOOKING_CREATED',
        payload: { uid: 'x' },
      }),
    ).resolves.toBeUndefined()
    expect(mockProcessInbound).not.toHaveBeenCalled()
    expect(getWebhookEndpointAdapter).not.toHaveBeenCalled()
  })

  it('returns early when required payload fields are missing', async () => {
    await expect(handler({ tenantId: 'tenant-1' })).resolves.toBeUndefined()
    expect(mockProcessInbound).not.toHaveBeenCalled()
  })
})

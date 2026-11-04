import { upsertInboundEndpointConfig } from '../inbound-endpoint-config'

const input = {
  sourceKey: 'calcom',
  integrationId: 'calcom_integration',
  scope: { tenantId: 'tenant-1', organizationId: 'org-1' },
  isActive: true,
}

function buildEm(overrides: Record<string, unknown> = {}) {
  const em: Record<string, jest.Mock> = {
    findOne: jest.fn(async () => null),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ id: 'new-id', ...data })),
    flush: jest.fn(async () => undefined),
    fork: jest.fn(),
    ...(overrides as Record<string, jest.Mock>),
  }
  em.fork.mockReturnValue(em)
  return em
}

describe('upsertInboundEndpointConfig', () => {
  it('creates the config when none exists', async () => {
    const em = buildEm()

    const result = await upsertInboundEndpointConfig(em as never, input)

    expect(result).toEqual({ id: 'new-id', created: true })
    expect(em.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceKey: 'calcom',
        isActive: true,
        integrationId: 'calcom_integration',
        organizationId: 'org-1',
        tenantId: 'tenant-1',
      }),
    )
  })

  it('updates the existing config', async () => {
    const existing = { id: 'row-1', isActive: false, integrationId: null }
    const em = buildEm({ findOne: jest.fn(async () => existing) })

    const result = await upsertInboundEndpointConfig(em as never, input)

    expect(result).toEqual({ id: 'row-1', created: false })
    expect(existing.isActive).toBe(true)
    expect(existing.integrationId).toBe('calcom_integration')
    expect(em.create).not.toHaveBeenCalled()
  })

  it('re-reads and updates after a unique violation race', async () => {
    const raced = { id: 'row-2', isActive: false, integrationId: null }
    const em = buildEm({
      findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(raced),
      flush: jest.fn().mockRejectedValueOnce({ code: '23505' }).mockResolvedValue(undefined),
    })

    const result = await upsertInboundEndpointConfig(em as never, input)

    expect(result).toEqual({ id: 'row-2', created: false })
    expect(raced.isActive).toBe(true)
  })

  it('rethrows non-unique errors', async () => {
    const em = buildEm({ flush: jest.fn().mockRejectedValue(new Error('boom')) })

    await expect(upsertInboundEndpointConfig(em as never, input)).rejects.toThrow('boom')
  })
})

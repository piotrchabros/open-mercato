import {
  connectPrincipalClassificationManifestSchema,
  createConnectPrincipalClassificationManifestService,
} from '../principal-classification-manifest'

const SCOPE = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}

describe('principal classification manifest', () => {
  it('rejects duplicate external keys and user IDs', () => {
    const entry = {
      externalKey: 'bot.primary',
      userId: '33333333-3333-4333-8333-333333333333',
      kind: 'system_bot' as const,
      reasonCode: 'connect.bot',
    }
    expect(() => connectPrincipalClassificationManifestSchema.parse({ entries: [entry, entry] }))
      .toThrow()
  })

  it('dry-runs without writes or provisioning and reports bounded counts', async () => {
    const em = {
      find: jest.fn(async () => [{
        externalKey: 'bot.primary',
        userId: '33333333-3333-4333-8333-333333333333',
        kind: 'system_bot',
        reasonCode: 'connect.bot',
        referenceId: null,
        active: true,
      }]),
      flush: jest.fn(),
    }
    const provisioningService = { ensure: jest.fn(), undo: jest.fn() }
    const service = createConnectPrincipalClassificationManifestService({
      em: em as never,
      provisioningService,
    })

    await expect(service.reconcile({
      ...SCOPE,
      apply: false,
      manifest: {
        entries: [{
          externalKey: 'bot.primary',
          userId: '33333333-3333-4333-8333-333333333333',
          kind: 'system_bot',
          reasonCode: 'connect.bot',
        }],
      },
    })).resolves.toEqual({
      desired: 1,
      created: 0,
      updated: 0,
      unchanged: 1,
      retired: 0,
      reconciled: 0,
      unavailable: 0,
    })
    expect(em.flush).not.toHaveBeenCalled()
    expect(provisioningService.ensure).not.toHaveBeenCalled()
  })

  it('rotates the operation id when a retired entry is registered again', async () => {
    const DESIRED = {
      externalKey: 'bot.primary',
      userId: '33333333-3333-4333-8333-333333333333',
      kind: 'system_bot' as const,
      reasonCode: 'connect.bot',
    }
    const stored: Record<string, unknown>[] = []
    const em = {
      find: jest.fn(async () => stored),
      findOne: jest.fn(async () => null),
      create: jest.fn((_entity: unknown, data: Record<string, unknown>) => data),
      persist: jest.fn((data: Record<string, unknown>) => { stored.push(data) }),
      flush: jest.fn(),
    }
    const provisioningService = {
      ensure: jest.fn(async () => ({ replayed: false, changed: false, created: true })),
      undo: jest.fn(),
    }
    const service = createConnectPrincipalClassificationManifestService({
      em: em as never,
      provisioningService: provisioningService as never,
    })
    const reconcile = () => service.reconcile({ ...SCOPE, apply: true, manifest: { entries: [DESIRED] } })

    await expect(reconcile()).resolves.toMatchObject({ created: 1 })
    const originalOperationId = stored[0]?.operationId
    expect(typeof originalOperationId).toBe('string')

    stored[0]!.active = false
    stored[0]!.lastResultCode = 'retired'

    await expect(reconcile()).resolves.toMatchObject({ updated: 1, reconciled: 1, unavailable: 0 })
    expect(stored[0]!.active).toBe(true)
    expect(stored[0]!.revision).toBe(2)
    expect(stored[0]!.operationId).not.toBe(originalOperationId)
    expect(provisioningService.ensure).toHaveBeenLastCalledWith(
      expect.objectContaining({ operationId: stored[0]!.operationId }),
    )
  })

  it('keeps the operation id stable when nothing drifted', async () => {
    const entry = {
      externalKey: 'bot.primary',
      userId: '33333333-3333-4333-8333-333333333333',
      kind: 'system_bot' as const,
      reasonCode: 'connect.bot',
      referenceId: null,
      active: true,
      revision: 4,
      operationId: 'stable-operation-id',
      lastReconciledAt: null,
      lastResultCode: null,
    }
    const em = {
      find: jest.fn(async () => [entry]),
      findOne: jest.fn(async () => null),
      create: jest.fn(),
      persist: jest.fn(),
      flush: jest.fn(),
    }
    const provisioningService = {
      ensure: jest.fn(async () => ({ replayed: true, changed: false, created: false })),
      undo: jest.fn(),
    }
    const service = createConnectPrincipalClassificationManifestService({
      em: em as never,
      provisioningService: provisioningService as never,
    })

    await expect(service.reconcile({
      ...SCOPE,
      apply: true,
      manifest: {
        entries: [{
          externalKey: entry.externalKey,
          userId: entry.userId,
          kind: entry.kind,
          reasonCode: entry.reasonCode,
        }],
      },
    })).resolves.toMatchObject({ unchanged: 1, updated: 0, reconciled: 1 })

    expect(entry.revision).toBe(4)
    expect(entry.operationId).toBe('stable-operation-id')
  })
})

import {
  createConnectPrincipalClassificationProvisioningService,
  ensureConnectPrincipalClassificationInputSchema,
  undoConnectPrincipalClassificationInputSchema,
} from '../principal-classification-provisioning'

const INPUT = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  operationId: '33333333-3333-4333-8333-333333333333',
  userId: '44444444-4444-4444-8444-444444444444',
  kind: 'human' as const,
  source: 'connect.test',
  reasonCode: 'test.fixture',
}

describe('principal classification provisioning contract', () => {
  it('strictly validates ensure and undo inputs', () => {
    expect(ensureConnectPrincipalClassificationInputSchema.parse(INPUT)).toEqual(INPUT)
    expect(() => ensureConnectPrincipalClassificationInputSchema.parse({ ...INPUT, email: 'x@example.test' }))
      .toThrow()
    expect(() => ensureConnectPrincipalClassificationInputSchema.parse({ ...INPUT, kind: 'unknown' }))
      .toThrow()
    expect(() => undoConnectPrincipalClassificationInputSchema.parse({
      tenantId: INPUT.tenantId,
      organizationId: INPUT.organizationId,
      operationId: INPUT.operationId,
      source: INPUT.source,
      originalChangeId: INPUT.userId,
      expectedUpdatedAt: 'not-a-date',
      reasonCode: INPUT.reasonCode,
    })).toThrow()
  })

  it('dispatches only with an internal system-actor command context', async () => {
    const execute = jest.fn(async () => ({ result: { ok: true }, logEntry: null }))
    const container = {
      resolve: jest.fn(() => ({ execute })),
    }
    const service = createConnectPrincipalClassificationProvisioningService(
      container as never,
    )

    await expect(service.ensure(INPUT)).resolves.toEqual({ ok: true })
    expect(execute).toHaveBeenCalledWith('connect.principal_classification.ensure', {
      input: INPUT,
      ctx: {
        container,
        auth: null,
        organizationScope: null,
        selectedOrganizationId: null,
        organizationIds: null,
        systemActor: true,
      },
    })
  })
})

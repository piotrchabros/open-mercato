import { syncCalcomEndpointConfig } from '../lib/endpoint-config'
import handleState, { metadata as stateMetadata } from '../subscribers/endpoint-config-on-state'
import handleCredentials, { metadata as credentialsMetadata } from '../subscribers/endpoint-config-on-credentials'
import { CALCOM_INTEGRATION_ID, CALCOM_SOURCE_KEY } from '../integration'

const upsertMock = jest.fn()
const createRequestContainerMock = jest.fn()
const findWithDecryptionMock = jest.fn()
const writeLogMock = jest.fn()

jest.mock('@open-mercato/webhooks/modules/webhooks/lib/inbound-endpoint-config', () => ({
  upsertInboundEndpointConfig: (...args: unknown[]) => upsertMock(...args),
}))
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findWithDecryption: (...args: unknown[]) => findWithDecryptionMock(...args),
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: () => createRequestContainerMock(),
}))

const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }
const em = { marker: 'em' }

type ScopeKey = { tenantId: string; organizationId: string }

function buildContainer(
  enabled: boolean,
  credentials: Record<string, unknown> | null,
  otherCredentials: Record<string, Record<string, unknown> | null> = {},
) {
  const resolveCredentials = jest.fn(async (_integrationId: string, target: ScopeKey) => {
    if (target.tenantId === scope.tenantId && target.organizationId === scope.organizationId) return credentials
    return otherCredentials[target.organizationId] ?? null
  })
  const services: Record<string, unknown> = {
    integrationStateService: { isEnabled: jest.fn().mockResolvedValue(enabled) },
    integrationCredentialsService: { resolve: resolveCredentials },
    integrationLogService: { write: writeLogMock },
    em,
  }
  return { resolve: (name: string) => services[name] } as unknown as Parameters<typeof syncCalcomEndpointConfig>[0]
}

const validCredentials = { webhookSecret: 'secret', instanceUrl: 'https://cal.example.com' }

function activeConfigs(rows: Array<ScopeKey & { isActive: boolean }>) {
  findWithDecryptionMock.mockImplementation(
    async (_em: unknown, _entity: unknown, where: { sourceKey: string; isActive: boolean }) =>
      rows
        .filter((row) => where.sourceKey === CALCOM_SOURCE_KEY && row.isActive === where.isActive)
        .map((row) => ({ ...row, sourceKey: CALCOM_SOURCE_KEY })),
  )
}

describe('syncCalcomEndpointConfig', () => {
  beforeEach(() => {
    upsertMock.mockReset().mockResolvedValue({ id: 'cfg', created: false })
    createRequestContainerMock.mockReset()
    writeLogMock.mockReset().mockResolvedValue(undefined)
    activeConfigs([{ ...scope, isActive: true }])
  })

  it('is active when enabled and a secret exists', async () => {
    const result = await syncCalcomEndpointConfig(buildContainer(true, validCredentials), scope)
    expect(result).toEqual({ active: true })
    expect(upsertMock).toHaveBeenCalledWith(em, {
      sourceKey: CALCOM_SOURCE_KEY,
      integrationId: CALCOM_INTEGRATION_ID,
      scope,
      isActive: true,
    })
  })

  it('is inactive when the integration is disabled', async () => {
    const result = await syncCalcomEndpointConfig(buildContainer(false, validCredentials), scope)
    expect(result).toEqual({ active: false, reason: 'disabled' })
    expect(upsertMock).toHaveBeenCalledWith(em, expect.objectContaining({ isActive: false }))
  })

  it('is inactive when no secret is configured', async () => {
    const result = await syncCalcomEndpointConfig(buildContainer(true, null), scope)
    expect(result).toEqual({ active: false, reason: 'secret_missing' })
    expect(upsertMock).toHaveBeenCalledWith(em, expect.objectContaining({ isActive: false }))
  })

  it('is inactive when the stored secret is blank', async () => {
    const result = await syncCalcomEndpointConfig(
      buildContainer(true, { webhookSecret: '  ', instanceUrl: 'https://cal.example.com' }),
      scope,
    )
    expect(result).toEqual({ active: false, reason: 'secret_missing' })
  })

  it('stays inactive and logs when another active scope uses the same secret', async () => {
    activeConfigs([
      { ...scope, isActive: true },
      { tenantId: 'tenant-2', organizationId: 'org-2', isActive: true },
    ])
    const sharedCredentials = { ...validCredentials, webhookSecret: 'whsec-duplicate-7f3a' }
    const container = buildContainer(true, sharedCredentials, { 'org-2': { ...sharedCredentials } })
    const result = await syncCalcomEndpointConfig(container, scope)
    expect(result).toEqual({ active: false, reason: 'secret_in_use' })
    expect(upsertMock).toHaveBeenCalledWith(em, expect.objectContaining({ scope, isActive: false }))
    expect(writeLogMock).toHaveBeenCalledTimes(1)
    const [entry, logScope] = writeLogMock.mock.calls[0]
    expect(logScope).toEqual(scope)
    expect(entry).toEqual(
      expect.objectContaining({
        integrationId: CALCOM_INTEGRATION_ID,
        level: 'error',
        code: 'calcom.endpoint.secret_in_use',
        payload: { tenantId: scope.tenantId, organizationId: scope.organizationId },
      }),
    )
    expect(JSON.stringify(entry)).not.toContain(sharedCredentials.webhookSecret)
    expect(JSON.stringify(result)).not.toContain(sharedCredentials.webhookSecret)
  })

  it('is active when only an inactive scope uses the same secret', async () => {
    activeConfigs([
      { ...scope, isActive: true },
      { tenantId: 'tenant-2', organizationId: 'org-2', isActive: false },
    ])
    const container = buildContainer(true, validCredentials, { 'org-2': { ...validCredentials } })
    const result = await syncCalcomEndpointConfig(container, scope)
    expect(result).toEqual({ active: true })
    expect(upsertMock).toHaveBeenCalledWith(em, expect.objectContaining({ isActive: true }))
    expect(writeLogMock).not.toHaveBeenCalled()
  })

  it('is active when another active scope uses a different secret', async () => {
    activeConfigs([
      { ...scope, isActive: true },
      { tenantId: 'tenant-2', organizationId: 'org-2', isActive: true },
    ])
    const container = buildContainer(true, validCredentials, {
      'org-2': { ...validCredentials, webhookSecret: 'another-secret' },
    })
    const result = await syncCalcomEndpointConfig(container, scope)
    expect(result).toEqual({ active: true })
    expect(writeLogMock).not.toHaveBeenCalled()
  })
})

describe('endpoint config subscribers', () => {
  beforeEach(() => {
    activeConfigs([])
    upsertMock.mockReset().mockResolvedValue({ id: 'cfg', created: false })
    createRequestContainerMock.mockReset().mockResolvedValue(buildContainer(true, validCredentials))
  })

  it('declares the integration events', () => {
    expect(stateMetadata).toEqual({
      event: 'integrations.state.updated',
      persistent: true,
      id: 'webhook_calcom:endpoint-config-on-state',
    })
    expect(credentialsMetadata).toEqual({
      event: 'integrations.credentials.updated',
      persistent: true,
      id: 'webhook_calcom:endpoint-config-on-credentials',
    })
  })

  it.each([
    ['state', handleState],
    ['credentials', handleCredentials],
  ])('syncs on %s changes for the calcom integration', async (_name, handler) => {
    await handler({ integrationId: CALCOM_INTEGRATION_ID, ...scope })
    expect(upsertMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['state', handleState],
    ['credentials', handleCredentials],
  ])('ignores other integrations on %s changes', async (_name, handler) => {
    await handler({ integrationId: 'other_integration', ...scope })
    expect(createRequestContainerMock).not.toHaveBeenCalled()
    expect(upsertMock).not.toHaveBeenCalled()
  })
})

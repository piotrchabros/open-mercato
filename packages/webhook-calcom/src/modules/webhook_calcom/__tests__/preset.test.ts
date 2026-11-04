import type { AwilixContainer } from 'awilix'
import { applyCalcomEnvPreset, CALCOM_ENV_VARS } from '../lib/preset'
import { syncCalcomEndpointConfig } from '../lib/endpoint-config'

jest.mock('../lib/endpoint-config', () => ({
  syncCalcomEndpointConfig: jest.fn(async () => ({ active: true })),
}))

const scope = { tenantId: 'tn', organizationId: 'org' }

const completeEnv = {
  [CALCOM_ENV_VARS.webhookSecret]: 'secret-1',
  [CALCOM_ENV_VARS.instanceUrl]: 'https://cal.example.com',
} as NodeJS.ProcessEnv

function build(existing: Record<string, unknown> | null = null) {
  const credentialsService = {
    getRaw: jest.fn(async () => existing),
    save: jest.fn(async () => undefined),
  }
  const stateService = { upsert: jest.fn(async () => undefined) }
  const container = {
    resolve: (name: string) => (name === 'integrationCredentialsService' ? credentialsService : stateService),
  } as unknown as AwilixContainer
  return { container, credentialsService, stateService }
}

describe('applyCalcomEnvPreset', () => {
  beforeEach(() => jest.clearAllMocks())

  it('skips when no variables are set', async () => {
    const { container, credentialsService } = build()
    const result = await applyCalcomEnvPreset({ container, scope, env: {} })
    expect(result.status).toBe('skipped')
    expect(credentialsService.save).not.toHaveBeenCalled()
  })

  it('skips when only one variable is set', async () => {
    const { container } = build()
    const result = await applyCalcomEnvPreset({
      container,
      scope,
      env: { [CALCOM_ENV_VARS.webhookSecret]: 'x' } as NodeJS.ProcessEnv,
    })
    expect(result).toMatchObject({ status: 'skipped' })
    expect(result.reason).toContain(CALCOM_ENV_VARS.instanceUrl)
  })

  it('saves credentials, enables the integration and syncs the endpoint', async () => {
    const { container, credentialsService, stateService } = build()
    const result = await applyCalcomEnvPreset({
      container,
      scope,
      env: { ...completeEnv, [CALCOM_ENV_VARS.unmatchedPolicy]: 'skip' } as NodeJS.ProcessEnv,
    })
    expect(result.status).toBe('applied')
    expect(credentialsService.save).toHaveBeenCalledWith(
      'webhook_source_calcom',
      { webhookSecret: 'secret-1', instanceUrl: 'https://cal.example.com', unmatchedAttendeePolicy: 'skip' },
      scope,
    )
    expect(stateService.upsert).toHaveBeenCalledWith('webhook_source_calcom', { isEnabled: true }, scope)
    expect(syncCalcomEndpointConfig).toHaveBeenCalledWith(container, scope)
  })

  it('keeps existing credentials unless forced', async () => {
    const kept = build({ webhookSecret: 'old', instanceUrl: 'https://old.example.com' })
    await applyCalcomEnvPreset({ container: kept.container, scope, env: completeEnv })
    expect(kept.credentialsService.save).not.toHaveBeenCalled()

    const forced = build({ webhookSecret: 'old', instanceUrl: 'https://old.example.com' })
    await applyCalcomEnvPreset({ container: forced.container, scope, env: completeEnv, force: true })
    expect(forced.credentialsService.save).toHaveBeenCalledTimes(1)
  })

  it('honours OM_INTEGRATION_CALCOM_ENABLED=false', async () => {
    const { container, stateService } = build()
    await applyCalcomEnvPreset({
      container,
      scope,
      env: { ...completeEnv, [CALCOM_ENV_VARS.enabled]: 'false' } as NodeJS.ProcessEnv,
    })
    expect(stateService.upsert).toHaveBeenCalledWith('webhook_source_calcom', { isEnabled: false }, scope)
  })

  it('skips on an invalid instance url', async () => {
    const { container, credentialsService } = build()
    const result = await applyCalcomEnvPreset({
      container,
      scope,
      env: { ...completeEnv, [CALCOM_ENV_VARS.instanceUrl]: 'not a url' } as NodeJS.ProcessEnv,
    })
    expect(result.status).toBe('skipped')
    expect(credentialsService.save).not.toHaveBeenCalled()
  })
})

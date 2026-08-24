import type { AwilixContainer } from 'awilix'
import type { InitSetupContext } from '@open-mercato/shared/modules/setup'
import { CONNECT_SLA_QUEUES } from '../lib/async'
import { setup } from '../setup'

const TENANT_A = '00000000-0000-4000-8000-00000000000a'
const TENANT_B = '00000000-0000-4000-8000-00000000000b'
const ORGANIZATION_A = '00000000-0000-4000-8000-0000000000a1'
const ORGANIZATION_B = '00000000-0000-4000-8000-0000000000b1'

function setupContext(options: { scheduler?: boolean; register?: jest.Mock; tenantId?: string; organizationId?: string } = {}) {
  const register = options.register ?? jest.fn(async () => undefined)
  const container = {
    hasRegistration: (name: string) => name === 'schedulerService' && options.scheduler !== false,
    resolve: (name: string) => {
      if (name === 'schedulerService') return { register }
      throw new Error(`[internal] unexpected registration ${name}`)
    },
  } as unknown as AwilixContainer
  return {
    register,
    context: {
      container,
      em: {} as never,
      tenantId: options.tenantId ?? TENANT_A,
      organizationId: options.organizationId ?? ORGANIZATION_A,
    } as InitSetupContext,
  }
}

describe('Connect SLA deadline schedule setup', () => {
  it('registers a 60-second organization-scoped queue target', async () => {
    const { context, register } = setupContext()

    await setup.seedDefaults!(context)

    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      scopeType: 'organization',
      tenantId: TENANT_A,
      organizationId: ORGANIZATION_A,
      scheduleType: 'interval',
      scheduleValue: '60s',
      targetType: 'queue',
      targetQueue: CONNECT_SLA_QUEUES.deadlineSweep,
      targetPayload: { tenantId: TENANT_A, organizationId: ORGANIZATION_A },
      sourceType: 'module',
      sourceModule: 'connect_sla',
      isEnabled: true,
    }))
  })

  it('derives a stable UUID from the complete tenant and organization scope', async () => {
    const { context, register } = setupContext()
    await setup.seedDefaults!(context)
    await setup.seedDefaults!(context)

    const tenantVariant = setupContext({ tenantId: TENANT_B })
    const organizationVariant = setupContext({ organizationId: ORGANIZATION_B })
    await setup.seedDefaults!(tenantVariant.context)
    await setup.seedDefaults!(organizationVariant.context)

    const deadlineCalls = register.mock.calls.filter((call) => call[0].targetQueue === CONNECT_SLA_QUEUES.deadlineSweep)
    const [first, repeated] = deadlineCalls.map((call) => call[0].id as string)
    expect(repeated).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(tenantVariant.register.mock.calls[0][0].id).not.toBe(first)
    expect(organizationVariant.register.mock.calls[0][0].id).not.toBe(first)
  })

  it('no-ops when the optional scheduler is absent', async () => {
    const { context, register } = setupContext({ scheduler: false })
    await expect(setup.seedDefaults!(context)).resolves.toBeUndefined()
    expect(register).not.toHaveBeenCalled()
  })

  it('fails soft when scheduler registration rejects', async () => {
    const register = jest.fn(async () => { throw new Error('scheduler unavailable') })
    const { context } = setupContext({ register })
    await expect(setup.seedDefaults!(context)).resolves.toBeUndefined()
    expect(register).toHaveBeenCalledTimes(1)
  })
})

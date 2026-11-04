import { createCalcomHealthCheck } from '../lib/health'

const scope = { organizationId: 'org-1', tenantId: 'tenant-1' }
const credentialsService = { resolve: jest.fn(async () => null) }
const valid = { webhookSecret: 's3cret', instanceUrl: 'https://1.1.1.1' }

function build(status: number | Error) {
  const fetchImpl = jest.fn(async () => {
    if (status instanceof Error) throw status
    return new Response(null, { status })
  }) as unknown as typeof fetch
  return { fetchImpl, check: createCalcomHealthCheck({ credentialsService, fetchImpl }) }
}

describe('createCalcomHealthCheck', () => {
  it('is unhealthy without credentials', async () => {
    const { check } = build(200)
    expect((await check.check(null, scope)).message).toBe('Cal.com credentials are missing or invalid.')
  })

  it('reports a missing secret', async () => {
    const { check } = build(200)
    const result = await check.check({ instanceUrl: valid.instanceUrl }, scope)
    expect(result).toMatchObject({ status: 'unhealthy', message: 'Webhook signing secret is not set.' })
  })

  it('reports a missing instance url', async () => {
    const { check } = build(200)
    const result = await check.check({ webhookSecret: 'x' }, scope)
    expect(result).toMatchObject({ status: 'unhealthy', message: 'Cal.com instance URL is not set.' })
  })

  it('is healthy on 2xx and 3xx', async () => {
    for (const code of [200, 302]) {
      const { check, fetchImpl } = build(code)
      expect((await check.check(valid, scope)).status).toBe('healthy')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })

  it('is degraded on 4xx and unhealthy on 5xx', async () => {
    expect((await build(404).check.check(valid, scope)).status).toBe('degraded')
    expect((await build(503).check.check(valid, scope)).status).toBe('unhealthy')
  })

  it('is unhealthy when the request fails', async () => {
    const result = await build(new Error('boom')).check.check(valid, scope)
    expect(result).toMatchObject({ status: 'unhealthy', message: 'Cal.com instance is unreachable or returned an error.' })
  })

  it('refuses unsafe instance urls', async () => {
    const { check, fetchImpl } = build(200)
    const result = await check.check({ webhookSecret: 'x', instanceUrl: 'http://127.0.0.1' }, scope)
    expect(result.status).toBe('unhealthy')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

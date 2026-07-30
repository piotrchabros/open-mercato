import { resolveRequestHostname } from '../requestHostname'

function makeRequest(headers: Record<string, string>): { headers: { get(name: string): string | null } } {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    headers: {
      get: (name: string) => map.get(name.toLowerCase()) ?? null,
    },
  }
}

describe('resolveRequestHostname', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalSecret = process.env.FORCE_HOST_SECRET

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    process.env.FORCE_HOST_SECRET = originalSecret
  })

  it('uses x-force-host when the secret matches in test env', () => {
    process.env.NODE_ENV = 'test'
    process.env.FORCE_HOST_SECRET = 'super-secret'
    const req = makeRequest({
      host: 'platform.example.com',
      'x-force-host': 'tenant.example.com',
      'x-force-host-secret': 'super-secret',
    })
    expect(resolveRequestHostname(req)).toBe('tenant.example.com')
  })

  it('falls back to the Host header when the secret does not match', () => {
    process.env.NODE_ENV = 'test'
    process.env.FORCE_HOST_SECRET = 'super-secret'
    const req = makeRequest({
      host: 'platform.example.com',
      'x-force-host': 'tenant.example.com',
      'x-force-host-secret': 'wrong-secret',
    })
    expect(resolveRequestHostname(req)).toBe('platform.example.com')
  })

  it('falls back to the Host header when x-force-host-secret is absent', () => {
    process.env.NODE_ENV = 'test'
    process.env.FORCE_HOST_SECRET = 'super-secret'
    const req = makeRequest({
      host: 'platform.example.com',
      'x-force-host': 'tenant.example.com',
    })
    expect(resolveRequestHostname(req)).toBe('platform.example.com')
  })

  it('ignores x-force-host outside test env even with a matching secret', () => {
    process.env.NODE_ENV = 'production'
    process.env.FORCE_HOST_SECRET = 'super-secret'
    const req = makeRequest({
      host: 'platform.example.com',
      'x-force-host': 'tenant.example.com',
      'x-force-host-secret': 'super-secret',
    })
    expect(resolveRequestHostname(req)).toBe('platform.example.com')
  })

  it('ignores x-force-host when FORCE_HOST_SECRET is not configured', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.FORCE_HOST_SECRET
    const req = makeRequest({
      host: 'platform.example.com',
      'x-force-host': 'tenant.example.com',
      'x-force-host-secret': 'anything',
    })
    expect(resolveRequestHostname(req)).toBe('platform.example.com')
  })

  it('returns null when neither the forced host nor the Host header is present', () => {
    process.env.NODE_ENV = 'test'
    process.env.FORCE_HOST_SECRET = 'super-secret'
    const req = makeRequest({})
    expect(resolveRequestHostname(req)).toBeNull()
  })

  it('ignores an empty x-force-host value even with a matching secret', () => {
    process.env.NODE_ENV = 'test'
    process.env.FORCE_HOST_SECRET = 'super-secret'
    const req = makeRequest({
      host: 'platform.example.com',
      'x-force-host': '',
      'x-force-host-secret': 'super-secret',
    })
    expect(resolveRequestHostname(req)).toBe('platform.example.com')
  })
})

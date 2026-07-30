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
  const originalAllowFlag = process.env.OM_ALLOW_FORCED_HOST

  beforeEach(() => {
    // The override is behind three independent gates; every test that expects
    // it to fire must open all three. Each gate has its own test below proving
    // it alone is sufficient to block.
    process.env.OM_ALLOW_FORCED_HOST = '1'
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    process.env.FORCE_HOST_SECRET = originalSecret
    if (originalAllowFlag === undefined) delete process.env.OM_ALLOW_FORCED_HOST
    else process.env.OM_ALLOW_FORCED_HOST = originalAllowFlag
  })

  it('uses x-force-host when all three gates are open', () => {
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

  // Each of the three gates must block on its own. The two below cover the
  // OM_ALLOW_FORCED_HOST gate; the NODE_ENV and secret gates are covered by
  // 'ignores x-force-host outside test env...' and 'falls back to the Host
  // header when the secret does not match' above.
  it('ignores x-force-host when OM_ALLOW_FORCED_HOST is unset, with the other two gates open', () => {
    delete process.env.OM_ALLOW_FORCED_HOST
    process.env.NODE_ENV = 'test'
    process.env.FORCE_HOST_SECRET = 'super-secret'
    const req = makeRequest({
      host: 'platform.example.com',
      'x-force-host': 'tenant.example.com',
      'x-force-host-secret': 'super-secret',
    })
    expect(resolveRequestHostname(req)).toBe('platform.example.com')
  })

  it.each(['0', 'false', 'no', 'off', 'disabled'])(
    'ignores x-force-host when OM_ALLOW_FORCED_HOST is %p',
    (value) => {
      process.env.OM_ALLOW_FORCED_HOST = value
      process.env.NODE_ENV = 'test'
      process.env.FORCE_HOST_SECRET = 'super-secret'
      const req = makeRequest({
        host: 'platform.example.com',
        'x-force-host': 'tenant.example.com',
        'x-force-host-secret': 'super-secret',
      })
      expect(resolveRequestHostname(req)).toBe('platform.example.com')
    },
  )
})

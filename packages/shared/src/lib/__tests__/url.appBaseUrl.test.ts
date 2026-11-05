import {
  AppOriginRejectedError,
  ORGANIZATION_APP_URL_RESOLVER_DI_KEY,
  getSecurityEmailBaseUrl,
  isAllowedAppOrigin,
  normalizeAppOrigin,
  readAllowedRequestOrigin,
  resolveAppBaseUrl,
  resolveOrganizationAppUrl,
  toAppUrl,
} from '../url'

const env = { APP_URL: 'https://app.example.com', NODE_ENV: 'production' }

function containerWith(resolver: unknown) {
  return {
    resolve: (name: string) => {
      if (name !== ORGANIZATION_APP_URL_RESOLVER_DI_KEY) throw new Error('[internal] unknown registration')
      return resolver
    },
  }
}

function req(headers: Record<string, string>, url = 'https://app.example.com/api/x') {
  return new Request(url, { method: 'POST', headers })
}

describe('normalizeAppOrigin', () => {
  test('lower-cases the host and drops the default port', () => {
    expect(normalizeAppOrigin(' https://Crm.Example.COM:443 ')).toBe('https://crm.example.com')
    expect(normalizeAppOrigin('http://crm.example.com:8080/')).toBe('http://crm.example.com:8080')
  })

  test.each([
    ['non-string', 42],
    ['empty', '  '],
    ['garbage', 'not a url'],
    ['ftp protocol', 'ftp://crm.example.com'],
    ['credentials', 'https://user:pw@crm.example.com'],
    ['path', 'https://crm.example.com/app'],
    ['query', 'https://crm.example.com/?a=1'],
    ['hash', 'https://crm.example.com/#x'],
  ])('rejects %s', (_label, raw) => {
    expect(normalizeAppOrigin(raw)).toBeNull()
  })
})

describe('isAllowedAppOrigin', () => {
  test('allows configured origins only', () => {
    expect(isAllowedAppOrigin('https://app.example.com', env)).toBe(true)
    expect(isAllowedAppOrigin('https://evil.example.net', env)).toBe(false)
  })

  test('allows APP_ALLOWED_ORIGINS entries', () => {
    expect(isAllowedAppOrigin('https://crm.example.com', { ...env, APP_ALLOWED_ORIGINS: 'https://crm.example.com' })).toBe(true)
  })

  test('allows loopback origins when a loopback origin is configured', () => {
    const dev = { APP_URL: 'http://localhost:3000', NODE_ENV: 'development' }
    expect(isAllowedAppOrigin('http://127.0.0.1:4000', dev)).toBe(true)
    expect(isAllowedAppOrigin('http://localhost:3000', { ...dev, NODE_ENV: 'production' })).toBe(true)
    expect(isAllowedAppOrigin('http://127.0.0.1:4000', { ...dev, NODE_ENV: 'production' })).toBe(false)
    expect(isAllowedAppOrigin('http://localhost:3000', env)).toBe(false)
  })
})

describe('readAllowedRequestOrigin', () => {
  const multi = { ...env, APP_ALLOWED_ORIGINS: 'https://crm.example.com' }

  test('prefers x-forwarded-host over host', () => {
    expect(
      readAllowedRequestOrigin(req({ host: 'app.example.com', 'x-forwarded-host': 'crm.example.com' }), multi),
    ).toBe('https://crm.example.com')
  })

  test('falls back to host, then url origin', () => {
    expect(readAllowedRequestOrigin(req({ host: 'crm.example.com', 'x-forwarded-proto': 'https' }, 'http://internal:3000/x'), multi)).toBe('https://crm.example.com')
    expect(readAllowedRequestOrigin(req({}), multi)).toBe('https://app.example.com')
  })

  test('honours x-forwarded-proto', () => {
    expect(
      readAllowedRequestOrigin(
        req({ host: 'crm.example.com', 'x-forwarded-proto': 'https' }, 'http://internal:3000/x'),
        multi,
      ),
    ).toBe('https://crm.example.com')
  })

  test('returns null for a disallowed origin', () => {
    expect(readAllowedRequestOrigin(req({ host: 'evil.example.net' }), multi)).toBeNull()
  })
})

describe('resolveOrganizationAppUrl', () => {
  test('returns null without a container or organization id', async () => {
    expect(await resolveOrganizationAppUrl({ organizationId: 'org-1' })).toBeNull()
    expect(await resolveOrganizationAppUrl({ container: containerWith({}), organizationId: null })).toBeNull()
  })

  test('returns null when resolving throws', async () => {
    const container = {
      resolve: () => {
        throw new Error('[internal] not registered')
      },
    }
    expect(await resolveOrganizationAppUrl({ container, organizationId: 'org-1' })).toBeNull()
  })

  test('returns null for a wrong-shaped resolver', async () => {
    expect(await resolveOrganizationAppUrl({ container: containerWith(null), organizationId: 'org-1' })).toBeNull()
    expect(await resolveOrganizationAppUrl({ container: containerWith({ resolveOwn: 'x' }), organizationId: 'org-1' })).toBeNull()
  })

  test('returns null when resolveOwn rejects', async () => {
    const resolver = { resolveOwn: jest.fn().mockRejectedValue(new Error('[internal] boom')) }
    expect(await resolveOrganizationAppUrl({ container: containerWith(resolver), organizationId: 'org-1' })).toBeNull()
  })

  test('returns the own value', async () => {
    const resolver = { resolveOwn: jest.fn().mockResolvedValue('https://crm.example.com') }
    expect(await resolveOrganizationAppUrl({ container: containerWith(resolver), organizationId: 'org-1' })).toBe(
      'https://crm.example.com',
    )
    expect(resolver.resolveOwn).toHaveBeenCalledWith('org-1')
  })
})

describe('resolveAppBaseUrl', () => {
  test('falls back to getSecurityEmailBaseUrl', async () => {
    const request = req({ host: 'app.example.com' })
    expect(await resolveAppBaseUrl({ req: request, env })).toBe(getSecurityEmailBaseUrl(request, env))
    expect(await resolveAppBaseUrl({ env, container: containerWith({ resolveOwn: async () => null }), organizationId: 'org-1' })).toBe(
      'https://app.example.com',
    )
  })

  test('prefers the organization address', async () => {
    const resolver = { resolveOwn: async () => 'https://crm.example.com' }
    expect(await resolveAppBaseUrl({ req: req({ host: 'app.example.com' }), env, container: containerWith(resolver), organizationId: 'org-1' })).toBe(
      'https://crm.example.com',
    )
  })

  test('still rejects a disallowed request even when the resolver returns a value', async () => {
    const resolver = { resolveOwn: async () => 'https://crm.example.com' }
    await expect(
      resolveAppBaseUrl({ req: req({ host: 'evil.example.net' }), env, container: containerWith(resolver), organizationId: 'org-1' }),
    ).rejects.toBeInstanceOf(AppOriginRejectedError)
  })
})

describe('toAppUrl', () => {
  test('joins the base and a path without duplicate slashes', async () => {
    const resolver = { resolveOwn: async () => 'https://crm.example.com' }
    expect(await toAppUrl({ env, container: containerWith(resolver), organizationId: 'org-1' }, '//reset/abc')).toBe(
      'https://crm.example.com/reset/abc',
    )
    expect(await toAppUrl({ env }, '/login')).toBe('https://app.example.com/login')
  })
})

/** @jest-environment node */
import { OAuthGrantError } from '../descriptor'
import { resolveOAuthRedirectUri, resolveOAuthRedirectUriForOrganization } from '../redirect'

const ENV_KEYS = ['APP_URL', 'NEXT_PUBLIC_APP_URL', 'APP_ALLOWED_ORIGINS', 'NODE_ENV'] as const
const originalEnv: Record<string, string | undefined> = {}
const CALLBACK_PATH = '/api/acme/oauth/callback'

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key]
  delete process.env.APP_URL
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.APP_ALLOWED_ORIGINS
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

async function grantErrorCode(run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof OAuthGrantError) return error.code
    throw error
  }
  throw new Error('[internal] expected OAuthGrantError')
}

describe('resolveOAuthRedirectUri', () => {
  it('keeps the path prefix of APP_URL', () => {
    process.env.APP_URL = 'https://erp.acme.test/mercato/'
    const req = new Request('https://erp.acme.test/mercato/api/acme/oauth/initiate')

    expect(resolveOAuthRedirectUri(req, CALLBACK_PATH)).toBe('https://erp.acme.test/mercato/api/acme/oauth/callback')
  })

  it('uses APP_URL even when the request comes from another allowed origin', () => {
    process.env.APP_URL = 'https://erp.acme.test'
    process.env.APP_ALLOWED_ORIGINS = 'https://admin.acme.test'
    const req = new Request('https://admin.acme.test/api/acme/oauth/initiate', { headers: { host: 'admin.acme.test' } })

    expect(resolveOAuthRedirectUri(req, CALLBACK_PATH)).toBe('https://erp.acme.test/api/acme/oauth/callback')
  })

  it('falls back to localhost outside production, never to the request origin', () => {
    process.env.NODE_ENV = 'development'
    const req = new Request('https://tunnel.example.test/api/acme/oauth/initiate', { headers: { host: 'tunnel.example.test' } })

    expect(resolveOAuthRedirectUri(req, CALLBACK_PATH)).toBe('http://localhost:3000/api/acme/oauth/callback')
    expect(resolveOAuthRedirectUri(undefined, '/')).toBe('http://localhost:3000/')
  })

  it('fails oauth_base_url_not_configured in production without APP_URL', async () => {
    process.env.NODE_ENV = 'production'
    process.env.NEXT_PUBLIC_APP_URL = 'https://erp.acme.test'
    const req = new Request('https://erp.acme.test/api/acme/oauth/initiate')

    expect(await grantErrorCode(() => resolveOAuthRedirectUri(req, CALLBACK_PATH))).toBe('oauth_base_url_not_configured')
    expect(await grantErrorCode(() => resolveOAuthRedirectUri(undefined, '/'))).toBe('oauth_base_url_not_configured')
  })

  it('fails connect_origin_rejected for a request from a foreign origin', async () => {
    process.env.APP_URL = 'https://erp.acme.test'
    const viaUrl = new Request('https://evil.example.test/api/acme/oauth/initiate')
    const viaForwardedHost = new Request('https://erp.acme.test/api/acme/oauth/initiate', {
      headers: { host: 'erp.acme.test', 'x-forwarded-host': 'evil.example.test' },
    })

    expect(await grantErrorCode(() => resolveOAuthRedirectUri(viaUrl, CALLBACK_PATH))).toBe('connect_origin_rejected')
    expect(await grantErrorCode(() => resolveOAuthRedirectUri(viaForwardedHost, CALLBACK_PATH))).toBe('connect_origin_rejected')
  })

  it('accepts no request when APP_URL is configured', () => {
    process.env.NODE_ENV = 'production'
    process.env.APP_URL = 'https://erp.acme.test'

    expect(resolveOAuthRedirectUri(undefined, CALLBACK_PATH)).toBe('https://erp.acme.test/api/acme/oauth/callback')
  })

  it('requires a path starting with a slash', () => {
    process.env.APP_URL = 'https://erp.acme.test'

    expect(() => resolveOAuthRedirectUri(undefined, 'api/acme/oauth/callback')).toThrow(/^\[internal\]/)
  })
})

describe('resolveOAuthRedirectUriForOrganization', () => {
  const ORG_ADDRESS = 'https://org.acme.test'
  const containerWith = (own: string | null) => ({
    resolve: (name: string) => {
      if (name === 'organizationAppUrlResolver') return { resolveOwn: async () => own }
      throw new Error('[internal] unknown dependency')
    },
  })
  const scopeWith = (own: string | null) => ({ container: containerWith(own), organizationId: 'org-1' })

  it('uses the organization address and reports it as redirectOrigin', async () => {
    process.env.APP_URL = 'https://erp.acme.test'
    process.env.APP_ALLOWED_ORIGINS = ORG_ADDRESS
    const req = new Request(`${ORG_ADDRESS}/api/acme/oauth/initiate`, { headers: { host: 'org.acme.test' } })

    await expect(resolveOAuthRedirectUriForOrganization(req, CALLBACK_PATH, scopeWith(ORG_ADDRESS))).resolves.toEqual({
      redirectUri: `${ORG_ADDRESS}${CALLBACK_PATH}`,
      redirectOrigin: ORG_ADDRESS,
    })
  })

  it('falls back to the sync result with a null redirectOrigin without an own address', async () => {
    process.env.APP_URL = 'https://erp.acme.test/mercato'
    const req = new Request('https://erp.acme.test/mercato/api/acme/oauth/initiate')

    await expect(resolveOAuthRedirectUriForOrganization(req, CALLBACK_PATH, scopeWith(null))).resolves.toEqual({
      redirectUri: resolveOAuthRedirectUri(req, CALLBACK_PATH),
      redirectOrigin: null,
    })
    await expect(resolveOAuthRedirectUriForOrganization(req, CALLBACK_PATH, {})).resolves.toEqual({
      redirectUri: resolveOAuthRedirectUri(req, CALLBACK_PATH),
      redirectOrigin: null,
    })
  })

  it('accepts no request when an own address exists', async () => {
    process.env.NODE_ENV = 'production'
    process.env.APP_URL = 'https://erp.acme.test'

    await expect(resolveOAuthRedirectUriForOrganization(undefined, CALLBACK_PATH, scopeWith(ORG_ADDRESS))).resolves.toEqual({
      redirectUri: `${ORG_ADDRESS}${CALLBACK_PATH}`,
      redirectOrigin: ORG_ADDRESS,
    })
  })

  it('still fails connect_origin_rejected for a foreign request origin when an own address exists', async () => {
    process.env.APP_URL = 'https://erp.acme.test'
    const req = new Request('https://evil.example.test/api/acme/oauth/initiate')

    expect(await grantErrorCode(() => resolveOAuthRedirectUriForOrganization(req, CALLBACK_PATH, scopeWith(ORG_ADDRESS)))).toBe('connect_origin_rejected')
  })

  it('requires a path starting with a slash', async () => {
    process.env.APP_URL = 'https://erp.acme.test'

    await expect(resolveOAuthRedirectUriForOrganization(undefined, 'api/acme', scopeWith(ORG_ADDRESS))).rejects.toThrow(/^\[internal\]/)
    await expect(resolveOAuthRedirectUriForOrganization(undefined, 'api/acme', scopeWith(null))).rejects.toThrow(/^\[internal\]/)
  })
})

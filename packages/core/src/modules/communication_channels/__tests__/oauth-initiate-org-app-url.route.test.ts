/** @jest-environment node */

import { POST as initiateOAuth } from '../api/post/oauth/[provider]/initiate/route'
import { decryptOAuthState, COMMUNICATION_CHANNELS_OAUTH_STATE_COOKIE_NAME } from '../lib/oauth-state'

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174001'
const ORG_ID = '223e4567-e89b-12d3-a456-426614174001'
const PROVIDER = 'gmail'
const OWN_URL = 'https://acme.example.org'

const mockBuildAuthorizeUrl = jest.fn()
const mockResolveOrganizationAppUrl = jest.fn()

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn(async () => ({ sub: 'user-1', tenantId: TENANT_ID, orgId: ORG_ID })),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({ resolve: jest.fn() })),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({
    translate: (_key: string, fallback: string, params?: Record<string, string>) =>
      fallback.replace('{origin}', params?.origin ?? ''),
  })),
}))

jest.mock('@open-mercato/shared/lib/url', () => ({
  toAbsoluteUrl: (_req: unknown, path: string) => `https://default.example.com${path}`,
  readAllowedRequestOrigin: (req: Request) => new URL(req.url).origin,
  resolveOrganizationAppUrl: (...args: unknown[]) => mockResolveOrganizationAppUrl(...args),
}))

jest.mock('../lib/adapter-registry-singleton', () => ({
  getChannelAdapter: jest.fn(() => ({
    buildOAuthAuthorizeUrl: (...args: unknown[]) => mockBuildAuthorizeUrl(...args),
  })),
}))

jest.mock('../lib/oauth-client-config', () => ({
  resolveOAuthClientCredentials: jest.fn(async () => ({ clientId: 'client-id', clientSecret: 'client-secret' })),
}))

function makeRequest(origin: string): Request {
  return new Request(`${origin}/api/communication_channels/oauth/${PROVIDER}/initiate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
}

describe('communication_channels oauth initiate — per-organization app URL', () => {
  beforeAll(() => {
    process.env.OM_HUB_OAUTH_STATE_KEY = 'test-initiate-org-app-url-secret'
  })

  afterAll(() => {
    delete process.env.OM_HUB_OAUTH_STATE_KEY
  })

  beforeEach(() => {
    mockBuildAuthorizeUrl.mockReset()
    mockResolveOrganizationAppUrl.mockReset()
    mockBuildAuthorizeUrl.mockResolvedValue({ authorizeUrl: 'https://provider.test/authorize' })
  })

  it('own address: redirect_uri uses it and the state records redirectOrigin', async () => {
    mockResolveOrganizationAppUrl.mockResolvedValue(OWN_URL)

    const res = await initiateOAuth(makeRequest(OWN_URL), { params: { provider: PROVIDER } })

    expect(res.status).toBe(200)
    expect(mockBuildAuthorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: `${OWN_URL}/api/communication_channels/oauth/${PROVIDER}/callback`,
      }),
    )
    const cookie = res.cookies.get(COMMUNICATION_CHANNELS_OAUTH_STATE_COOKIE_NAME)?.value ?? ''
    expect(decryptOAuthState(cookie)?.redirectOrigin).toBe(OWN_URL)
  })

  it('wrong request origin: responds 409 oauth_origin_mismatch', async () => {
    mockResolveOrganizationAppUrl.mockResolvedValue(OWN_URL)

    const res = await initiateOAuth(makeRequest('https://other.example.com'), { params: { provider: PROVIDER } })

    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe('oauth_origin_mismatch')
    expect(body.error).toContain(OWN_URL)
    expect(mockBuildAuthorizeUrl).not.toHaveBeenCalled()
  })

  it('no own address: default redirect_uri and no redirectOrigin in state', async () => {
    mockResolveOrganizationAppUrl.mockResolvedValue(null)

    const res = await initiateOAuth(makeRequest('https://other.example.com'), { params: { provider: PROVIDER } })

    expect(res.status).toBe(200)
    expect(mockBuildAuthorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUri: `https://default.example.com/api/communication_channels/oauth/${PROVIDER}/callback`,
      }),
    )
    const cookie = res.cookies.get(COMMUNICATION_CHANNELS_OAUTH_STATE_COOKIE_NAME)?.value ?? ''
    expect(decryptOAuthState(cookie)?.redirectOrigin ?? null).toBeNull()
  })
})

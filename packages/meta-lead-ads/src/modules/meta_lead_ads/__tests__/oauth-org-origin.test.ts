const getAuthFromRequestMock = jest.fn()
const createRequestContainerMock = jest.fn()
const completeMetaOAuthMock = jest.fn()
const runGuardsMock = jest.fn()
const resolveRouteContextMock = jest.fn()
const getOrgSettingsMock = jest.fn()
const findOneWithDecryptionMock = jest.fn()

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (...args: unknown[]) => getAuthFromRequestMock(...args),
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => createRequestContainerMock(...args),
}))
jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({ translate: (key: string, fallback?: string) => fallback ?? key }),
}))
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: (...args: unknown[]) => findOneWithDecryptionMock(...args),
}))
jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: async () => ({ selectedId: 'org-1', filterIds: null, allowedIds: null }),
}))
jest.mock('../lib/preset', () => ({
  ...jest.requireActual('../lib/preset'),
  resolveAppCredentials: async () => ({
    appId: 'app-1',
    appSecret: 'secret-1',
    loginConfigId: 'cfg-1',
    graphVersion: null,
  }),
}))
jest.mock('../lib/oauth', () => ({
  ...jest.requireActual('../lib/oauth'),
  completeMetaOAuth: (...args: unknown[]) => completeMetaOAuthMock(...args),
}))
jest.mock('../lib/http', () => ({
  ...jest.requireActual('../lib/http'),
  runGuards: (...args: unknown[]) => runGuardsMock(...args),
  resolveRouteContext: (...args: unknown[]) => resolveRouteContextMock(...args),
}))
jest.mock('../lib/settings', () => ({
  ...jest.requireActual('../lib/settings'),
  getOrgSettings: (...args: unknown[]) => getOrgSettingsMock(...args),
}))

import { verifyOAuthState, type OAuthStatePayload } from '@open-mercato/core/modules/communication_channels/lib/oauth-state'
import { REQUIRED_SCOPES, OAUTH_CALLBACK_PATH, OAUTH_PROVIDER_KEY, OAUTH_STATE_COOKIE } from '../lib/constants'
import { GET as initiate } from '../api/oauth/initiate/route'
import { GET as callback } from '../api/oauth/callback/route'
import { GET as getSettings } from '../api/settings/route'

const APP_ORIGIN = 'https://app.example.com'
const ORG_ORIGIN = 'https://acme.example.com'
const ORIGINAL_ENV = { ...process.env }

let ownAppUrl: string | null = null

function buildContainer() {
  const cacheEntries = new Map<string, unknown>()
  const em = {
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ id: 'connection-1', ...data })),
    persist: jest.fn(),
    flush: jest.fn(async () => undefined),
  }
  const services: Record<string, unknown> = {
    em: { fork: () => em },
    rbacService: { userHasAllFeatures: async () => true },
    organizationAppUrlResolver: { resolveOwn: async () => ownAppUrl },
    cache: {
      has: async (key: string) => cacheEntries.has(key),
      set: async (key: string, value: unknown) => {
        cacheEntries.set(key, value)
      },
    },
    metaGraphClient: {},
  }
  return { resolve: (name: string) => services[name] }
}

function readStateCookie(response: Response): string {
  const header = response.headers.get('set-cookie') ?? ''
  const match = header.match(new RegExp(`${OAUTH_STATE_COOKIE}=([^;]+)`))
  if (!match) throw new Error('[internal] state cookie missing')
  return match[1]
}

async function startConnection(origin: string) {
  const response = await initiate(new Request(`${origin}/api/meta_lead_ads/oauth/initiate`))
  const location = new URL(response.headers.get('location') ?? '')
  return { response, location }
}

async function startAndReadState(origin: string) {
  const { response, location } = await startConnection(origin)
  const cookie = readStateCookie(response)
  const stateParam = location.searchParams.get('state') ?? ''
  const payload: OAuthStatePayload = verifyOAuthState({
    cookie,
    expectedUserId: 'user-1',
    expectedProviderKey: OAUTH_PROVIDER_KEY,
    expectedState: stateParam,
  })
  return { location, cookie, stateParam, payload }
}

function callbackRequest(origin: string, stateParam: string, cookie: string): Request {
  return new Request(`${origin}${OAUTH_CALLBACK_PATH}?code=code-1&state=${encodeURIComponent(stateParam)}`, {
    headers: { cookie: `${OAUTH_STATE_COOKIE}=${cookie}` },
  })
}

describe('Meta OAuth with an organization address', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      APP_URL: APP_ORIGIN,
      NEXT_PUBLIC_APP_URL: APP_ORIGIN,
      APP_ALLOWED_ORIGINS: ORG_ORIGIN,
      OM_HUB_OAUTH_STATE_KEY: 'test-oauth-state-key-with-enough-entropy-0123456789',
    }
    ownAppUrl = null
    getAuthFromRequestMock.mockResolvedValue({ sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-1' })
    createRequestContainerMock.mockImplementation(async () => buildContainer())
    runGuardsMock.mockResolvedValue({ ok: true, runAfterSuccess: async () => undefined })
    findOneWithDecryptionMock.mockResolvedValue(null)
    completeMetaOAuthMock.mockResolvedValue({
      userAccessToken: 'token',
      tokenExpiresAt: null,
      metaUserId: 'meta-user-1',
      metaUserName: 'Jan Kowalski',
      grantedScopes: [...REQUIRED_SCOPES],
    })
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('uses the organization address for the redirect URI and records it in the state', async () => {
    ownAppUrl = ORG_ORIGIN
    const { location, payload } = await startAndReadState(ORG_ORIGIN)
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORG_ORIGIN}${OAUTH_CALLBACK_PATH}`)
    expect(payload.redirectOrigin).toBe(ORG_ORIGIN)
  })

  it('redirects to the organization address when the flow starts from another address', async () => {
    ownAppUrl = ORG_ORIGIN
    const { response } = await startConnection(APP_ORIGIN)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${ORG_ORIGIN}/backend/meta-lead-ads?connect=wrong_origin`)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('exchanges the code with the organization callback and returns to the organization address', async () => {
    ownAppUrl = ORG_ORIGIN
    const { cookie, stateParam } = await startAndReadState(ORG_ORIGIN)
    const response = await callback(callbackRequest(ORG_ORIGIN, stateParam, cookie))
    expect(completeMetaOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: `${ORG_ORIGIN}${OAUTH_CALLBACK_PATH}` }),
    )
    expect(response.headers.get('location')).toBe(`${ORG_ORIGIN}/backend/meta-lead-ads?connect=ok`)
  })

  it('rejects a callback that arrives on another address without exchanging the code', async () => {
    ownAppUrl = ORG_ORIGIN
    const { cookie, stateParam } = await startAndReadState(ORG_ORIGIN)
    const response = await callback(callbackRequest(APP_ORIGIN, stateParam, cookie))
    expect(completeMetaOAuthMock).not.toHaveBeenCalled()
    expect(response.headers.get('location')).toBe(`${ORG_ORIGIN}/backend/meta-lead-ads?connect=state_mismatch`)
  })

  it('keeps the installation address flow unchanged when the organization has no address', async () => {
    const { location, cookie, stateParam, payload } = await startAndReadState(APP_ORIGIN)
    expect(location.searchParams.get('redirect_uri')).toBe(`${APP_ORIGIN}${OAUTH_CALLBACK_PATH}`)
    expect(payload.redirectOrigin ?? null).toBeNull()

    const response = await callback(callbackRequest(APP_ORIGIN, stateParam, cookie))
    expect(completeMetaOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri: `${APP_ORIGIN}${OAUTH_CALLBACK_PATH}` }),
    )
    expect(response.headers.get('location')).toBe(`${APP_ORIGIN}/backend/meta-lead-ads?connect=ok`)
  })
})

describe('GET /api/meta_lead_ads/settings oauthRedirectUri', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test', APP_URL: APP_ORIGIN, APP_ALLOWED_ORIGINS: ORG_ORIGIN }
    getOrgSettingsMock.mockResolvedValue({ id: null, retentionDays: 90, defaultCountry: 'PL', updatedAt: null })
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  async function readSettings(container: { resolve: (name: string) => unknown }) {
    resolveRouteContextMock.mockResolvedValue({
      container,
      em: {},
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      userId: 'user-1',
      translate: (key: string, fallback?: string) => fallback ?? key,
    })
    const response = await getSettings(new Request(`${APP_ORIGIN}/api/meta_lead_ads/settings`))
    return (await response.json()) as { oauthRedirectUri: string | null }
  }

  it('returns the organization callback when the organization has an address', async () => {
    ownAppUrl = ORG_ORIGIN
    const body = await readSettings(buildContainer())
    expect(body.oauthRedirectUri).toBe(`${ORG_ORIGIN}${OAUTH_CALLBACK_PATH}`)
  })

  it('falls back to the installation callback', async () => {
    ownAppUrl = null
    const body = await readSettings(buildContainer())
    expect(body.oauthRedirectUri).toBe(`${APP_ORIGIN}${OAUTH_CALLBACK_PATH}`)
  })

  it('returns null when no callback can be built', async () => {
    ownAppUrl = null
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'production', APP_URL: '', NEXT_PUBLIC_APP_URL: '', APP_ALLOWED_ORIGINS: '' }
    const body = await readSettings(buildContainer())
    expect(body.oauthRedirectUri).toBeNull()
  })
})

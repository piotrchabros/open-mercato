import { expect, test } from '@playwright/test'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import type { ConnectionDto, SettingsDto } from '../api/openapi'
import { BACKEND_PATH, OAUTH_CALLBACK_PATH, OAUTH_STATE_COOKIE } from '../lib/constants'
import { setupMetaTestEnv, type MetaTestEnv } from './support/fixtures'

export const integrationMeta = {
  description: 'Meta OAuth bound to the per-organization app URL',
  dependsOnModules: ['meta_lead_ads', 'directory'],
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost']

type ListResponse<Item> = { items?: Item[] }

function resolveAlternateOrigin(baseUrl: string | undefined): { baseOrigin: string; alternate: string } | null {
  if (!baseUrl) return null
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return null
  }
  if (!LOOPBACK_HOSTS.includes(parsed.hostname)) return null
  const alternateUrl = new URL(parsed.origin)
  alternateUrl.hostname = parsed.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1'
  return { baseOrigin: parsed.origin, alternate: alternateUrl.origin }
}

function orgRequest(env: MetaTestEnv, method: string, path: string, data?: unknown) {
  return apiRequestWithSelectedOrg(env.request, method, path, { token: env.token, selectedOrgId: env.orgId, data })
}

function authHeaders(env: MetaTestEnv, extraCookie?: string) {
  const cookies = [`om_selected_org=${env.orgId}`, ...(extraCookie ? [extraCookie] : [])].join('; ')
  return { Authorization: `Bearer ${env.token}`, Cookie: cookies }
}

async function initiateOAuth(env: MetaTestEnv, origin: string) {
  const response = await env.request.fetch(`${origin}/api/meta_lead_ads/oauth/initiate`, {
    method: 'GET',
    headers: authHeaders(env),
    maxRedirects: 0,
  })
  expect(response.status(), 'GET oauth/initiate should redirect').toBe(302)
  const location = response.headers()['location']
  expect(location, 'oauth/initiate should set Location').toBeTruthy()
  const stateCookie = response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .flatMap((header) => header.value.split('\n'))
    .map((value) => value.split(';')[0].trim())
    .find((value) => value.startsWith(`${OAUTH_STATE_COOKIE}=`))
  return { location: location as string, stateCookie: stateCookie ?? null }
}

/**
 * TC-META-010: Meta OAuth uses the organization's own app URL
 * Covers: PUT /api/directory/organizations (appUrl), GET /api/meta_lead_ads/oauth/initiate,
 * GET /api/meta_lead_ads/oauth/callback, GET /api/meta_lead_ads/settings
 *
 * With an organization address set, the OAuth redirect URI points at that address, a callback arriving
 * on another address is rejected as a state mismatch, starting OAuth from another address bounces to
 * the organization's own backend page, and the settings show the organization's callback URI.
 */
test.describe('TC-META-010: Meta OAuth with a per-organization app URL', () => {
  test('binds OAuth to the organization address and rejects other origins', async ({ request }) => {
    const origins = resolveAlternateOrigin(process.env.BASE_URL?.trim())
    test.skip(!origins, 'BASE_URL must be a loopback address to swap the host for the alternate origin.')
    const { baseOrigin, alternate } = origins as { baseOrigin: string; alternate: string }

    const env = await setupMetaTestEnv(request)
    try {
      const setResponse = await apiRequest(request, 'PUT', '/api/directory/organizations', {
        token: env.token,
        data: { id: env.orgId, appUrl: alternate },
      })
      expect(setResponse.status(), 'PUT appUrl should succeed').toBe(200)

      const fromAlternate = await initiateOAuth(env, alternate)
      const redirectUri = new URL(fromAlternate.location).searchParams.get('redirect_uri')
      expect(redirectUri, 'Login dialog URL should carry redirect_uri').toBeTruthy()
      expect((redirectUri as string).startsWith(`${alternate}${OAUTH_CALLBACK_PATH}`)).toBe(true)
      const state = new URL(fromAlternate.location).searchParams.get('state')
      expect(state, 'Login dialog URL should carry state').toBeTruthy()
      expect(fromAlternate.stateCookie, 'oauth/initiate should set the state cookie').toBeTruthy()

      const callback = await env.request.fetch(
        `${baseOrigin}${OAUTH_CALLBACK_PATH}?code=fake&state=${encodeURIComponent(state as string)}`,
        { method: 'GET', headers: authHeaders(env, fromAlternate.stateCookie as string), maxRedirects: 0 },
      )
      expect([302, 303, 307], 'GET oauth/callback should redirect').toContain(callback.status())
      const callbackLocation = new URL(callback.headers()['location'], baseOrigin)
      expect(callbackLocation.searchParams.get('connect')).toBe('state_mismatch')

      const connectionsResponse = await orgRequest(env, 'GET', '/api/meta_lead_ads/connections')
      expect(connectionsResponse.status()).toBe(200)
      const connections = ((await readJsonSafe<ListResponse<ConnectionDto>>(connectionsResponse)) ?? {}).items ?? []
      expect(connections).toHaveLength(0)

      const fromBase = await initiateOAuth(env, baseOrigin)
      expect(fromBase.location).toBe(`${alternate}${BACKEND_PATH}?connect=wrong_origin`)

      const settingsResponse = await orgRequest(env, 'GET', '/api/meta_lead_ads/settings')
      expect(settingsResponse.status()).toBe(200)
      const settings = await readJsonSafe<SettingsDto>(settingsResponse)
      expect(settings?.oauthRedirectUri).toBe(`${alternate}${OAUTH_CALLBACK_PATH}`)
    } finally {
      await apiRequest(request, 'PUT', '/api/directory/organizations', {
        token: env.token,
        data: { id: env.orgId, appUrl: null },
      }).catch(() => undefined)
      await env.cleanup()
    }
  })
})

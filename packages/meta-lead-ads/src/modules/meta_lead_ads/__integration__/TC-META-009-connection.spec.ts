import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import type { AvailablePageDto, ConnectionDto, PageDto } from '../api/openapi'
import { OAUTH_STATE_COOKIE } from '../lib/constants'
import { assignFakePage, connectFakeMetaAccount, setupMetaTestEnv, type MetaTestEnv } from './support/fixtures'

const BASE_URL = process.env.BASE_URL?.trim() || null
const FORBIDDEN_TOKEN_FIELDS = ['userAccessToken', 'pageAccessToken', 'accessToken', 'access_token', 'appSecret']

type ListResponse<Item> = { items?: Item[] }

function resolveUrl(path: string): string {
  return BASE_URL ? `${BASE_URL}${path}` : path
}

function orgRequest(env: MetaTestEnv, method: string, path: string, data?: unknown) {
  return apiRequestWithSelectedOrg(env.request, method, path, { token: env.token, selectedOrgId: env.orgId, data })
}

async function initiateOAuth(env: MetaTestEnv): Promise<{ state: string; stateCookie: string }> {
  const response = await env.request.fetch(resolveUrl('/api/meta_lead_ads/oauth/initiate'), {
    method: 'GET',
    headers: { Authorization: `Bearer ${env.token}`, Cookie: `om_selected_org=${env.orgId}` },
    maxRedirects: 0,
  })
  expect(response.status()).toBe(302)
  const state = new URL(response.headers()['location']).searchParams.get('state')
  const stateCookie = response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .flatMap((header) => header.value.split('\n'))
    .map((value) => value.split(';')[0].trim())
    .find((value) => value.startsWith(`${OAUTH_STATE_COOKIE}=`))
  expect(state).toBeTruthy()
  expect(stateCookie).toBeTruthy()
  return { state: state as string, stateCookie: stateCookie as string }
}

async function callCallback(env: MetaTestEnv, state: string, stateCookie: string | null) {
  const cookies = [`om_selected_org=${env.orgId}`, ...(stateCookie ? [stateCookie] : [])].join('; ')
  const response = await env.request.fetch(
    resolveUrl(`/api/meta_lead_ads/oauth/callback?code=fake&state=${encodeURIComponent(state)}`),
    { method: 'GET', headers: { Authorization: `Bearer ${env.token}`, Cookie: cookies }, maxRedirects: 0 },
  )
  expect([302, 303, 307]).toContain(response.status())
  return new URL(response.headers()['location'], 'http://localhost').searchParams.get('connect')
}

async function listConnections(env: MetaTestEnv): Promise<{ raw: string; items: ConnectionDto[] }> {
  const response = await orgRequest(env, 'GET', '/api/meta_lead_ads/connections')
  expect(response.status()).toBe(200)
  const raw = await response.text()
  const body = (await readJsonSafe<ListResponse<ConnectionDto>>(response)) ?? {}
  return { raw, items: body.items ?? [] }
}

async function listPages(env: MetaTestEnv): Promise<PageDto[]> {
  const response = await orgRequest(env, 'GET', '/api/meta_lead_ads/pages?pageSize=100')
  expect(response.status()).toBe(200)
  return ((await readJsonSafe<ListResponse<PageDto>>(response)) ?? {}).items ?? []
}

async function deleteConnection(request: APIRequestContext, env: MetaTestEnv, id: string, expectedUpdatedAt: string) {
  return request.fetch(resolveUrl(`/api/meta_lead_ads/connections/${id}`), {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${env.token}`,
      'Content-Type': 'application/json',
      Cookie: `om_selected_org=${env.orgId}`,
      [OPTIMISTIC_LOCK_HEADER_NAME]: expectedUpdatedAt,
    },
  })
}

test.describe('TC-META-009: Meta connection and page lifecycle', () => {
  test('rejects a forged or reused OAuth state', async ({ request }) => {
    const env = await setupMetaTestEnv(request)
    try {
      expect(await callCallback(env, 'forged-state-value', null)).toBe('state_mismatch')

      const first = await initiateOAuth(env)
      expect(await callCallback(env, `${first.state}-tampered`, first.stateCookie)).toBe('state_mismatch')

      const second = await initiateOAuth(env)
      expect(await callCallback(env, second.state, second.stateCookie)).toBe('ok')
      expect(await callCallback(env, second.state, second.stateCookie)).toBe('state_mismatch')
    } finally {
      await env.cleanup()
    }
  })

  test('connects, assigns a page, detects missing leads access, and disconnects with optimistic locking', async ({
    request,
  }) => {
    const env = await setupMetaTestEnv(request)
    try {
      const metaPageId = `fake-page-${Date.now()}`
      env.fake.state.pages.push({
        id: metaPageId,
        name: 'Lifecycle Page',
        accessToken: `fake-page-token-${metaPageId}`,
        tasks: ['ADVERTISE', 'MANAGE'],
      })

      const connection = await connectFakeMetaAccount(env)
      const listing = await listConnections(env)
      for (const field of FORBIDDEN_TOKEN_FIELDS) expect(listing.raw).not.toContain(field)
      expect(listing.raw).not.toContain('fake-long-lived-user-token')
      expect(listing.raw).not.toContain(`fake-page-token-${metaPageId}`)

      const availableResponse = await orgRequest(
        env,
        'GET',
        `/api/meta_lead_ads/connections/${connection.id}/available-pages`,
      )
      expect(availableResponse.status()).toBe(200)
      const available = ((await readJsonSafe<ListResponse<AvailablePageDto>>(availableResponse)) ?? {}).items ?? []
      expect(available.find((item) => item.metaPageId === metaPageId)?.assignable).toBe(true)

      const page = await assignFakePage(env, connection.id, metaPageId)
      expect(page.subscriptionStatus).toBe('active')
      expect(
        env.fake.state.calls.some((call) => call.method === 'POST' && call.path === `/${metaPageId}/subscribed_apps`),
      ).toBe(true)

      const duplicate = await orgRequest(env, 'POST', '/api/meta_lead_ads/pages', {
        connectionId: connection.id,
        metaPageId,
        organizationId: env.orgId,
      })
      expect(duplicate.status()).toBe(409)
      expect((await readJsonSafe<{ code?: string }>(duplicate))?.code).toBe('page_already_assigned')

      env.fake.state.failMode = 'leads_access'
      const checkResponse = await orgRequest(env, 'POST', `/api/meta_lead_ads/pages/${page.id}/check`)
      expect(checkResponse.status()).toBe(200)
      expect((await readJsonSafe<{ subscriptionStatus?: string }>(checkResponse))?.subscriptionStatus).toBe(
        'no_leads_access',
      )
      env.fake.state.failMode = 'none'

      const stale = await deleteConnection(request, env, connection.id, '2000-01-01T00:00:00.000Z')
      expect(stale.status()).toBe(409)
      expect((await readJsonSafe<{ code?: string }>(stale))?.code).toBe('optimistic_lock_conflict')

      const current = (await listConnections(env)).items.find((item) => item.id === connection.id)
      expect(current).toBeTruthy()
      const removed = await deleteConnection(request, env, connection.id, (current as ConnectionDto).updatedAt)
      expect(removed.status()).toBe(200)
      expect(
        env.fake.state.calls.some((call) => call.method === 'DELETE' && call.path === `/${metaPageId}/subscribed_apps`),
      ).toBe(true)
      expect((await listPages(env)).some((item) => item.id === page.id)).toBe(false)
    } finally {
      await env.cleanup()
    }
  })

  test('renders the Connections and Pages sections for an admin', async ({ page }) => {
    await login(page, 'admin')
    await page.goto('/backend/meta-lead-ads')
    await expect(page.getByRole('heading', { name: 'Meta connections' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Pages', exact: true })).toBeVisible()
  })
})

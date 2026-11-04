import { expect, type APIRequestContext } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  apiRequestWithSelectedOrg,
  createOrganizationFixture,
  deleteOrganizationIfExists,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import { expectId, getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import type { ConnectionDto, FormDto, PageDto } from '../../api/openapi'
import type { GraphFormQuestion } from '../../data/validators'
import { INTEGRATION_ID, OAUTH_STATE_COOKIE } from '../../lib/constants'
import { startFakeGraphServer, type FakeGraphServer } from './fake-graph-server'
import { TEST_APP_SECRET } from './sign'

export const TEST_VERIFY_TOKEN = 'meta-lead-ads-test-verify-token'
export const TEST_APP_ID = '1234567890123456'
export const TEST_LOGIN_CONFIG_ID = '6543210987654321'
const TEST_RETRY_DELAYS_MS = '50,50,50,50'

const BASE_URL = process.env.BASE_URL?.trim() || null

export type MetaTestEnv = {
  request: APIRequestContext
  token: string
  orgId: string
  tenantId: string
  fake: FakeGraphServer
  cleanup(): Promise<void>
}

type ListResponse<Item> = { items?: Item[] }

type SeedFakeFormInput = {
  pageId: string
  metaPageId: string
  metaFormId: string
  name?: string
  questions?: GraphFormQuestion[]
}

const DEFAULT_QUESTIONS: GraphFormQuestion[] = [
  { key: 'full_name', label: 'Full name', type: 'FULL_NAME' },
  { key: 'email', label: 'Email', type: 'EMAIL' },
  { key: 'phone_number', label: 'Phone number', type: 'PHONE' },
  { key: 'company_name', label: 'Company name', type: 'COMPANY_NAME' },
]

function resolveUrl(path: string): string {
  return BASE_URL ? `${BASE_URL}${path}` : path
}

function orgRequest(env: MetaTestEnv, method: string, path: string, data?: unknown) {
  return apiRequestWithSelectedOrg(env.request, method, path, { token: env.token, selectedOrgId: env.orgId, data })
}

export async function setupMetaTestEnv(request: APIRequestContext): Promise<MetaTestEnv> {
  const token = await getAuthToken(request, 'superadmin')
  const { tenantId } = getTokenContext(token)
  const fake = await startFakeGraphServer()
  let orgId: string | null = null
  try {
    orgId = await createOrganizationFixture(request, token, {
      name: `Meta Lead Ads ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    })
    const env: MetaTestEnv = {
      request,
      token,
      orgId,
      tenantId,
      fake,
      cleanup: () => cleanupMetaTestEnv(env),
    }
    const credentialsResponse = await orgRequest(env, 'PUT', `/api/integrations/${INTEGRATION_ID}/credentials`, {
      credentials: {
        appId: TEST_APP_ID,
        appSecret: TEST_APP_SECRET,
        verifyToken: TEST_VERIFY_TOKEN,
        loginConfigId: TEST_LOGIN_CONFIG_ID,
        graphBaseUrl: fake.baseUrl,
        retryDelaysMs: TEST_RETRY_DELAYS_MS,
      },
    })
    expect(credentialsResponse.ok(), 'PUT integration credentials should succeed').toBeTruthy()
    const stateResponse = await orgRequest(env, 'PUT', `/api/integrations/${INTEGRATION_ID}/state`, {
      isEnabled: true,
    })
    expect(stateResponse.ok(), 'PUT integration state should succeed').toBeTruthy()
    return env
  } catch (error) {
    await fake.close().catch(() => undefined)
    await deleteOrganizationIfExists(request, token, orgId)
    throw error
  }
}

function readSetCookieHeaders(headers: { name: string; value: string }[]): string[] {
  return headers.filter((header) => header.name.toLowerCase() === 'set-cookie').flatMap((header) => header.value.split('\n'))
}

export async function connectFakeMetaAccount(env: MetaTestEnv): Promise<ConnectionDto> {
  const selectedOrgCookie = `om_selected_org=${env.orgId}`
  const authHeaders = { Authorization: `Bearer ${env.token}`, Cookie: selectedOrgCookie }
  const initiate = await env.request.fetch(resolveUrl('/api/meta_lead_ads/oauth/initiate'), {
    method: 'GET',
    headers: authHeaders,
    maxRedirects: 0,
  })
  expect(initiate.status(), 'GET oauth/initiate should redirect').toBe(302)
  const location = initiate.headers()['location']
  expect(location, 'oauth/initiate should set Location').toBeTruthy()
  const state = new URL(location).searchParams.get('state')
  expect(state, 'Login dialog URL should carry state').toBeTruthy()
  const stateCookie = readSetCookieHeaders(initiate.headersArray())
    .map((value) => value.split(';')[0].trim())
    .find((value) => value.startsWith(`${OAUTH_STATE_COOKIE}=`))
  expect(stateCookie, 'oauth/initiate should set the state cookie').toBeTruthy()

  const callback = await env.request.fetch(
    resolveUrl(`/api/meta_lead_ads/oauth/callback?code=fake&state=${encodeURIComponent(state as string)}`),
    {
      method: 'GET',
      headers: { ...authHeaders, Cookie: `${selectedOrgCookie}; ${stateCookie}` },
      maxRedirects: 0,
    },
  )
  expect([302, 303, 307], 'GET oauth/callback should redirect to the backend page').toContain(callback.status())

  const connectionsResponse = await orgRequest(env, 'GET', '/api/meta_lead_ads/connections')
  expect(connectionsResponse.status(), 'GET connections should return 200').toBe(200)
  const body = await readJsonSafe<ListResponse<ConnectionDto>>(connectionsResponse)
  const connection = body?.items?.find((item) => item.metaUserId === env.fake.state.user.id)
  expect(connection, 'Connection should exist after the OAuth callback').toBeTruthy()
  return connection as ConnectionDto
}

export async function assignFakePage(
  env: MetaTestEnv,
  connectionId: string,
  metaPageId: string,
  name: string = `Fake Page ${metaPageId}`,
): Promise<PageDto> {
  if (!env.fake.state.pages.some((page) => page.id === metaPageId)) {
    env.fake.state.pages.push({ id: metaPageId, name, accessToken: `fake-page-token-${metaPageId}`, tasks: ['ADVERTISE', 'MANAGE'] })
  }
  const response = await orgRequest(env, 'POST', '/api/meta_lead_ads/pages', {
    connectionId,
    metaPageId,
    organizationId: env.orgId,
  })
  expect(response.status(), 'POST pages should return 201').toBe(201)
  const page = await readJsonSafe<PageDto>(response)
  expectId(page?.id, 'Page assignment response should include id')
  return page as PageDto
}

export async function seedFakeForm(env: MetaTestEnv, input: SeedFakeFormInput): Promise<FormDto> {
  const existing = env.fake.state.formsByPage.get(input.metaPageId) ?? []
  const questions = input.questions ?? DEFAULT_QUESTIONS
  env.fake.state.formsByPage.set(input.metaPageId, [
    ...existing.filter((form) => form.id !== input.metaFormId),
    { id: input.metaFormId, name: input.name ?? `Fake Form ${input.metaFormId}`, locale: 'en_US', status: 'ACTIVE', questions },
  ])
  const syncResponse = await orgRequest(env, 'POST', `/api/meta_lead_ads/pages/${input.pageId}/sync-forms`)
  expect(syncResponse.status(), 'POST sync-forms should return 200').toBe(200)
  const listResponse = await orgRequest(
    env,
    'GET',
    `/api/meta_lead_ads/forms?pageId=${encodeURIComponent(input.pageId)}&pageSize=100`,
  )
  expect(listResponse.status(), 'GET forms should return 200').toBe(200)
  const body = await readJsonSafe<ListResponse<FormDto>>(listResponse)
  const form = body?.items?.find((item) => item.metaFormId === input.metaFormId)
  expect(form, 'Synced form should be listed').toBeTruthy()
  return form as FormDto
}

type CrmRefs = { personIds: string[]; companyIds: string[]; dealIds: string[] }

async function collectCrmRefs(orgId: string): Promise<CrmRefs> {
  const rows = await withClient(async (client) => {
    const result = await client.query<{ person_id: string | null; company_id: string | null; deal_id: string | null }>(
      'select person_id, company_id, deal_id from meta_lead_ads_lead_events where organization_id = $1',
      [orgId],
    )
    return result.rows
  }).catch(() => [])
  const unique = (values: (string | null)[]) => Array.from(new Set(values.filter((value): value is string => !!value)))
  return {
    personIds: unique(rows.map((row) => row.person_id)),
    companyIds: unique(rows.map((row) => row.company_id)),
    dealIds: unique(rows.map((row) => row.deal_id)),
  }
}

const ORG_TABLES_IN_DELETE_ORDER = [
  'meta_lead_ads_consents',
  'meta_lead_ads_person_keys',
  'meta_lead_ads_lead_events',
  'meta_lead_ads_sync_runs',
  'meta_lead_ads_forms',
  'meta_lead_ads_pages',
  'meta_lead_ads_connections',
  'meta_lead_ads_settings',
  'meta_lead_ads_deletion_requests',
] as const

async function cleanupMetaTestEnv(env: MetaTestEnv): Promise<void> {
  const refs = await collectCrmRefs(env.orgId)
  const deleteInOrg = async (path: string, id: string) => {
    await apiRequestWithSelectedOrg(env.request, 'DELETE', path, {
      token: env.token,
      selectedOrgId: env.orgId,
      data: { id },
    }).catch(() => undefined)
  }
  for (const dealId of refs.dealIds) await deleteInOrg('/api/customers/deals', dealId)
  for (const personId of refs.personIds) await deleteInOrg('/api/customers/people', personId)
  for (const companyId of refs.companyIds) await deleteInOrg('/api/customers/companies', companyId)
  await withClient(async (client) => {
    for (const table of ORG_TABLES_IN_DELETE_ORDER) {
      await client.query(`delete from ${table} where organization_id = $1`, [env.orgId])
    }
  }).catch(() => undefined)
  await deleteOrganizationIfExists(env.request, env.token, env.orgId)
  await env.fake.close().catch(() => undefined)
}


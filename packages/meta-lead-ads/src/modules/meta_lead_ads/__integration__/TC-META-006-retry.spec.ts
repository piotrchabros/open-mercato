import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  apiRequestWithSelectedOrg,
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  getAuthToken,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import type { GraphLead } from '../data/validators'
import type { LeadEventSummaryDto, PageDto } from '../api/openapi'
import {
  FETCH_FAILED_ALERT_ATTEMPT,
  INTEGRATION_ID,
  MAX_AUTOMATIC_ATTEMPTS,
  QUEUES,
  WEBHOOK_PATH,
} from '../lib/constants'
import { NOTIFICATION_TYPES } from '../notifications'
import {
  assignFakePage,
  connectFakeMetaAccount,
  seedFakeForm,
  setupMetaTestEnv,
  TEST_APP_ID,
  TEST_LOGIN_CONFIG_ID,
  TEST_VERIFY_TOKEN,
  type MetaTestEnv,
} from './support/fixtures'
import { buildLeadgenNotification, signBody, TEST_APP_SECRET } from './support/sign'

const BASE_URL = process.env.BASE_URL?.trim() || null
const POLL_TIMEOUT_MS = 90_000
const OBSERVABLE_RETRY_DELAYS_MS = '10000,50,50,50'

type ListResponse<Item> = { items?: Item[] }
type Observation = { status: string; attemptCount: number }
type NotificationRow = { type: string; attempt_count: string | null }

function resolveUrl(path: string): string {
  return BASE_URL ? `${BASE_URL}${path}` : path
}

function orgRequest(env: MetaTestEnv, method: string, path: string, data?: unknown, token: string = env.token) {
  return apiRequestWithSelectedOrg(env.request, method, path, { token, selectedOrgId: env.orgId, data })
}

function buildGraphLead(input: { leadId: string; metaFormId: string; email: string }): GraphLead {
  return {
    id: input.leadId,
    created_time: new Date().toISOString().replace(/\.\d{3}Z$/, '+0000'),
    form_id: input.metaFormId,
    platform: 'fb',
    is_organic: false,
    field_data: [
      { name: 'full_name', values: ['Retry Lead'] },
      { name: 'email', values: [input.email] },
    ],
  }
}

async function sendLead(env: MetaTestEnv, metaPageId: string, leadId: string, metaFormId: string): Promise<void> {
  const raw = buildLeadgenNotification([{ pageId: metaPageId, leads: [{ leadId, formId: metaFormId }] }])
  const response = await env.request.fetch(resolveUrl(WEBHOOK_PATH), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signBody(raw) },
    data: raw,
  })
  expect(response.status(), 'Signed webhook should be accepted').toBe(200)
}

async function listLeadEvents(env: MetaTestEnv, token: string = env.token) {
  const response = await orgRequest(env, 'GET', '/api/meta_lead_ads/lead-events?pageSize=100', undefined, token)
  const raw = await response.text()
  const body = (await readJsonSafe<ListResponse<LeadEventSummaryDto>>(response)) ?? {}
  return { status: response.status(), raw, items: body.items ?? [] }
}

async function findLeadEvent(env: MetaTestEnv, metaLeadId: string): Promise<LeadEventSummaryDto | null> {
  const { items } = await listLeadEvents(env)
  return items.find((item) => item.metaLeadId === metaLeadId) ?? null
}

async function waitForStatus(
  env: MetaTestEnv,
  metaLeadId: string,
  status: string,
  observations: Observation[] = [],
): Promise<LeadEventSummaryDto> {
  await expect
    .poll(
      async () => {
        await drainIntegrationQueue(QUEUES.process)
        const event = await findLeadEvent(env, metaLeadId)
        if (event) observations.push({ status: event.status, attemptCount: event.attemptCount })
        return event?.status ?? null
      },
      { message: `Lead ${metaLeadId} should reach ${status}`, timeout: POLL_TIMEOUT_MS, intervals: [100, 250, 500] },
    )
    .toBe(status)
  return (await findLeadEvent(env, metaLeadId)) as LeadEventSummaryDto
}

async function storeRetryDelays(env: MetaTestEnv, retryDelaysMs: string): Promise<void> {
  const response = await orgRequest(env, 'PUT', `/api/integrations/${INTEGRATION_ID}/credentials`, {
    credentials: {
      appId: TEST_APP_ID,
      appSecret: TEST_APP_SECRET,
      verifyToken: TEST_VERIFY_TOKEN,
      loginConfigId: TEST_LOGIN_CONFIG_ID,
      graphBaseUrl: env.fake.baseUrl,
      retryDelaysMs,
    },
  })
  expect(response.ok(), 'PUT integration credentials with retry delays should succeed').toBeTruthy()
}

async function readNotifications(leadEventId: string): Promise<NotificationRow[]> {
  return withClient(async (client) => {
    const result = await client.query<NotificationRow>(
      "select type, body_variables->>'attemptCount' as attempt_count from notifications where source_entity_id = $1 and type = any($2)",
      [leadEventId, [NOTIFICATION_TYPES.leadFetchFailed, NOTIFICATION_TYPES.leadDeadLettered]],
    )
    return result.rows
  })
}

async function deleteModuleNotifications(organizationId: string): Promise<void> {
  await withClient(async (client) => {
    await client.query("delete from notifications where organization_id = $1 and type like 'meta_lead_ads.%'", [
      organizationId,
    ])
  }).catch(() => undefined)
}

test.describe('TC-META-006: Retry, dead letter and alerts', () => {
  test('retries transient failures, dead-letters, alerts, and supports manual retry', async ({ request }) => {
    test.setTimeout(300_000)
    let env: MetaTestEnv | null = null
    let roleId: string | null = null
    let viewerUserId: string | null = null
    try {
      env = await setupMetaTestEnv(request)
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`
      const metaPageId = `retry-page-${suffix}`
      const metaFormId = `retry-form-${suffix}`
      const transientLeadId = `retry-lead-transient-${suffix}`
      const leadsAccessLeadId = `retry-lead-access-${suffix}`

      const connection = await connectFakeMetaAccount(env)
      const page = await assignFakePage(env, connection.id, metaPageId, 'Retry Page')
      await seedFakeForm(env, { pageId: page.id, metaPageId, metaFormId })
      env.fake.state.leads.set(
        transientLeadId,
        buildGraphLead({ leadId: transientLeadId, metaFormId, email: `retry-t-${suffix}@example.com` }),
      )
      env.fake.state.leads.set(
        leadsAccessLeadId,
        buildGraphLead({ leadId: leadsAccessLeadId, metaFormId, email: `retry-a-${suffix}@example.com` }),
      )

      await storeRetryDelays(env, OBSERVABLE_RETRY_DELAYS_MS)
      const observations: Observation[] = []
      env.fake.state.failMode = '500'
      await sendLead(env, metaPageId, transientLeadId, metaFormId)
      const retrying = await waitForStatus(env, transientLeadId, 'retrying', observations)
      expect(retrying.attemptCount).toBe(1)
      expect(retrying.lastErrorCode).toBe('graph_transient')
      const deadLettered = await waitForStatus(env, transientLeadId, 'dead_lettered', observations)
      expect(deadLettered.attemptCount).toBe(MAX_AUTOMATIC_ATTEMPTS)
      expect(deadLettered.lastErrorCode).toBe('graph_transient')
      expect(observations.some((entry) => entry.status === 'retrying'), 'Event should pass through retrying').toBe(true)
      const attemptCounts = observations.map((entry) => entry.attemptCount)
      expect(attemptCounts).toEqual([...attemptCounts].sort((left, right) => left - right))
      const leadFetches = env.fake.state.calls.filter((call) => call.method === 'GET' && call.path === `/${transientLeadId}`)
      expect(leadFetches).toHaveLength(MAX_AUTOMATIC_ATTEMPTS)

      const notifications = await readNotifications(deadLettered.id)
      const fetchFailed = notifications.filter((row) => row.type === NOTIFICATION_TYPES.leadFetchFailed)
      expect(fetchFailed.length, 'Fetch-failed alert should be sent').toBeGreaterThan(0)
      expect(fetchFailed.every((row) => row.attempt_count === String(FETCH_FAILED_ALERT_ATTEMPT))).toBe(true)
      expect(
        notifications.some((row) => row.type === NOTIFICATION_TYPES.leadDeadLettered),
        'Dead-letter alert should be sent',
      ).toBe(true)

      env.fake.state.failMode = 'none'
      const retry = await orgRequest(env, 'POST', '/api/meta_lead_ads/lead-events/retry', { ids: [deadLettered.id] })
      expect(retry.status(), 'Manual retry should return 200').toBe(200)
      expect((await readJsonSafe<{ enqueued?: number }>(retry))?.enqueued).toBe(1)
      const processed = await waitForStatus(env, transientLeadId, 'processed')
      expect(processed.manualRetryCount).toBe(1)
      expect(processed.personId).toBeTruthy()

      env.fake.state.failMode = 'leads_access'
      await sendLead(env, metaPageId, leadsAccessLeadId, metaFormId)
      const failed = await waitForStatus(env, leadsAccessLeadId, 'failed')
      expect(failed.lastErrorCode).toBe('no_leads_access')
      const pagesResponse = await orgRequest(env, 'GET', '/api/meta_lead_ads/pages?pageSize=100')
      expect(pagesResponse.status()).toBe(200)
      const pages = ((await readJsonSafe<ListResponse<PageDto>>(pagesResponse)) ?? {}).items ?? []
      expect(pages.find((item) => item.id === page.id)?.subscriptionStatus).toBe('no_leads_access')
      env.fake.state.failMode = 'none'

      const stamp = randomUUID().slice(0, 8)
      const viewerEmail = `meta-viewer-${stamp}@example.com`
      const viewerPassword = `Secret-${stamp}!`
      roleId = await createRoleFixture(request, env.token, { name: `Meta viewer ${stamp}`, tenantId: env.tenantId })
      await setRoleAclFeatures(request, env.token, {
        roleId,
        features: ['meta_lead_ads.view_logs'],
        organizations: null,
      })
      viewerUserId = await createUserFixture(request, env.token, {
        email: viewerEmail,
        password: viewerPassword,
        organizationId: env.orgId,
        roles: [roleId],
      })
      const viewerToken = await getAuthToken(request, viewerEmail, viewerPassword)

      const viewerList = await listLeadEvents(env, viewerToken)
      expect(viewerList.status, 'view_logs user can list lead events').toBe(200)
      expect(viewerList.items.some((item) => item.id === failed.id)).toBe(true)
      const adminList = await listLeadEvents(env)
      for (const listing of [viewerList, adminList]) {
        expect(listing.raw).not.toContain('rawPayload')
        expect(listing.raw).not.toContain('raw_payload')
        expect(listing.raw).not.toContain('rawNotification')
        expect(listing.raw).not.toContain(`retry-a-${suffix}@example.com`)
      }

      const forbidden = await orgRequest(
        env,
        'POST',
        '/api/meta_lead_ads/lead-events/retry',
        { ids: [failed.id] },
        viewerToken,
      )
      expect(forbidden.status(), 'view_logs user must not retry').toBe(403)
      const unchanged = await findLeadEvent(env, leadsAccessLeadId)
      expect(unchanged?.status).toBe('failed')
      expect(unchanged?.manualRetryCount).toBe(0)
    } finally {
      if (env) {
        await deleteModuleNotifications(env.orgId)
        await deleteUserIfExists(request, env.token, viewerUserId)
        await deleteRoleIfExists(request, env.token, roleId)
        await env.cleanup()
      }
    }
  })
})

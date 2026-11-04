import { expect, test } from '@playwright/test'
import { readIntegrationEnv } from '@open-mercato/core/helpers/integration/standaloneEnv'
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import type { LeadEventSummaryDto } from '../api/openapi'
import { assignFakePage, connectFakeMetaAccount, seedFakeForm, setupMetaTestEnv, type MetaTestEnv } from './support/fixtures'
import { buildLeadgenNotification, signBody } from './support/sign'

const BASE_URL = process.env.BASE_URL?.trim() || null
const WEBHOOK_PATH = '/api/meta_lead_ads/webhook'
const OVERSIZED_BODY_BYTES = 1024 * 1024 + 4096

function resolveUrl(path: string): string {
  return BASE_URL ? `${BASE_URL}${path}` : path
}

function uniqueSuffix(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}

async function listLeadEvents(env: MetaTestEnv): Promise<LeadEventSummaryDto[]> {
  const response = await apiRequestWithSelectedOrg(env.request, 'GET', '/api/meta_lead_ads/lead-events?pageSize=100', {
    token: env.token,
    selectedOrgId: env.orgId,
  })
  expect(response.status(), 'GET lead-events should return 200').toBe(200)
  const body = await readJsonSafe<{ items?: LeadEventSummaryDto[] }>(response)
  return body?.items ?? []
}

async function postWebhook(env: MetaTestEnv, rawBody: string, headers: Record<string, string>) {
  return env.request.fetch(resolveUrl(WEBHOOK_PATH), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    data: rawBody,
  })
}

/**
 * TC-META-001: Meta Lead Ads webhook verification and request hardening
 * Maps to quickstart scenarios 1 and 2 (FR-014, FR-015).
 */
test.describe('TC-META-001: Meta Lead Ads webhook verification', () => {
  test('GET verify echoes the challenge as text/plain for the configured token', async ({ request }) => {
    const verifyToken = readIntegrationEnv('OM_META_LEAD_ADS_VERIFY_TOKEN')
    test.skip(!verifyToken, 'OM_META_LEAD_ADS_VERIFY_TOKEN is not configured for this environment')
    const challenge = `challenge-${uniqueSuffix()}`
    const response = await request.fetch(
      resolveUrl(
        `${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken as string)}&hub.challenge=${challenge}`,
      ),
      { method: 'GET' },
    )
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('text/plain')
    expect(await response.text()).toBe(challenge)
  })

  test('GET verify rejects a wrong token with 403 and does not echo the challenge', async ({ request }) => {
    const challenge = `challenge-${uniqueSuffix()}`
    const response = await request.fetch(
      resolveUrl(`${WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=wrong-${uniqueSuffix()}&hub.challenge=${challenge}`),
      { method: 'GET' },
    )
    expect(response.status()).toBe(403)
    expect(await response.text()).not.toContain(challenge)
  })

  test('POST rejects a bad or missing signature with 401 and stores no lead event', async ({ request }) => {
    const env = await setupMetaTestEnv(request)
    try {
      const connection = await connectFakeMetaAccount(env)
      const metaPageId = `9${uniqueSuffix()}`
      const metaFormId = `8${uniqueSuffix()}`
      const metaLeadId = `7${uniqueSuffix()}`
      const page = await assignFakePage(env, connection.id, metaPageId)
      await seedFakeForm(env, { pageId: page.id, metaPageId, metaFormId })
      const rawBody = buildLeadgenNotification([{ pageId: metaPageId, leads: [{ leadId: metaLeadId, formId: metaFormId }] }])

      const tampered = await postWebhook(env, rawBody, { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` })
      expect(tampered.status(), 'Tampered signature should be rejected').toBe(401)

      const wrongSecret = await postWebhook(env, rawBody, { 'x-hub-signature-256': signBody(rawBody, 'not-the-app-secret') })
      expect(wrongSecret.status(), 'Signature from another secret should be rejected').toBe(401)

      const missing = await postWebhook(env, rawBody, {})
      expect(missing.status(), 'Missing signature should be rejected').toBe(401)

      const events = await listLeadEvents(env)
      expect(events.some((event) => event.metaLeadId === metaLeadId)).toBe(false)
    } finally {
      await env.cleanup()
    }
  })

  test('POST rejects an oversized body with 413', async ({ request }) => {
    const env = await setupMetaTestEnv(request)
    try {
      const oversized = JSON.stringify({ object: 'page', entry: [], padding: 'x'.repeat(OVERSIZED_BODY_BYTES) })
      const response = await postWebhook(env, oversized, { 'x-hub-signature-256': signBody(oversized) })
      expect(response.status()).toBe(413)
    } finally {
      await env.cleanup()
    }
  })
})

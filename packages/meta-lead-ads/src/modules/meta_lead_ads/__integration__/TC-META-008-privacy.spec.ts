import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import { expectId, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import {
  OPTIMISTIC_LOCK_CONFLICT_CODE,
  OPTIMISTIC_LOCK_HEADER_NAME,
} from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import type { FormDto, LeadEventDetailDto, LeadEventSummaryDto, SettingsDto, SubmissionsResponse } from '../api/openapi'
import type { GraphFormQuestion, GraphLead } from '../data/validators'
import { QUEUES } from '../lib/constants'
import { buildSignedRequest } from '../lib/signature'
import { assignFakePage, connectFakeMetaAccount, seedFakeForm, setupMetaTestEnv, type MetaTestEnv } from './support/fixtures'
import { buildLeadgenNotification, signBody, TEST_APP_SECRET } from './support/sign'

/**
 * TC-META-008: privacy and settings (quickstart scenario 10).
 *
 * The retention-purge run (payloads nulled, hashes kept) has no HTTP trigger and the integration helpers cannot
 * enqueue jobs, so it is covered by __tests__/retention-purge-worker.test.ts.
 */

const BASE_URL = process.env.BASE_URL?.trim() || null
const EVENTS_QUEUE = 'events'
const CONSENT_KEY = 'marketing_consent'

type ListResponse<Item> = { items?: Item[] }

const PRIVACY_QUESTIONS: GraphFormQuestion[] = [
  { key: 'full_name', label: 'Full name', type: 'FULL_NAME' },
  { key: 'email', label: 'Email', type: 'EMAIL' },
  { key: 'phone_number', label: 'Phone number', type: 'PHONE' },
  { key: CONSENT_KEY, label: 'I agree to receive marketing emails', type: 'CUSTOM' },
]

function resolveUrl(path: string): string {
  return BASE_URL ? `${BASE_URL}${path}` : path
}

function orgRequest(env: MetaTestEnv, method: string, path: string, data?: unknown) {
  return apiRequestWithSelectedOrg(env.request, method, path, { token: env.token, selectedOrgId: env.orgId, data })
}

function lockedOrgRequest(env: MetaTestEnv, method: string, path: string, expectedUpdatedAt: string, data: unknown) {
  return env.request.fetch(resolveUrl(path), {
    method,
    headers: {
      Authorization: `Bearer ${env.token}`,
      'Content-Type': 'application/json',
      Cookie: `om_selected_org=${env.orgId}`,
      [OPTIMISTIC_LOCK_HEADER_NAME]: expectedUpdatedAt,
    },
    data,
  })
}

function postDataDeletion(request: APIRequestContext, signedRequest: string) {
  return request.fetch(resolveUrl('/api/meta_lead_ads/data-deletion'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: new URLSearchParams({ signed_request: signedRequest }).toString(),
  })
}

async function postSignedWebhook(request: APIRequestContext, body: string): Promise<void> {
  const response = await request.fetch(resolveUrl('/api/meta_lead_ads/webhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signBody(body) },
    data: body,
  })
  expect(response.status(), 'POST webhook should return 200').toBe(200)
}

async function findLeadEvent(env: MetaTestEnv, formId: string, metaLeadId: string): Promise<LeadEventSummaryDto | null> {
  const response = await orgRequest(
    env,
    'GET',
    `/api/meta_lead_ads/lead-events?formId=${encodeURIComponent(formId)}&pageSize=100`,
  )
  expect(response.status(), 'GET lead-events should return 200').toBe(200)
  const body = await readJsonSafe<ListResponse<LeadEventSummaryDto>>(response)
  return body?.items?.find((event) => event.metaLeadId === metaLeadId) ?? null
}

async function readLeadEventDetail(env: MetaTestEnv, leadEventId: string): Promise<LeadEventDetailDto> {
  const response = await orgRequest(env, 'GET', `/api/meta_lead_ads/lead-events/${leadEventId}`)
  expect(response.status(), 'GET lead-events/[id] should return 200').toBe(200)
  const body = await readJsonSafe<LeadEventDetailDto>(response)
  expect(body, 'Lead event detail should be returned').toBeTruthy()
  return body as LeadEventDetailDto
}

async function countPersonRows(orgId: string, personId: string): Promise<{ keys: number; consents: number }> {
  return withClient(async (client) => {
    const keys = await client.query<{ count: string }>(
      'select count(*)::text as count from meta_lead_ads_person_keys where organization_id = $1 and person_id = $2',
      [orgId, personId],
    )
    const consents = await client.query<{ count: string }>(
      'select count(*)::text as count from meta_lead_ads_consents where organization_id = $1 and person_id = $2',
      [orgId, personId],
    )
    return { keys: Number(keys.rows[0]?.count ?? 0), consents: Number(consents.rows[0]?.count ?? 0) }
  })
}

async function readEventHashes(
  leadEventId: string,
): Promise<{ rawPayload: unknown; rawNotification: unknown; emailHash: string | null; phoneHash: string | null }> {
  return withClient(async (client) => {
    const result = await client.query<{
      raw_payload: unknown
      raw_notification: unknown
      email_hash: string | null
      phone_hash: string | null
    }>('select raw_payload, raw_notification, email_hash, phone_hash from meta_lead_ads_lead_events where id = $1', [
      leadEventId,
    ])
    const row = result.rows[0]
    return {
      rawPayload: row?.raw_payload ?? null,
      rawNotification: row?.raw_notification ?? null,
      emailHash: row?.email_hash ?? null,
      phoneHash: row?.phone_hash ?? null,
    }
  })
}

test.describe('TC-META-008: Meta lead privacy and settings', () => {
  test.describe.configure({ timeout: 180_000 })

  test('deleting a person purges raw payloads, hashes, keys and consents but keeps the event', async ({ request }) => {
    let env: MetaTestEnv | null = null
    try {
      env = await setupMetaTestEnv(request)
      const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`
      const metaPageId = `7008${stamp}`
      const metaFormId = `7108${stamp}`
      const metaLeadId = `7208${stamp}`
      const connection = await connectFakeMetaAccount(env)
      const page = await assignFakePage(env, connection.id, metaPageId)
      const seeded = await seedFakeForm(env, { pageId: page.id, metaPageId, metaFormId, questions: PRIVACY_QUESTIONS })

      const mappingResponse = await lockedOrgRequest(env, 'PUT', '/api/meta_lead_ads/forms', seeded.updatedAt, {
        id: seeded.id,
        ownerMode: 'none',
        fieldMapping: [
          { questionKey: 'full_name', target: 'person.fullName' },
          { questionKey: 'email', target: 'person.primaryEmail' },
          { questionKey: 'phone_number', target: 'person.primaryPhone' },
          { questionKey: CONSENT_KEY, target: 'consent' },
        ],
      })
      expect(mappingResponse.status(), 'PUT forms with the consent mapping should return 200').toBe(200)
      const form = await readJsonSafe<FormDto>(mappingResponse)
      expectId(form?.id, 'Updated form should be returned')

      const lead: GraphLead = {
        id: metaLeadId,
        created_time: new Date().toISOString().replace(/\.\d{3}Z$/, '+0000'),
        form_id: metaFormId,
        platform: 'fb',
        is_organic: false,
        field_data: [
          { name: 'full_name', values: [`Privacy Person ${stamp}`] },
          { name: 'email', values: [`tc-meta-008-${stamp}@example.com`] },
          { name: 'phone_number', values: ['+48 600 100 200'] },
          { name: CONSENT_KEY, values: ['true'] },
        ],
      }
      env.fake.state.leads.set(metaLeadId, lead)
      await postSignedWebhook(
        request,
        buildLeadgenNotification([{ pageId: metaPageId, leads: [{ leadId: metaLeadId, formId: metaFormId }] }]),
      )
      await drainIntegrationQueue(QUEUES.process)

      await expect
        .poll(async () => (await findLeadEvent(env as MetaTestEnv, seeded.id, metaLeadId))?.status ?? null, {
          message: 'The lead should be processed',
          timeout: 30_000,
        })
        .toBe('processed')
      const summary = await findLeadEvent(env, seeded.id, metaLeadId)
      const leadEventId = expectId(summary?.id, 'Lead event should exist')
      const personId = expectId(summary?.personId, 'Lead event should link a person')

      const before = await readLeadEventDetail(env, leadEventId)
      expect(before.payloadPurged ?? false, 'A fresh event should not be purged').toBe(false)
      expect(before.answers?.length ?? 0, 'A manager should see the answers').toBeGreaterThan(0)
      expect(before.consents?.map((consent) => consent.consentKey), 'The consent should be stored').toEqual([CONSENT_KEY])
      const submissionsBefore = await orgRequest(env, 'GET', `/api/meta_lead_ads/people/${personId}/submissions`)
      expect(submissionsBefore.status(), 'GET submissions should return 200').toBe(200)
      const submissionsBody = await readJsonSafe<SubmissionsResponse>(submissionsBefore)
      expect(submissionsBody?.items?.map((item) => item.leadEventId), 'The person should list the submission').toContain(
        leadEventId,
      )
      expect(submissionsBody?.consents?.length ?? 0, 'The person should list the consent').toBe(1)
      const rowsBefore = await countPersonRows(env.orgId, personId)
      expect(rowsBefore.consents, 'A consent row should exist before deletion').toBe(1)

      const deleteResponse = await orgRequest(env, 'DELETE', '/api/customers/people', { id: personId })
      expect(deleteResponse.ok(), 'DELETE customers person should succeed').toBeTruthy()
      await drainIntegrationQueue(EVENTS_QUEUE)

      await expect
        .poll(async () => (await readLeadEventDetail(env as MetaTestEnv, leadEventId)).payloadPurged ?? false, {
          message: 'The person deletion should purge the lead event payload',
          timeout: 30_000,
        })
        .toBe(true)
      const after = await readLeadEventDetail(env, leadEventId)
      expect(after.id, 'The event row should remain as a tombstone').toBe(leadEventId)
      expect(after.status, 'The event status should be unchanged').toBe(before.status)
      expect(after.payloadPurgedAt, 'payloadPurgedAt should be set').toBeTruthy()
      expect(after.answers ?? null, 'Answers should no longer be returned').toBeNull()
      expect(after.consents ?? [], 'Consents should be removed').toEqual([])

      const stored = await readEventHashes(leadEventId)
      expect(stored.rawPayload, 'raw_payload should be nulled').toBeNull()
      expect(stored.rawNotification, 'raw_notification should be nulled').toBeNull()
      expect(stored.emailHash, 'email_hash should be nulled').toBeNull()
      expect(stored.phoneHash, 'phone_hash should be nulled').toBeNull()
      expect(await countPersonRows(env.orgId, personId), 'Person keys and consents should be hard-deleted').toEqual({
        keys: 0,
        consents: 0,
      })

      const submissionsAfter = await orgRequest(env, 'GET', `/api/meta_lead_ads/people/${personId}/submissions`)
      if (submissionsAfter.status() === 200) {
        const afterBody = await readJsonSafe<SubmissionsResponse>(submissionsAfter)
        expect(afterBody?.consents ?? [], 'The deleted person should have no consents').toEqual([])
      } else {
        expect(submissionsAfter.status(), 'A deleted person should not be found').toBe(404)
      }
    } finally {
      await env?.cleanup()
    }
  })

  test('data deletion callback verifies the signed request and exposes a status', async ({ request }) => {
    let env: MetaTestEnv | null = null
    let confirmationCode: string | null = null
    try {
      env = await setupMetaTestEnv(request)
      const metaUserId = `9${Date.now()}${Math.floor(Math.random() * 1000)}`
      env.fake.state.user.id = metaUserId
      await connectFakeMetaAccount(env)

      const payload = { algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: metaUserId }
      const invalid = await postDataDeletion(request, buildSignedRequest(payload, `${TEST_APP_SECRET}-wrong`))
      expect(invalid.status(), 'An invalid signature should return 400').toBe(400)

      const valid = await postDataDeletion(request, buildSignedRequest(payload, TEST_APP_SECRET))
      expect(valid.status(), 'A valid signed request should return 200').toBe(200)
      const accepted = await readJsonSafe<{ url?: string; confirmation_code?: string }>(valid)
      confirmationCode = expectId(accepted?.confirmation_code, 'Response should include confirmation_code')
      expect(accepted?.url ?? '', 'Response url should point at the status endpoint').toContain(
        `/api/meta_lead_ads/data-deletion/${confirmationCode}`,
      )

      const statusResponse = await request.fetch(
        resolveUrl(`/api/meta_lead_ads/data-deletion/${encodeURIComponent(confirmationCode)}`),
        { method: 'GET' },
      )
      expect(statusResponse.status(), 'GET data-deletion status should return 200').toBe(200)
      const status = await readJsonSafe<{ confirmationCode?: string; status?: string }>(statusResponse)
      expect(status?.confirmationCode, 'Status should echo the confirmation code').toBe(confirmationCode)
      expect(status?.status, 'The deletion request should be completed').toBe('completed')
    } finally {
      if (confirmationCode) {
        const code = confirmationCode
        await withClient((client) =>
          client.query('delete from meta_lead_ads_deletion_requests where confirmation_code = $1', [code]),
        ).catch(() => undefined)
      }
      await env?.cleanup()
    }
  })

  test('settings PUT enforces optimistic locking', async ({ request }) => {
    let env: MetaTestEnv | null = null
    try {
      env = await setupMetaTestEnv(request)
      const created = await orgRequest(env, 'PUT', '/api/meta_lead_ads/settings', {
        retentionDays: 120,
        defaultCountry: 'PL',
      })
      expect(created.status(), 'The first settings PUT should return 200').toBe(200)
      const initial = await readJsonSafe<SettingsDto>(created)
      const currentUpdatedAt = expectId(initial?.updatedAt, 'Settings should expose updatedAt')

      const staleUpdatedAt = new Date(Date.parse(currentUpdatedAt) - 60_000).toISOString()
      const stale = await lockedOrgRequest(env, 'PUT', '/api/meta_lead_ads/settings', staleUpdatedAt, {
        retentionDays: 90,
        defaultCountry: 'DE',
      })
      expect(stale.status(), 'A stale optimistic lock should return 409').toBe(409)
      const conflict = await readJsonSafe<{ code?: string }>(stale)
      expect(conflict?.code, 'The conflict body should carry the lock code').toBe(OPTIMISTIC_LOCK_CONFLICT_CODE)

      const unchanged = await orgRequest(env, 'GET', '/api/meta_lead_ads/settings')
      const unchangedBody = await readJsonSafe<SettingsDto>(unchanged)
      expect(unchangedBody?.retentionDays, 'A rejected PUT should not change settings').toBe(120)

      const fresh = await lockedOrgRequest(env, 'PUT', '/api/meta_lead_ads/settings', currentUpdatedAt, {
        retentionDays: 90,
        defaultCountry: 'DE',
      })
      expect(fresh.status(), 'A current optimistic lock should return 200').toBe(200)
      const updated = await readJsonSafe<SettingsDto>(fresh)
      expect(updated?.retentionDays, 'Retention should be updated').toBe(90)
      expect(updated?.defaultCountry, 'Default country should be updated').toBe('DE')
    } finally {
      await env?.cleanup()
    }
  })
})

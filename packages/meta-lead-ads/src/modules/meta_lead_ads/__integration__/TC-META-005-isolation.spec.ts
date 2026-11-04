import { expect, test } from '@playwright/test'
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import type { GraphLead } from '../data/validators'
import type { FormDto, LeadEventSummaryDto, PageDto, SettingsDto, SyncRunDto } from '../api/openapi'
import { QUEUES, WEBHOOK_PATH } from '../lib/constants'
import {
  assignFakePage,
  connectFakeMetaAccount,
  seedFakeForm,
  setupMetaTestEnv,
  type MetaTestEnv,
} from './support/fixtures'
import { buildLeadgenNotification, signBody } from './support/sign'

const BASE_URL = process.env.BASE_URL?.trim() || null
const X_RETENTION_DAYS = 45
const DAY_MS = 24 * 60 * 60 * 1000

type ListResponse<Item> = { items?: Item[] }

function resolveUrl(path: string): string {
  return BASE_URL ? `${BASE_URL}${path}` : path
}

function orgRequest(env: MetaTestEnv, method: string, path: string, data?: unknown) {
  return apiRequestWithSelectedOrg(env.request, method, path, { token: env.token, selectedOrgId: env.orgId, data })
}

function uniqueSuffix(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`
}

function buildGraphLead(input: { leadId: string; metaFormId: string; email: string; fullName: string }): GraphLead {
  return {
    id: input.leadId,
    created_time: new Date().toISOString().replace(/\.\d{3}Z$/, '+0000'),
    form_id: input.metaFormId,
    platform: 'fb',
    is_organic: false,
    field_data: [
      { name: 'full_name', values: [input.fullName] },
      { name: 'email', values: [input.email] },
    ],
  }
}

async function listItems<Item>(env: MetaTestEnv, path: string): Promise<{ raw: string; items: Item[] }> {
  const response = await orgRequest(env, 'GET', path)
  expect(response.status(), `GET ${path} should return 200`).toBe(200)
  const raw = await response.text()
  const body = (await readJsonSafe<ListResponse<Item>>(response)) ?? {}
  return { raw, items: body.items ?? [] }
}

async function findLeadEvent(env: MetaTestEnv, metaLeadId: string): Promise<LeadEventSummaryDto | null> {
  const { items } = await listItems<LeadEventSummaryDto>(env, '/api/meta_lead_ads/lead-events?pageSize=100')
  return items.find((item) => item.metaLeadId === metaLeadId) ?? null
}

async function waitForProcessed(env: MetaTestEnv, metaLeadId: string): Promise<LeadEventSummaryDto> {
  await expect
    .poll(
      async () => {
        await drainIntegrationQueue(QUEUES.process)
        return (await findLeadEvent(env, metaLeadId))?.status ?? null
      },
      { message: `Lead ${metaLeadId} should be processed`, timeout: 60_000 },
    )
    .toBe('processed')
  return (await findLeadEvent(env, metaLeadId)) as LeadEventSummaryDto
}

test.describe('TC-META-005: Cross-organization isolation', () => {
  test('routes leads per page and hides one organization from another', async ({ request }) => {
    test.setTimeout(180_000)
    let envX: MetaTestEnv | null = null
    let envY: MetaTestEnv | null = null
    try {
      envX = await setupMetaTestEnv(request)
      envY = await setupMetaTestEnv(request)
      const suffix = uniqueSuffix()
      const metaPageX = `iso-page-x-${suffix}`
      const metaPageY = `iso-page-y-${suffix}`
      const metaFormX = `iso-form-x-${suffix}`
      const metaFormY = `iso-form-y-${suffix}`
      const leadX = `iso-lead-x-${suffix}`
      const leadY = `iso-lead-y-${suffix}`

      const connectionX = await connectFakeMetaAccount(envX)
      const connectionY = await connectFakeMetaAccount(envY)
      const pageX = await assignFakePage(envX, connectionX.id, metaPageX, 'Isolation Page X')
      const pageY = await assignFakePage(envY, connectionY.id, metaPageY, 'Isolation Page Y')
      const formX = await seedFakeForm(envX, { pageId: pageX.id, metaPageId: metaPageX, metaFormId: metaFormX })
      const formY = await seedFakeForm(envY, { pageId: pageY.id, metaPageId: metaPageY, metaFormId: metaFormY })

      envX.fake.state.leads.set(
        leadX,
        buildGraphLead({ leadId: leadX, metaFormId: metaFormX, email: `iso-x-${suffix}@example.com`, fullName: 'Iso X' }),
      )
      envY.fake.state.leads.set(
        leadY,
        buildGraphLead({ leadId: leadY, metaFormId: metaFormY, email: `iso-y-${suffix}@example.com`, fullName: 'Iso Y' }),
      )

      const raw = buildLeadgenNotification([
        { pageId: metaPageX, leads: [{ leadId: leadX, formId: metaFormX }] },
        { pageId: metaPageY, leads: [{ leadId: leadY, formId: metaFormY }] },
      ])
      const webhook = await request.fetch(resolveUrl(WEBHOOK_PATH), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signBody(raw) },
        data: raw,
      })
      expect(webhook.status(), 'Signed webhook should be accepted').toBe(200)

      const eventX = await waitForProcessed(envX, leadX)
      const eventY = await waitForProcessed(envY, leadY)
      expect(eventX.pageId).toBe(pageX.id)
      expect(eventY.pageId).toBe(pageY.id)
      expect(await findLeadEvent(envX, leadY), 'Lead Y must not land in org X').toBeNull()
      expect(await findLeadEvent(envY, leadX), 'Lead X must not land in org Y').toBeNull()
      expect(envX.fake.state.calls.some((call) => call.path === `/${leadY}`)).toBe(false)
      expect(envY.fake.state.calls.some((call) => call.path === `/${leadX}`)).toBe(false)
      const personX = eventX.personId
      expect(personX, 'Lead X should be linked to a person').toBeTruthy()

      const settingsX = await orgRequest(envX, 'PUT', '/api/meta_lead_ads/settings', {
        retentionDays: X_RETENTION_DAYS,
        defaultCountry: 'PL',
      })
      expect(settingsX.status(), 'PUT settings in org X should return 200').toBe(200)
      const settingsXBody = await readJsonSafe<SettingsDto>(settingsX)
      expect(settingsXBody?.id).toBeTruthy()

      const now = Date.now()
      const backfill = await orgRequest(envX, 'POST', '/api/meta_lead_ads/backfill', {
        formId: formX.id,
        from: new Date(now - 7 * DAY_MS).toISOString(),
        to: new Date(now - 60_000).toISOString(),
      })
      expect(backfill.status(), 'POST backfill in org X should return 202').toBe(202)
      const runX = (await readJsonSafe<{ runId?: string }>(backfill))?.runId
      expect(runX, 'Backfill should return a runId').toBeTruthy()

      const foreignIds = [pageX.id, formX.id, eventX.id, runX as string, settingsXBody?.id as string, metaPageX, leadX]

      const pagesY = await listItems<PageDto>(envY, '/api/meta_lead_ads/pages?pageSize=100')
      expect(pagesY.items.map((item) => item.id)).toEqual([pageY.id])
      const formsY = await listItems<FormDto>(envY, '/api/meta_lead_ads/forms?pageSize=100')
      expect(formsY.items.map((item) => item.id)).toEqual([formY.id])
      const eventsY = await listItems<LeadEventSummaryDto>(envY, '/api/meta_lead_ads/lead-events?pageSize=100')
      expect(eventsY.items.map((item) => item.id)).toEqual([eventY.id])
      const runsY = await listItems<SyncRunDto>(envY, '/api/meta_lead_ads/sync-runs?pageSize=100')
      expect(runsY.items.some((item) => item.id === runX)).toBe(false)
      expect(runsY.items.some((item) => item.formId === formX.id)).toBe(false)
      for (const listing of [pagesY, formsY, eventsY, runsY]) {
        for (const foreignId of foreignIds) expect(listing.raw).not.toContain(foreignId)
      }

      const settingsY = await orgRequest(envY, 'GET', '/api/meta_lead_ads/settings')
      expect(settingsY.status()).toBe(200)
      const settingsYBody = await readJsonSafe<SettingsDto>(settingsY)
      expect(settingsYBody?.id).not.toBe(settingsXBody?.id)
      expect(settingsYBody?.retentionDays).not.toBe(X_RETENTION_DAYS)

      const foreignEvent = await orgRequest(envY, 'GET', `/api/meta_lead_ads/lead-events/${eventX.id}`)
      expect(foreignEvent.status(), 'Foreign lead event must answer 404').toBe(404)
      const ownEvent = await orgRequest(envX, 'GET', `/api/meta_lead_ads/lead-events/${eventX.id}`)
      expect(ownEvent.status()).toBe(200)

      const foreignSubmissions = await orgRequest(envY, 'GET', `/api/meta_lead_ads/people/${personX}/submissions`)
      expect(foreignSubmissions.status(), 'Foreign person submissions must answer 404').toBe(404)
      const ownSubmissions = await orgRequest(envX, 'GET', `/api/meta_lead_ads/people/${personX}/submissions`)
      expect(ownSubmissions.status()).toBe(200)
      const ownSubmissionsBody = await readJsonSafe<{ items?: { leadEventId: string }[] }>(ownSubmissions)
      expect(ownSubmissionsBody?.items?.some((item) => item.leadEventId === eventX.id)).toBe(true)

      if (!envY.fake.state.pages.some((page) => page.id === metaPageX)) {
        envY.fake.state.pages.push({
          id: metaPageX,
          name: 'Isolation Page X',
          accessToken: `fake-page-token-${metaPageX}`,
          tasks: ['ADVERTISE', 'MANAGE'],
        })
      }
      const stolen = await orgRequest(envY, 'POST', '/api/meta_lead_ads/pages', {
        connectionId: connectionY.id,
        metaPageId: metaPageX,
        organizationId: envY.orgId,
      })
      expect(stolen.status(), 'Assigning a page owned by another org should conflict').toBe(409)
      expect((await readJsonSafe<{ code?: string }>(stolen))?.code).toBe('page_already_assigned')
      const pagesYAfter = await listItems<PageDto>(envY, '/api/meta_lead_ads/pages?pageSize=100')
      expect(pagesYAfter.items.map((item) => item.id)).toEqual([pageY.id])

      await drainIntegrationQueue(QUEUES.backfill)
    } finally {
      if (envY) await envY.cleanup()
      if (envX) await envX.cleanup()
    }
  })
})

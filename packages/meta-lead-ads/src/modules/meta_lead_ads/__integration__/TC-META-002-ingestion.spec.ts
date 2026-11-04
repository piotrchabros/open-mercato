import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import type { GraphLead } from '../data/validators'
import type { FormDto, LeadEventSummaryDto } from '../api/openapi'
import { INTERACTION_TYPE, QUEUES } from '../lib/constants'
import { assignFakePage, connectFakeMetaAccount, seedFakeForm, setupMetaTestEnv, type MetaTestEnv } from './support/fixtures'
import { buildLeadgenNotification, signBody } from './support/sign'

const BASE_URL = process.env.BASE_URL?.trim() || null
const WEBHOOK_PATH = '/api/meta_lead_ads/webhook'
const WEBHOOK_BUDGET_MS = 5_000

type PersonItem = { id: string; display_name?: string | null; primary_email?: string | null; primary_phone?: string | null }
type CompanyItem = { id: string; display_name?: string | null }
type InteractionItem = { id: string; title?: string | null; body?: string | null; interactionType?: string }

function resolveUrl(path: string): string {
  return BASE_URL ? `${BASE_URL}${path}` : path
}

function uniqueSuffix(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}

function orgRequest(env: MetaTestEnv, method: string, path: string, data?: unknown) {
  return apiRequestWithSelectedOrg(env.request, method, path, { token: env.token, selectedOrgId: env.orgId, data })
}

async function getItems<Item>(env: MetaTestEnv, path: string): Promise<Item[]> {
  const response = await orgRequest(env, 'GET', path)
  expect(response.status(), `GET ${path} should return 200`).toBe(200)
  const body = await readJsonSafe<{ items?: Item[] }>(response)
  return body?.items ?? []
}

const listLeadEvents = (env: MetaTestEnv) => getItems<LeadEventSummaryDto>(env, '/api/meta_lead_ads/lead-events?pageSize=100')

async function postSignedNotification(env: MetaTestEnv, rawBody: string) {
  return env.request.fetch(resolveUrl(WEBHOOK_PATH), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signBody(rawBody) },
    data: rawBody,
  })
}

async function drainAndWaitForStatus(env: MetaTestEnv, leadIds: string[], status: LeadEventSummaryDto['status']) {
  await drainIntegrationQueue(QUEUES.process)
  await expect
    .poll(
      async () => {
        const events = await listLeadEvents(env)
        return leadIds.map((leadId) => events.find((event) => event.metaLeadId === leadId)?.status ?? 'missing')
      },
      { message: `Lead events should reach status ${status}`, timeout: 60_000 },
    )
    .toEqual(leadIds.map(() => status))
  const events = await listLeadEvents(env)
  return leadIds.map((leadId) => events.find((event) => event.metaLeadId === leadId) as LeadEventSummaryDto)
}

function buildGraphLead(input: {
  leadId: string
  formId: string
  name: string
  email: string
  phone: string
  companyName?: string
  campaign: string
  adset: string
  ad: string
}): GraphLead {
  const fieldData = [
    { name: 'full_name', values: [input.name] },
    { name: 'email', values: [input.email] },
    { name: 'phone_number', values: [input.phone] },
    ...(input.companyName ? [{ name: 'company_name', values: [input.companyName] }] : []),
  ]
  return {
    id: input.leadId,
    created_time: new Date().toISOString().replace(/\.\d{3}Z$/, '+0000'),
    form_id: input.formId,
    platform: 'fb',
    is_organic: false,
    ad_id: `ad-${input.leadId}`,
    ad_name: input.ad,
    adset_id: `adset-${input.leadId}`,
    adset_name: input.adset,
    campaign_id: `campaign-${input.leadId}`,
    campaign_name: input.campaign,
    field_data: fieldData,
  } as GraphLead
}

async function countPeople(env: MetaTestEnv, personIds: string[]): Promise<number> {
  const items = await getItems<PersonItem>(env, `/api/customers/people?ids=${personIds.join(',')}&pageSize=100`)
  return items.length
}

async function loadMetaInteractions(env: MetaTestEnv, personId: string): Promise<InteractionItem[]> {
  return getItems<InteractionItem>(
    env,
    `/api/customers/interactions?entityId=${personId}&interactionType=${INTERACTION_TYPE}&limit=50`,
  )
}

async function setupRoutedForm(request: APIRequestContext) {
  const env = await setupMetaTestEnv(request)
  try {
    const connection = await connectFakeMetaAccount(env)
    const suffix = uniqueSuffix()
    const metaPageId = `9${suffix}`
    const metaFormId = `8${suffix}`
    const page = await assignFakePage(env, connection.id, metaPageId)
    const form: FormDto = await seedFakeForm(env, { pageId: page.id, metaPageId, metaFormId })
    return { env, suffix, metaPageId, metaFormId, form }
  } catch (error) {
    await env.cleanup()
    throw error
  }
}

/**
 * TC-META-002: Meta Lead Ads webhook ingestion into the CRM
 * Maps to quickstart scenarios 3 and 4 (FR-016, FR-017, FR-019 to FR-021, FR-024, SC-001, SC-003),
 * plus the form test lead.
 */
test.describe('TC-META-002: Meta Lead Ads ingestion', () => {
  test('processes a two-entry notification, is idempotent on redelivery and ignores unknown pages', async ({ request }) => {
    const { env, suffix, metaPageId, metaFormId } = await setupRoutedForm(request)
    try {
      const firstLeadId = `71${suffix}`
      const secondLeadId = `72${suffix}`
      const firstEmail = `meta-first-${suffix}@example.com`
      const secondEmail = `meta-second-${suffix}@example.com`
      const companyName = `Meta Company ${suffix}`
      env.fake.state.leads.set(
        firstLeadId,
        buildGraphLead({
          leadId: firstLeadId,
          formId: metaFormId,
          name: `First Lead${suffix}`,
          email: firstEmail,
          phone: '+48600100201',
          companyName,
          campaign: `Campaign ${suffix}`,
          adset: `Adset ${suffix}`,
          ad: `Ad ${suffix}`,
        }),
      )
      env.fake.state.leads.set(
        secondLeadId,
        buildGraphLead({
          leadId: secondLeadId,
          formId: metaFormId,
          name: `Second Lead${suffix}`,
          email: secondEmail,
          phone: '+48600100202',
          campaign: `Campaign ${suffix}`,
          adset: `Adset ${suffix}`,
          ad: `Ad ${suffix}`,
        }),
      )
      const unknownPageId = `6${suffix}`
      const unknownLeadId = `73${suffix}`
      const rawBody = buildLeadgenNotification([
        {
          pageId: metaPageId,
          leads: [
            { leadId: firstLeadId, formId: metaFormId },
            { leadId: secondLeadId, formId: metaFormId },
          ],
        },
        { pageId: unknownPageId, leads: [{ leadId: unknownLeadId, formId: `5${suffix}` }] },
      ])

      const startedAt = Date.now()
      const response = await postSignedNotification(env, rawBody)
      expect(response.status()).toBe(200)
      expect(await readJsonSafe<{ ok?: boolean }>(response)).toEqual({ ok: true })
      expect(Date.now() - startedAt, 'Webhook should answer quickly').toBeLessThan(WEBHOOK_BUDGET_MS)

      const [firstEvent, secondEvent] = await drainAndWaitForStatus(env, [firstLeadId, secondLeadId], 'processed')
      expect(firstEvent.personId).toBeTruthy()
      expect(secondEvent.personId).toBeTruthy()
      expect(firstEvent.personId).not.toBe(secondEvent.personId)

      const people = await getItems<PersonItem>(
        env,
        `/api/customers/people?ids=${firstEvent.personId},${secondEvent.personId}&pageSize=100`,
      )
      const firstPerson = people.find((person) => person.id === firstEvent.personId)
      const secondPerson = people.find((person) => person.id === secondEvent.personId)
      expect(firstPerson?.primary_email?.toLowerCase()).toBe(firstEmail)
      expect(firstPerson?.primary_phone).toContain('600100201')
      expect(firstPerson?.display_name).toContain('First Lead')
      expect(secondPerson?.primary_email?.toLowerCase()).toBe(secondEmail)

      const interactions = await loadMetaInteractions(env, firstEvent.personId as string)
      expect(interactions.length).toBe(1)
      expect(interactions[0].title).toBe('Lead from Meta')
      const interactionBody = interactions[0].body ?? ''
      for (const expected of [
        `First Lead${suffix}`,
        firstEmail,
        '600100201',
        companyName,
        `Campaign ${suffix}`,
        `Adset ${suffix}`,
        `Ad ${suffix}`,
      ]) {
        expect(interactionBody, `Interaction body should include ${expected}`).toContain(expected)
      }

      expect(firstEvent.companyId, 'Lead with company_name should link a company').toBeTruthy()
      expect(secondEvent.companyId).toBeNull()
      const companies = await getItems<CompanyItem>(env, `/api/customers/companies?ids=${firstEvent.companyId}&pageSize=100`)
      expect(companies.find((company) => company.id === firstEvent.companyId)?.display_name).toBe(companyName)

      const eventsAfterFirstDelivery = await listLeadEvents(env)
      expect(eventsAfterFirstDelivery.some((event) => event.metaLeadId === unknownLeadId)).toBe(false)
      expect(eventsAfterFirstDelivery.length).toBe(2)

      const redelivery = await postSignedNotification(env, rawBody)
      expect(redelivery.status()).toBe(200)
      await drainIntegrationQueue(QUEUES.process)
      const eventsAfterRedelivery = await listLeadEvents(env)
      expect(eventsAfterRedelivery.length, 'Redelivery should not create new events').toBe(2)
      expect(eventsAfterRedelivery.every((event) => event.status === 'processed')).toBe(true)
      expect(await countPeople(env, [firstEvent.personId as string, secondEvent.personId as string])).toBe(2)
      expect((await loadMetaInteractions(env, firstEvent.personId as string)).length).toBe(1)
      expect((await loadMetaInteractions(env, secondEvent.personId as string)).length).toBe(1)
    } finally {
      await env.cleanup()
    }
  })

  test('send-test-lead creates a processed event with a person', async ({ request }) => {
    const { env, form } = await setupRoutedForm(request)
    try {
      const response = await orgRequest(env, 'POST', `/api/meta_lead_ads/forms/${form.id}/test-lead`, {})
      expect(response.status(), 'POST test-lead should succeed').toBeLessThan(300)
      const body = await readJsonSafe<{ leadEventId?: string }>(response)
      expect(body?.leadEventId).toBeTruthy()

      await drainIntegrationQueue(QUEUES.process)
      await expect
        .poll(
          async () => {
            const events = await listLeadEvents(env)
            return events.find((event) => event.id === body?.leadEventId)?.status ?? 'missing'
          },
          { message: 'Test lead event should be processed', timeout: 60_000 },
        )
        .toBe('processed')
      const events = await listLeadEvents(env)
      const testEvent = events.find((event) => event.id === body?.leadEventId)
      expect(testEvent?.source).toBe('test')
      expect(testEvent?.personId).toBeTruthy()
    } finally {
      await env.cleanup()
    }
  })
})

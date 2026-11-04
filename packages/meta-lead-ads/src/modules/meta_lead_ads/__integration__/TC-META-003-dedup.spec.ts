import { expect, test, type APIRequestContext } from '@playwright/test'
import {
  apiRequestWithSelectedOrg,
  createOrganizationFixture,
  deleteOrganizationIfExists,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { expectId, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import type { GraphLead } from '../data/validators'
import type { LeadEventSummaryDto } from '../api/openapi'
import { INTERACTION_TYPE, QUEUES } from '../lib/constants'
import { assignFakePage, connectFakeMetaAccount, seedFakeForm, setupMetaTestEnv, type MetaTestEnv } from './support/fixtures'
import { buildLeadgenNotification, signBody } from './support/sign'

const BASE_URL = process.env.BASE_URL?.trim() || null
const WEBHOOK_PATH = '/api/meta_lead_ads/webhook'
const TERMINAL_STATUSES: LeadEventSummaryDto['status'][] = ['processed', 'skipped', 'failed', 'dead_lettered', 'unrouted']

const DEDUP_QUESTIONS = [
  { key: 'full_name', label: 'Full name', type: 'FULL_NAME' },
  { key: 'email', label: 'Email', type: 'EMAIL' },
  { key: 'phone_number', label: 'Phone number', type: 'PHONE' },
  { key: 'job_title', label: 'Job title', type: 'JOB_TITLE' },
]

type PersonDetail = {
  person?: { id: string; primaryEmail?: string | null; primaryPhone?: string | null }
  profile?: { jobTitle?: string | null } | null
}
type InteractionItem = { id: string; body?: string | null }
type CreatedRecord = { id?: string; entityId?: string }

function resolveUrl(path: string): string {
  return BASE_URL ? `${BASE_URL}${path}` : path
}

function uniqueSuffix(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`
}

function graphTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '+0000')
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

async function createPersonInOrg(
  request: APIRequestContext,
  token: string,
  organizationId: string,
  data: Record<string, unknown>,
): Promise<string> {
  const response = await apiRequestWithSelectedOrg(request, 'POST', '/api/customers/people', {
    token,
    selectedOrgId: organizationId,
    data,
  })
  expect(response.ok(), `POST /api/customers/people should succeed: ${response.status()}`).toBeTruthy()
  const body = await readJsonSafe<CreatedRecord>(response)
  return expectId(body?.id ?? body?.entityId, 'Person creation response should include id')
}

async function deletePersonInOrg(request: APIRequestContext, token: string, organizationId: string, personId: string | null) {
  if (!personId) return
  await apiRequestWithSelectedOrg(request, 'DELETE', '/api/customers/people', {
    token,
    selectedOrgId: organizationId,
    data: { id: personId },
  }).catch(() => undefined)
}

async function readPerson(env: MetaTestEnv, personId: string): Promise<PersonDetail> {
  const response = await orgRequest(env, 'GET', `/api/customers/people/${personId}`)
  expect(response.status(), `GET /api/customers/people/${personId} should return 200`).toBe(200)
  return (await readJsonSafe<PersonDetail>(response)) ?? {}
}

async function loadMetaInteractions(env: MetaTestEnv, personId: string): Promise<InteractionItem[]> {
  return getItems<InteractionItem>(
    env,
    `/api/customers/interactions?entityId=${personId}&interactionType=${INTERACTION_TYPE}&limit=50`,
  )
}

function buildGraphLead(input: { leadId: string; formId: string; answers: Record<string, string> }): GraphLead {
  return {
    id: input.leadId,
    created_time: graphTime(new Date()),
    form_id: input.formId,
    platform: 'fb',
    is_organic: false,
    field_data: Object.entries(input.answers).map(([name, value]) => ({ name, values: [value] })),
  } as GraphLead
}

async function deliverLead(
  env: MetaTestEnv,
  routing: { metaPageId: string; metaFormId: string },
  leadId: string,
  answers: Record<string, string>,
): Promise<LeadEventSummaryDto> {
  env.fake.state.leads.set(leadId, buildGraphLead({ leadId, formId: routing.metaFormId, answers }))
  const rawBody = buildLeadgenNotification([
    { pageId: routing.metaPageId, leads: [{ leadId, formId: routing.metaFormId }] },
  ])
  const response = await env.request.fetch(resolveUrl(WEBHOOK_PATH), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signBody(rawBody) },
    data: rawBody,
  })
  expect(response.status(), 'Signed webhook POST should return 200').toBe(200)
  await drainIntegrationQueue(QUEUES.process)
  let event: LeadEventSummaryDto | undefined
  await expect
    .poll(
      async () => {
        const events = await getItems<LeadEventSummaryDto>(env, '/api/meta_lead_ads/lead-events?pageSize=100')
        event = events.find((item) => item.metaLeadId === leadId)
        return event && TERMINAL_STATUSES.includes(event.status) ? event.status : 'pending'
      },
      { message: `Lead ${leadId} should be processed`, timeout: 60_000 },
    )
    .toBe('processed')
  return event as LeadEventSummaryDto
}

async function setupRoutedForm(request: APIRequestContext) {
  const env = await setupMetaTestEnv(request)
  try {
    const connection = await connectFakeMetaAccount(env)
    const suffix = uniqueSuffix()
    const metaPageId = `9${suffix}`
    const metaFormId = `8${suffix}`
    const page = await assignFakePage(env, connection.id, metaPageId)
    await seedFakeForm(env, { pageId: page.id, metaPageId, metaFormId, questions: DEDUP_QUESTIONS })
    return { env, suffix, routing: { metaPageId, metaFormId } }
  } catch (error) {
    await env.cleanup()
    throw error
  }
}

/**
 * TC-META-003: Meta Lead Ads person deduplication
 * Maps to quickstart scenario 5 (US5, FR-022, FR-023): email match ignoring case and whitespace, phone match after
 * E.164 normalization, fill-empty-only updates with differing values kept in the interaction, an email-vs-phone
 * conflict noted on the interaction, and no match across organizations.
 */
test.describe('TC-META-003: Meta Lead Ads deduplication', () => {
  test('matches by normalized email and phone, fills only empty fields and notes conflicts', async ({ request }) => {
    const { env, suffix, routing } = await setupRoutedForm(request)
    let emailPersonId: string | null = null
    let phonePersonId: string | null = null
    try {
      const storedEmail = `Jan.${suffix}@Example.com`
      emailPersonId = await createPersonInOrg(env.request, env.token, env.orgId, {
        firstName: 'Jan',
        lastName: `Kowalski${suffix}`,
        displayName: `Jan Kowalski${suffix}`,
        primaryEmail: storedEmail,
        jobTitle: 'Chief Technology Officer',
      })
      phonePersonId = await createPersonInOrg(env.request, env.token, env.orgId, {
        firstName: 'Anna',
        lastName: `Nowak${suffix}`,
        displayName: `Anna Nowak${suffix}`,
        primaryPhone: '+48 600 100 200',
      })

      const emailEvent = await deliverLead(env, routing, `61${suffix}`, {
        full_name: `Jan Kowalski${suffix}`,
        email: ` ${storedEmail.toLowerCase()} `,
        phone_number: '+48 500 600 700',
        job_title: 'Sales Manager',
      })
      expect(emailEvent.personId, 'Email lead should attach to the existing person').toBe(emailPersonId)
      expect(emailEvent.matchType).toBe('email')

      const emailPerson = await readPerson(env, emailPersonId)
      expect(emailPerson.profile?.jobTitle, 'A filled job title must not be overwritten').toBe('Chief Technology Officer')
      expect(emailPerson.person?.primaryPhone ?? '', 'An empty phone should be filled from the lead').toContain('500')
      const emailInteractions = await loadMetaInteractions(env, emailPersonId)
      expect(emailInteractions.length).toBeGreaterThanOrEqual(1)
      expect(
        emailInteractions.some((interaction) => (interaction.body ?? '').includes('Sales Manager')),
        'The lead job title should be kept in the interaction body',
      ).toBe(true)

      const phoneEvent = await deliverLead(env, routing, `62${suffix}`, {
        full_name: `Anna Nowak${suffix}`,
        phone_number: '600100200',
      })
      expect(phoneEvent.personId, 'Phone lead should attach to the person with the same E.164 number').toBe(phonePersonId)
      expect(phoneEvent.matchType).toBe('phone')

      const conflictEvent = await deliverLead(env, routing, `63${suffix}`, {
        full_name: `Jan Kowalski${suffix}`,
        email: storedEmail,
        phone_number: '600100200',
      })
      expect(conflictEvent.personId, 'Email wins over phone on a conflict').toBe(emailPersonId)
      expect(conflictEvent.matchType).toBe('email')
      const conflictInteraction = (await loadMetaInteractions(env, emailPersonId)).find(
        (interaction) => interaction.id === conflictEvent.interactionId,
      )
      expect(conflictInteraction, 'The conflict lead should create an interaction').toBeTruthy()
      expect(conflictInteraction?.body ?? '', 'The conflicting person should be noted').toContain(phonePersonId)

      const people = await getItems<{ id: string }>(env, '/api/customers/people?pageSize=100')
      expect(people.map((person) => person.id).sort(), 'No new person should be created').toEqual(
        [emailPersonId, phonePersonId].sort(),
      )
    } finally {
      await deletePersonInOrg(env.request, env.token, env.orgId, emailPersonId)
      await deletePersonInOrg(env.request, env.token, env.orgId, phonePersonId)
      await env.cleanup()
    }
  })

  test('does not match a person with the same email in another organization', async ({ request }) => {
    const { env, suffix, routing } = await setupRoutedForm(request)
    let otherOrgId: string | null = null
    let otherPersonId: string | null = null
    try {
      otherOrgId = await createOrganizationFixture(env.request, env.token, { name: `Meta Lead Ads Other ${suffix}` })
      const sharedEmail = `shared.${suffix}@example.com`
      otherPersonId = await createPersonInOrg(env.request, env.token, otherOrgId, {
        firstName: 'Other',
        lastName: `Org${suffix}`,
        displayName: `Other Org${suffix}`,
        primaryEmail: sharedEmail,
      })

      const event = await deliverLead(env, routing, `64${suffix}`, {
        full_name: `Shared Email${suffix}`,
        email: sharedEmail,
      })
      expect(event.personId, 'A new person should be created in the routed organization').toBeTruthy()
      expect(event.personId).not.toBe(otherPersonId)
      expect(event.matchType).toBe('created')

      const person = await readPerson(env, event.personId as string)
      expect(person.person?.primaryEmail?.toLowerCase()).toBe(sharedEmail)
    } finally {
      if (otherOrgId) await deletePersonInOrg(env.request, env.token, otherOrgId, otherPersonId)
      await deleteOrganizationIfExists(env.request, env.token, otherOrgId)
      await env.cleanup()
    }
  })
})

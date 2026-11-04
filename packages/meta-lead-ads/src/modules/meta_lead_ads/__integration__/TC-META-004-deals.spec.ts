import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  apiRequestWithSelectedOrg,
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { expectId, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { listNotifications } from '@open-mercato/core/helpers/integration/notificationsFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import { OPTIMISTIC_LOCK_HEADER_NAME } from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import type { GraphFormQuestion, GraphLead } from '../data/validators'
import type { FieldMappingEntryDto, FormDto, LeadEventSummaryDto, PageDto, SubmissionsResponse } from '../api/openapi'
import { INTERACTION_TYPE, QUEUES } from '../lib/constants'
import { NOTIFICATION_TYPES } from '../notifications'
import { assignFakePage, connectFakeMetaAccount, seedFakeForm, setupMetaTestEnv, type MetaTestEnv } from './support/fixtures'
import { buildLeadgenNotification, signBody } from './support/sign'

const BASE_URL = process.env.BASE_URL?.trim() || null
const WEBHOOK_PATH = '/api/meta_lead_ads/webhook'
const EVENTS_QUEUE = 'events'
const PERSON_PROFILE_ENTITY_ID = 'customers:customer_person_profile'
const USER_PASSWORD = 'MetaLead!2345'
const TERMINAL_STATUSES: LeadEventSummaryDto['status'][] = ['processed', 'skipped', 'failed', 'dead_lettered', 'unrouted']

const BASE_QUESTIONS: GraphFormQuestion[] = [
  { key: 'full_name', label: 'Full name', type: 'FULL_NAME' },
  { key: 'email', label: 'Email', type: 'EMAIL' },
  { key: 'phone_number', label: 'Phone number', type: 'PHONE' },
  { key: 'company_name', label: 'Company name', type: 'COMPANY_NAME' },
]

type FormRouting = { metaPageId: string; metaFormId: string }
type PersonDetail = { customFields?: Record<string, unknown> }
type InteractionItem = { id: string; body?: string | null }
type CreatedRecord = { id?: string; entityId?: string; pipelineId?: string; stageId?: string }
type NotificationItem = { id?: string; type?: string; sourceEntityId?: string | null }

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

async function createInOrg(env: MetaTestEnv, path: string, data: Record<string, unknown>): Promise<string> {
  const response = await orgRequest(env, 'POST', path, data)
  expect(response.ok(), `POST ${path} should succeed: ${response.status()}`).toBeTruthy()
  const body = await readJsonSafe<CreatedRecord>(response)
  return expectId(body?.id ?? body?.entityId ?? body?.pipelineId ?? body?.stageId, `POST ${path} should return an id`)
}

async function deleteInOrg(env: MetaTestEnv, path: string, id: string | null) {
  if (!id) return
  await orgRequest(env, 'DELETE', path, { id }).catch(() => undefined)
}

async function readForm(env: MetaTestEnv, formId: string): Promise<FormDto> {
  const [form] = await getItems<FormDto>(env, `/api/meta_lead_ads/forms?id=${formId}&pageSize=1`)
  expect(form, `Form ${formId} should be listed`).toBeTruthy()
  return form
}

async function putForm(
  env: MetaTestEnv,
  form: FormDto,
  patch: Record<string, unknown>,
  expectedUpdatedAt: string = form.updatedAt,
): Promise<APIResponse> {
  return env.request.fetch(resolveUrl('/api/meta_lead_ads/forms'), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.token}`,
      'Content-Type': 'application/json',
      Cookie: `om_selected_org=${env.orgId}`,
      [OPTIMISTIC_LOCK_HEADER_NAME]: expectedUpdatedAt,
    },
    data: { id: form.id, ownerMode: form.ownerMode, ...patch },
  })
}

async function updateForm(env: MetaTestEnv, form: FormDto, patch: Record<string, unknown>): Promise<FormDto> {
  const response = await putForm(env, form, patch)
  expect(response.status(), `PUT forms should succeed: ${await response.text()}`).toBe(200)
  return readForm(env, form.id)
}

function remapTargets(mapping: FieldMappingEntryDto[], overrides: Record<string, string>): FieldMappingEntryDto[] {
  return mapping.map((entry) => ({ questionKey: entry.questionKey, target: overrides[entry.questionKey] ?? entry.target }))
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

async function readSubmissions(env: MetaTestEnv, personId: string): Promise<SubmissionsResponse> {
  const response = await orgRequest(env, 'GET', `/api/meta_lead_ads/people/${personId}/submissions`)
  expect(response.status(), 'GET people submissions should return 200').toBe(200)
  const body = await readJsonSafe<SubmissionsResponse>(response)
  return body ?? { items: [], consents: [] }
}

function buildGraphLead(input: {
  leadId: string
  formId: string
  answers: Record<string, string>
  createdAt?: Date
}): GraphLead {
  return {
    id: input.leadId,
    created_time: graphTime(input.createdAt ?? new Date()),
    form_id: input.formId,
    platform: 'fb',
    is_organic: false,
    campaign_id: `campaign-${input.leadId}`,
    campaign_name: `Campaign ${input.leadId}`,
    field_data: Object.entries(input.answers).map(([name, value]) => ({ name, values: [value] })),
  } as GraphLead
}

async function postSignedNotification(env: MetaTestEnv, rawBody: string) {
  const response = await env.request.fetch(resolveUrl(WEBHOOK_PATH), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signBody(rawBody) },
    data: rawBody,
  })
  expect(response.status(), 'Signed webhook POST should return 200').toBe(200)
}

async function waitForLeadStatuses(
  env: MetaTestEnv,
  leadIds: string[],
  status: LeadEventSummaryDto['status'],
): Promise<LeadEventSummaryDto[]> {
  await drainIntegrationQueue(QUEUES.process)
  let events: LeadEventSummaryDto[] = []
  await expect
    .poll(
      async () => {
        events = await getItems<LeadEventSummaryDto>(env, '/api/meta_lead_ads/lead-events?pageSize=100')
        return leadIds.map((leadId) => {
          const event = events.find((item) => item.metaLeadId === leadId)
          return event && TERMINAL_STATUSES.includes(event.status) ? event.status : 'pending'
        })
      },
      { message: `Lead events should reach status ${status}`, timeout: 60_000 },
    )
    .toEqual(leadIds.map(() => status))
  return leadIds.map((leadId) => events.find((item) => item.metaLeadId === leadId) as LeadEventSummaryDto)
}

async function deliverLeads(
  env: MetaTestEnv,
  routing: FormRouting,
  leads: { leadId: string; answers: Record<string, string>; createdAt?: Date }[],
  status: LeadEventSummaryDto['status'] = 'processed',
): Promise<LeadEventSummaryDto[]> {
  for (const lead of leads) {
    env.fake.state.leads.set(lead.leadId, buildGraphLead({ ...lead, formId: routing.metaFormId }))
  }
  const rawBody = buildLeadgenNotification([
    {
      pageId: routing.metaPageId,
      leads: leads.map((lead) => ({ leadId: lead.leadId, formId: routing.metaFormId })),
    },
  ])
  await postSignedNotification(env, rawBody)
  return waitForLeadStatuses(env, leads.map((lead) => lead.leadId), status)
}

async function setupPage(request: APIRequestContext) {
  const env = await setupMetaTestEnv(request)
  try {
    const connection = await connectFakeMetaAccount(env)
    const suffix = uniqueSuffix()
    const metaPageId = `9${suffix}`
    const page: PageDto = await assignFakePage(env, connection.id, metaPageId)
    return { env, suffix, metaPageId, page }
  } catch (error) {
    await env.cleanup()
    throw error
  }
}

async function dealIdsOf(env: MetaTestEnv): Promise<string[]> {
  const events = await getItems<LeadEventSummaryDto>(env, '/api/meta_lead_ads/lead-events?pageSize=100').catch(() => [])
  return Array.from(new Set(events.map((event) => event.dealId).filter((dealId): dealId is string => !!dealId)))
}

async function pollNotifications(
  request: APIRequestContext,
  token: string,
  type: string,
  sourceEntityIds: string[],
): Promise<NotificationItem[]> {
  let matching: NotificationItem[] = []
  await expect
    .poll(
      async () => {
        await drainIntegrationQueue(EVENTS_QUEUE)
        const { items } = await listNotifications(request, token, { type, pageSize: 100 })
        matching = (items as NotificationItem[]).filter(
          (item) => typeof item.sourceEntityId === 'string' && sourceEntityIds.includes(item.sourceEntityId),
        )
        return matching.length
      },
      { message: `A ${type} notification should be delivered`, timeout: 60_000 },
    )
    .toBeGreaterThan(0)
  return matching
}

/**
 * TC-META-004: Meta Lead Ads form configuration, deals and notifications
 * Maps to quickstart scenario 6 (US3, US4): default mapping after sync, custom question to a person custom field,
 * consent with text and date, disabled form skipped, question drift flagged with the answer kept in the note,
 * optimistic lock on form saves, round-robin deals in the chosen stage, owner and unassigned notifications and the
 * person submissions list.
 */
test.describe('TC-META-004: Meta Lead Ads forms, deals and notifications', () => {
  test('applies form mapping, custom fields, consents, disabled forms and question drift', async ({ request }) => {
    test.setTimeout(60_000)
    const { env, suffix, metaPageId, page } = await setupPage(request)
    const fieldKey = `meta_budget_${suffix}`
    let fieldCreated = false
    try {
      const definition = await orgRequest(env, 'POST', '/api/entities/definitions', {
        entityId: PERSON_PROFILE_ENTITY_ID,
        key: fieldKey,
        kind: 'text',
        configJson: { label: `Meta budget ${suffix}` },
      })
      expect(definition.status(), 'Custom field definition should be created').toBe(200)
      fieldCreated = true

      const metaFormId = `8${suffix}`
      const consentLabel = 'I agree to receive marketing messages'
      const questions: GraphFormQuestion[] = [
        ...BASE_QUESTIONS,
        { key: 'budget', label: 'Budget', type: 'CUSTOM' },
        { key: 'marketing_consent', label: consentLabel, type: 'CUSTOM' },
      ]
      const synced = await seedFakeForm(env, { pageId: page.id, metaPageId, metaFormId, questions })
      expect(synced.isEnabled, 'New forms should be enabled').toBe(true)
      expect(synced.ownerMode).toBe('none')
      expect(synced.createDeal).toBe(false)
      expect(synced.fieldMapping).toEqual(
        expect.arrayContaining([
          { questionKey: 'email', target: 'person.primaryEmail' },
          { questionKey: 'phone_number', target: 'person.primaryPhone' },
          { questionKey: 'full_name', target: 'person.fullName' },
          { questionKey: 'company_name', target: 'company.displayName' },
          { questionKey: 'budget', target: 'note' },
        ]),
      )

      const mapped = await updateForm(env, synced, {
        fieldMapping: remapTargets(synced.fieldMapping, {
          budget: `person.cf:${fieldKey}`,
          marketing_consent: 'consent',
        }),
      })
      expect(mapped.fieldMapping).toEqual(
        expect.arrayContaining([
          { questionKey: 'budget', target: `person.cf:${fieldKey}` },
          { questionKey: 'marketing_consent', target: 'consent' },
        ]),
      )

      const stale = await putForm(env, synced, { isEnabled: true })
      expect(stale.status(), 'PUT with a stale updatedAt should conflict').toBe(409)

      const submittedAt = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000)
      const routing = { metaPageId, metaFormId }
      const [mappedEvent] = await deliverLeads(env, routing, [
        {
          leadId: `71${suffix}`,
          createdAt: submittedAt,
          answers: {
            full_name: `Mapped Lead${suffix}`,
            email: `mapped-${suffix}@example.com`,
            budget: '25000 PLN',
            marketing_consent: 'Yes',
          },
        },
      ])
      expect(mappedEvent.personId).toBeTruthy()
      const personId = mappedEvent.personId as string

      const person = await readPerson(env, personId)
      expect(person.customFields?.[fieldKey], 'Mapped custom question should fill the custom field').toBe('25000 PLN')

      const submissions = await readSubmissions(env, personId)
      const consent = submissions.consents.find((entry) => entry.consentKey === 'marketing_consent')
      expect(consent, 'Consent should be listed with the person submissions').toBeTruthy()
      expect(consent?.consentText).toBe(consentLabel)
      expect(consent?.isChecked).toBe(true)
      expect(consent?.leadEventId).toBe(mappedEvent.id)
      expect(Date.parse(consent?.givenAt ?? ''), 'Consent date should be the lead submission time').toBe(
        submittedAt.getTime(),
      )

      const disabledFormId = `7${suffix}`
      const disabledForm = await seedFakeForm(env, { pageId: page.id, metaPageId, metaFormId: disabledFormId })
      const disabled = await updateForm(env, disabledForm, { isEnabled: false })
      expect(disabled.isEnabled).toBe(false)
      const [skippedEvent] = await deliverLeads(
        env,
        { metaPageId, metaFormId: disabledFormId },
        [{ leadId: `72${suffix}`, answers: { full_name: `Skipped Lead${suffix}`, email: `skipped-${suffix}@example.com` } }],
        'skipped',
      )
      expect(skippedEvent.personId, 'A skipped lead should not create a person').toBeNull()

      const driftFormId = `6${suffix}`
      const driftForm = await seedFakeForm(env, { pageId: page.id, metaPageId, metaFormId: driftFormId })
      expect(driftForm.needsAttention).toBe(false)
      const driftAnswer = `Preferred contact window ${suffix}`
      env.fake.state.formsByPage.set(
        metaPageId,
        (env.fake.state.formsByPage.get(metaPageId) ?? []).map((form) =>
          form.id === driftFormId
            ? { ...form, questions: [...form.questions, { key: 'contact_window', label: 'Contact window', type: 'CUSTOM' }] }
            : form,
        ),
      )
      const [driftEvent] = await deliverLeads(env, { metaPageId, metaFormId: driftFormId }, [
        {
          leadId: `73${suffix}`,
          answers: { full_name: `Drift Lead${suffix}`, email: `drift-${suffix}@example.com`, contact_window: driftAnswer },
        },
      ])
      const driftedForm = await readForm(env, driftForm.id)
      expect(driftedForm.needsAttention, 'A new question should flag the form').toBe(true)
      expect(driftedForm.attentionReason).toBe('questions_changed')
      const driftInteractions = await loadMetaInteractions(env, driftEvent.personId as string)
      expect(
        driftInteractions.some((interaction) => (interaction.body ?? '').includes(driftAnswer)),
        'The unmapped answer should be kept in the interaction note',
      ).toBe(true)
    } finally {
      if (fieldCreated) {
        await orgRequest(env, 'DELETE', '/api/entities/definitions', {
          entityId: PERSON_PROFILE_ENTITY_ID,
          key: fieldKey,
        }).catch(() => undefined)
      }
      await env.cleanup()
    }
  })

  test('creates round-robin deals in the chosen stage and notifies owners and managers', async ({ request }) => {
    test.setTimeout(60_000)
    const { env, suffix, metaPageId, page } = await setupPage(request)
    let pipelineId: string | null = null
    let stageId: string | null = null
    const roleIds: string[] = []
    const userIds: string[] = []
    try {
      pipelineId = await createInOrg(env, '/api/customers/pipelines', { name: `Meta Pipeline ${suffix}` })
      stageId = await createInOrg(env, '/api/customers/pipeline-stages', { pipelineId, label: `Meta Stage ${suffix}` })

      const roleName = `meta-lead-ads-manager-${suffix}`
      const managerRoleId = await createRoleFixture(env.request, env.token, { name: roleName, tenantId: env.tenantId })
      roleIds.push(managerRoleId)
      await setRoleAclFeatures(env.request, env.token, {
        roleId: managerRoleId,
        features: ['meta_lead_ads.manage', 'meta_lead_ads.view_logs'],
      })
      const ownerRoleName = `meta-lead-ads-owner-${suffix}`
      const ownerRoleId = await createRoleFixture(env.request, env.token, { name: ownerRoleName, tenantId: env.tenantId })
      roleIds.push(ownerRoleId)
      await setRoleAclFeatures(env.request, env.token, {
        roleId: ownerRoleId,
        features: ['notifications.view'],
        organizations: [env.orgId],
      })
      const createUser = async (label: string, roles: string[]) => {
        const email = `meta-${label}-${suffix}@example.test`
        const userId = await createUserFixture(env.request, env.token, {
          email,
          password: USER_PASSWORD,
          organizationId: env.orgId,
          roles,
          name: `Meta ${label} ${suffix}`,
        })
        userIds.push(userId)
        return { userId, email }
      }
      const ownerA = await createUser('owner-a', [ownerRoleName])
      const ownerB = await createUser('owner-b', [ownerRoleName])
      const manager = await createUser('manager', [roleName])

      const dealFormId = `8${suffix}`
      const dealForm = await seedFakeForm(env, { pageId: page.id, metaPageId, metaFormId: dealFormId })
      const configured = await updateForm(env, dealForm, {
        createDeal: true,
        pipelineId,
        pipelineStageId: stageId,
        ownerMode: 'round_robin',
        ownerUserIds: [ownerA.userId, ownerB.userId],
      })
      expect(configured.createDeal).toBe(true)
      expect(configured.ownerUserIds).toEqual([ownerA.userId, ownerB.userId])

      const dealEvents = await deliverLeads(env, { metaPageId, metaFormId: dealFormId }, [
        { leadId: `71${suffix}`, answers: { full_name: `Deal One${suffix}`, email: `deal-one-${suffix}@example.com` } },
        { leadId: `72${suffix}`, answers: { full_name: `Deal Two${suffix}`, email: `deal-two-${suffix}@example.com` } },
      ])
      for (const event of dealEvents) {
        expect(event.dealId, 'Each lead should create a deal').toBeTruthy()
        expect(event.lastErrorCode).toBeNull()
      }
      const stageDeals = await getItems<{ id: string }>(
        env,
        `/api/customers/deals?pipelineStageId=${stageId}&pageSize=100`,
      )
      expect(stageDeals.map((deal) => deal.id).sort()).toEqual(dealEvents.map((event) => event.dealId as string).sort())
      for (const owner of [ownerA, ownerB]) {
        const ownedDeals = await getItems<{ id: string }>(
          env,
          `/api/customers/deals?pipelineStageId=${stageId}&ownerUserId=${owner.userId}&pageSize=100`,
        )
        expect(ownedDeals, 'Round robin should give each owner one deal').toHaveLength(1)
      }

      const dealPersonIds = dealEvents.map((event) => event.personId as string)
      for (const owner of [ownerA, ownerB]) {
        const ownerToken = await getAuthToken(env.request, owner.email, USER_PASSWORD)
        const assigned = await pollNotifications(env.request, ownerToken, NOTIFICATION_TYPES.leadAssigned, dealPersonIds)
        expect(assigned[0]?.type).toBe(NOTIFICATION_TYPES.leadAssigned)
      }

      const plainFormId = `7${suffix}`
      await seedFakeForm(env, { pageId: page.id, metaPageId, metaFormId: plainFormId })
      const [unassignedEvent] = await deliverLeads(env, { metaPageId, metaFormId: plainFormId }, [
        { leadId: `73${suffix}`, answers: { full_name: `No Owner${suffix}`, email: `no-owner-${suffix}@example.com` } },
      ])
      expect(unassignedEvent.dealId).toBeNull()
      const managerToken = await getAuthToken(env.request, manager.email, USER_PASSWORD)
      const unassigned = await pollNotifications(env.request, managerToken, NOTIFICATION_TYPES.leadUnassigned, [
        unassignedEvent.personId as string,
      ])
      expect(unassigned[0]?.type).toBe(NOTIFICATION_TYPES.leadUnassigned)
    } finally {
      try {
        for (const dealId of await dealIdsOf(env)) await deleteInOrg(env, '/api/customers/deals', dealId)
        await deleteInOrg(env, '/api/customers/pipeline-stages', stageId)
        await deleteInOrg(env, '/api/customers/pipelines', pipelineId)
      } finally {
        for (const userId of userIds) await deleteUserIfExists(env.request, env.token, userId).catch(() => undefined)
        for (const roleId of roleIds) await deleteRoleIfExists(env.request, env.token, roleId).catch(() => undefined)
        await env.cleanup()
      }
    }
  })

  test('keeps a lead processed and flags the form when the deal stage was deleted', async ({ request }) => {
    const { env, suffix, metaPageId, page } = await setupPage(request)
    let pipelineId: string | null = null
    let keptStageId: string | null = null
    let deletedStageId: string | null = null
    try {
      pipelineId = await createInOrg(env, '/api/customers/pipelines', { name: `Meta Pipeline ${suffix}` })
      keptStageId = await createInOrg(env, '/api/customers/pipeline-stages', { pipelineId, label: `Meta Kept ${suffix}` })
      deletedStageId = await createInOrg(env, '/api/customers/pipeline-stages', {
        pipelineId,
        label: `Meta Deleted ${suffix}`,
      })

      const metaFormId = `8${suffix}`
      const dealForm = await seedFakeForm(env, { pageId: page.id, metaPageId, metaFormId })
      const configured = await updateForm(env, dealForm, {
        createDeal: true,
        pipelineId,
        pipelineStageId: deletedStageId,
      })
      expect(configured.createDeal).toBe(true)
      expect(configured.pipelineStageId).toBe(deletedStageId)

      const stageDelete = await orgRequest(env, 'DELETE', '/api/customers/pipeline-stages', { id: deletedStageId })
      expect(stageDelete.ok(), `DELETE pipeline stage should succeed: ${stageDelete.status()}`).toBeTruthy()
      deletedStageId = null

      const [event] = await deliverLeads(env, { metaPageId, metaFormId }, [
        {
          leadId: `71${suffix}`,
          answers: { full_name: `Stage Gone${suffix}`, email: `stage-gone-${suffix}@example.com` },
        },
      ])
      expect(event.lastErrorCode, 'The failed deal step should be recorded').toBe('deal_step_failed')
      expect(event.dealId, 'No deal should be created').toBeNull()
      expect(event.personId, 'The person should still be created').toBeTruthy()
      expect(event.interactionId, 'The interaction should still be created').toBeTruthy()

      const interactions = await loadMetaInteractions(env, event.personId as string)
      expect(interactions.map((interaction) => interaction.id)).toContain(event.interactionId)
      const personDeals = await getItems<{ id: string }>(
        env,
        `/api/customers/deals?personId=${event.personId}&pageSize=100`,
      )
      expect(personDeals).toHaveLength(0)

      const flagged = await readForm(env, dealForm.id)
      expect(flagged.needsAttention, 'The form should be flagged after the deal step failed').toBe(true)
      expect(flagged.attentionReason).toBe('deal_step_failed')
    } finally {
      await deleteInOrg(env, '/api/customers/pipeline-stages', deletedStageId)
      await deleteInOrg(env, '/api/customers/pipeline-stages', keptStageId)
      await deleteInOrg(env, '/api/customers/pipelines', pipelineId)
      await env.cleanup()
    }
  })

  test('lists every submission of a person', async ({ request }) => {
    const { env, suffix, metaPageId, page } = await setupPage(request)
    try {
      const metaFormId = `8${suffix}`
      await seedFakeForm(env, { pageId: page.id, metaPageId, metaFormId })
      const email = `repeat-${suffix}@example.com`
      const personIds: string[] = []
      for (const index of [1, 2, 3]) {
        const [event] = await deliverLeads(env, { metaPageId, metaFormId }, [
          { leadId: `7${index}${suffix}`, answers: { full_name: `Repeat Lead${suffix}`, email } },
        ])
        personIds.push(event.personId as string)
      }
      expect(new Set(personIds).size, 'All three leads should attach to one person').toBe(1)

      const submissions = await readSubmissions(env, personIds[0])
      expect(submissions.items).toHaveLength(3)
      for (const item of submissions.items) {
        expect(item.status).toBe('processed')
        expect(item.interactionId).toBeTruthy()
      }
    } finally {
      await env.cleanup()
    }
  })
})

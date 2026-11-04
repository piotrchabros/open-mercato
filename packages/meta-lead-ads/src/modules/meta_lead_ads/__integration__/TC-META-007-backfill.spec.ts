import { expect, test, type APIRequestContext } from '@playwright/test'
import { apiRequestWithSelectedOrg } from '@open-mercato/core/helpers/integration/authFixtures'
import { expectId, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import type { LeadEventSummaryDto, SyncRunDto } from '../api/openapi'
import type { GraphLead } from '../data/validators'
import { QUEUES } from '../lib/constants'
import { assignFakePage, connectFakeMetaAccount, seedFakeForm, setupMetaTestEnv, type MetaTestEnv } from './support/fixtures'
import { buildLeadgenNotification, signBody } from './support/sign'

/**
 * TC-META-007: backfill of one form over a date range (quickstart scenario 9).
 *
 * The reconcile run (missing-lead import and the sweep of events stuck in received/retrying for more than 2 h)
 * has no HTTP trigger and the integration helpers cannot enqueue jobs, so it is covered by
 * __tests__/reconcile-worker.test.ts.
 */

const BASE_URL = process.env.BASE_URL?.trim() || null
const DAY_MS = 24 * 60 * 60 * 1000

type ListResponse<Item> = { items?: Item[] }

function resolveUrl(path: string): string {
  return BASE_URL ? `${BASE_URL}${path}` : path
}

function toGraphTime(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '+0000')
}

function buildGraphLead(leadId: string, metaFormId: string, createdAt: Date, email: string): GraphLead {
  return {
    id: leadId,
    created_time: toGraphTime(createdAt),
    form_id: metaFormId,
    platform: 'fb',
    is_organic: false,
    field_data: [
      { name: 'full_name', values: [`Backfill ${leadId}`] },
      { name: 'email', values: [email] },
    ],
  }
}

function orgRequest(env: MetaTestEnv, method: string, path: string, data?: unknown) {
  return apiRequestWithSelectedOrg(env.request, method, path, { token: env.token, selectedOrgId: env.orgId, data })
}

async function postSignedWebhook(request: APIRequestContext, body: string): Promise<void> {
  const response = await request.fetch(resolveUrl('/api/meta_lead_ads/webhook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signBody(body) },
    data: body,
  })
  expect(response.status(), 'POST webhook should return 200').toBe(200)
}

async function listFormLeadEvents(env: MetaTestEnv, formId: string): Promise<LeadEventSummaryDto[]> {
  const response = await orgRequest(
    env,
    'GET',
    `/api/meta_lead_ads/lead-events?formId=${encodeURIComponent(formId)}&pageSize=100`,
  )
  expect(response.status(), 'GET lead-events should return 200').toBe(200)
  const body = await readJsonSafe<ListResponse<LeadEventSummaryDto>>(response)
  return body?.items ?? []
}

async function findSyncRun(env: MetaTestEnv, formId: string, runId: string): Promise<SyncRunDto | null> {
  const response = await orgRequest(
    env,
    'GET',
    `/api/meta_lead_ads/sync-runs?kind=backfill&formId=${encodeURIComponent(formId)}&pageSize=100`,
  )
  expect(response.status(), 'GET sync-runs should return 200').toBe(200)
  const body = await readJsonSafe<ListResponse<SyncRunDto>>(response)
  return body?.items?.find((run) => run.id === runId) ?? null
}

test.describe('TC-META-007: Meta lead backfill', () => {
  test.describe.configure({ timeout: 180_000 })

  test('backfill imports listed leads, counts duplicates and rejects ranges over 90 days', async ({ request }) => {
    let env: MetaTestEnv | null = null
    try {
      env = await setupMetaTestEnv(request)
      const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`
      const metaPageId = `7007${stamp}`
      const metaFormId = `7107${stamp}`
      const connection = await connectFakeMetaAccount(env)
      const page = await assignFakePage(env, connection.id, metaPageId)
      const form = await seedFakeForm(env, { pageId: page.id, metaPageId, metaFormId })

      const now = Date.now()
      const existingLeadId = `7207${stamp}0`
      env.fake.state.leads.set(
        existingLeadId,
        buildGraphLead(existingLeadId, metaFormId, new Date(now - 3 * DAY_MS), `tc-meta-007-existing-${stamp}@example.com`),
      )
      await postSignedWebhook(
        request,
        buildLeadgenNotification([{ pageId: metaPageId, leads: [{ leadId: existingLeadId, formId: metaFormId }] }]),
      )
      await drainIntegrationQueue(QUEUES.process)
      const liveEvents = await listFormLeadEvents(env, form.id)
      expect(
        liveEvents.some((event) => event.metaLeadId === existingLeadId),
        'The webhook lead should be stored before the backfill',
      ).toBe(true)

      const backfillLeadIds = [1, 2, 3].map((index) => `7207${stamp}${index}`)
      backfillLeadIds.forEach((leadId, index) => {
        env?.fake.state.leads.set(
          leadId,
          buildGraphLead(
            leadId,
            metaFormId,
            new Date(now - (index + 1) * DAY_MS),
            `tc-meta-007-${index}-${stamp}@example.com`,
          ),
        )
      })

      const tooWide = await orgRequest(env, 'POST', '/api/meta_lead_ads/backfill', {
        formId: form.id,
        from: new Date(now - 120 * DAY_MS).toISOString(),
        to: new Date(now).toISOString(),
      })
      expect(tooWide.status(), 'A range over 90 days should return 400').toBe(400)

      const backfillResponse = await orgRequest(env, 'POST', '/api/meta_lead_ads/backfill', {
        formId: form.id,
        from: new Date(now - 7 * DAY_MS).toISOString(),
        to: new Date(now).toISOString(),
      })
      expect(backfillResponse.status(), 'POST backfill should return 202').toBe(202)
      const started = await readJsonSafe<{ runId?: string; progressJobId?: string | null }>(backfillResponse)
      const runId = expectId(started?.runId, 'Backfill response should include runId')
      expectId(started?.progressJobId, 'Backfill response should include progressJobId')

      await drainIntegrationQueue(QUEUES.backfill)
      await drainIntegrationQueue(QUEUES.process)

      await expect
        .poll(async () => (await findSyncRun(env as MetaTestEnv, form.id, runId))?.status ?? null, {
          message: 'The backfill run should complete',
          timeout: 30_000,
        })
        .toBe('completed')
      const run = await findSyncRun(env, form.id, runId)
      expect(run?.progressJobId, 'The sync run should reference the progress job').toBe(started?.progressJobId)
      expect(run?.checked, 'The run should check every listed lead').toBe(4)
      expect(run?.imported, 'The run should import the three new leads').toBe(3)
      expect(run?.duplicates, 'The already imported lead should count as a duplicate').toBe(1)
      expect(run?.failed, 'No lead should fail').toBe(0)
      expect(run?.finishedAt, 'A completed run should have finishedAt').toBeTruthy()

      const events = await listFormLeadEvents(env, form.id)
      const backfilled = events.filter((event) => event.source === 'backfill')
      expect(backfilled.map((event) => event.metaLeadId).sort(), 'Each new lead should be stored once').toEqual(
        [...backfillLeadIds].sort(),
      )
      expect(
        events.filter((event) => event.metaLeadId === existingLeadId),
        'The duplicate lead should not be stored twice',
      ).toHaveLength(1)
      await expect
        .poll(
          async () =>
            (await listFormLeadEvents(env as MetaTestEnv, form.id))
              .filter((event) => event.source === 'backfill')
              .every((event) => event.status === 'processed' && !!event.personId),
          { message: 'Backfilled leads should be processed into people', timeout: 30_000 },
        )
        .toBe(true)
    } finally {
      await env?.cleanup()
    }
  })
})

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { config as loadEnv } from 'dotenv'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { insertCostInputRow, hardDeleteCostInputs } from '../../connect_analytics/__integration__/cost-input-sql'
import { loadCostPerContactReport } from '../lib/load-report'

const APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
  ? path.resolve(process.env.OM_TEST_APP_ROOT)
  : path.resolve(process.cwd(), 'apps/mercato')

if (!process.env.OM_TEST_APP_ROOT) loadEnv({ path: path.resolve(APP_ROOT, '.env') })

async function insertCase(input: {
  em: EntityManager
  tenantId: string
  organizationId: string
  createdAt: string
  splitFromCaseId?: string
}): Promise<string> {
  const rows = await input.em.getConnection().execute<Array<{ id: string }>>(
    `insert into connect_cases
       (tenant_id, organization_id, number, display_label, status, priority,
        channel_id, first_inbound_at, last_inbound_at, lineage_version,
        split_from_case_id, created_at, updated_at)
     values (?, ?, ?, 'cpc-fixture', 'in_progress', 'normal', ?, ?, ?, 0, ?, ?, ?)
     returning id`,
    [
      input.tenantId,
      input.organizationId,
      Math.floor(Math.random() * 1_000_000_000),
      randomUUID(),
      input.createdAt,
      input.createdAt,
      input.splitFromCaseId ?? null,
      input.createdAt,
      input.createdAt,
    ],
  )
  return rows[0]!.id
}

test.describe('CPC cost-per-contact composition', () => {
  test('CPC-INT-001/002/003/006/007: exact API allocation, split collapse and scope isolation', async ({ request }) => {
    await bootstrapFromAppRoot(APP_ROOT)
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(token)
    const siblingOrganizationId = randomUUID()
    const costIds: string[] = []
    const caseIds: string[] = []
    try {
      costIds.push(await insertCostInputRow(em, {
        tenantId,
        organizationId,
        periodStart: '2026-03-01T00:00:00.000Z',
        periodEnd: '2026-03-21T00:00:00.000Z',
        costType: 'agent',
        userId: randomUUID(),
        amountMinor: '101',
        currencyCode: 'EUR',
      }))
      costIds.push(await insertCostInputRow(em, {
        tenantId,
        organizationId: siblingOrganizationId,
        periodStart: '2026-03-01T00:00:00.000Z',
        periodEnd: '2026-03-21T00:00:00.000Z',
        costType: 'ai',
        amountMinor: '999999',
        currencyCode: 'EUR',
      }))

      const root = await insertCase({ em, tenantId, organizationId, createdAt: '2026-03-05T00:00:00.000Z' })
      const child = await insertCase({ em, tenantId, organizationId, createdAt: '2026-03-12T00:00:00.000Z', splitFromCaseId: root })
      const grandchild = await insertCase({ em, tenantId, organizationId, createdAt: '2026-03-13T00:00:00.000Z', splitFromCaseId: child })
      const secondRoot = await insertCase({ em, tenantId, organizationId, createdAt: '2026-03-15T00:00:00.000Z' })
      const siblingRoot = await insertCase({ em, tenantId, organizationId: siblingOrganizationId, createdAt: '2026-03-06T00:00:00.000Z' })
      caseIds.push(root, child, grandchild, secondRoot, siblingRoot)

      const response = await apiRequest(request, 'GET',
        '/api/connect_cost_reporting/report?from=2026-03-01T00%3A00%3A00.000Z&to=2026-03-21T00%3A00%3A00.000Z&currency=EUR', {
          token,
        },
      )
      expect(response.status()).toBe(200)
      const report = await readJsonSafe<Record<string, unknown>>(response)
      expect(report).not.toBeNull()

      expect(report).toMatchObject({
        capability: 'available',
        currencyCode: 'EUR',
        denominator: 2,
        totals: { agentMinor: '101', channelMinor: '0', aiMinor: '0', totalMinor: '101' },
        costPerContactMinor: '51',
        matchedInputCount: 1,
      })
      expect(JSON.stringify(report)).not.toMatch(/caseId|userId|description|provider|invoice|actor/i)
    } finally {
      await hardDeleteCostInputs(em, costIds)
      if (caseIds.length > 0) {
        const placeholders = caseIds.map(() => '?').join(', ')
        await em.getConnection().execute(`delete from connect_cases where id in (${placeholders})`, caseIds)
      }
      await container.dispose()
    }
  })

  test('CPC-INT-004/005: financial denial invokes no source and returns no partial totals', async () => {
    await bootstrapFromAppRoot(APP_ROOT)
    const container = await createRequestContainer()
    try {
      const report = await loadCostPerContactReport({
        container,
        tenantId: randomUUID(),
        organizationId: randomUUID(),
        from: '2026-03-01T00:00:00.000Z',
        to: '2026-03-02T00:00:00.000Z',
        currencyCode: 'EUR',
        financialAuthorized: false,
      })
      expect(report).toEqual({
        capability: 'unavailable',
        formulaVersion: 'connect_cost_reporting.cost_per_contact.v1',
        reason: 'not_authorized',
        totals: null,
        denominator: null,
        costPerContactMinor: null,
      })
    } finally {
      await container.dispose()
    }
  })
})

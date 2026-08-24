import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { config as loadEnv } from 'dotenv'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { hardDeleteCostInputs, insertCostInputRow } from './cost-input-sql'

const APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
  ? path.resolve(process.env.OM_TEST_APP_ROOT)
  : path.resolve(process.cwd(), 'apps/mercato')

if (!process.env.OM_TEST_APP_ROOT) loadEnv({ path: path.resolve(APP_ROOT, '.env') })

type AllocatedCostReader = {
  summarizeAllocated(input: {
    tenantId: string
    organizationId: string
    periodStart: Date
    periodEnd: Date
    currencyCode: string
  }): Promise<{
    contractVersion: string
    generatedAt: string
    currencyCode: string
    matchedInputCount: number
    byType: Array<{ type: string; allocatedMinor: { numerator: string; denominator: string } }>
  }>
}

async function readerFixture(): Promise<{
  em: EntityManager
  reader: AllocatedCostReader
  dispose: () => Promise<void>
}> {
  await bootstrapFromAppRoot(APP_ROOT)
  const container = await createRequestContainer()
  return {
    em: container.resolve<EntityManager>('em'),
    reader: container.resolve<AllocatedCostReader>('connectAllocatedCostReader'),
    dispose: () => container.dispose(),
  }
}

test.describe('CSRC allocated cost source contract', () => {
  test('CSRC-INT-001/002/003: exact totals, ordering, scope, currency and half-open boundaries', async () => {
    const { em, reader, dispose } = await readerFixture()
    const tenantId = randomUUID()
    const organizationId = randomUUID()
    const siblingOrganizationId = randomUUID()
    const userId = randomUUID()
    const channelId = randomUUID()
    const created: string[] = []
    const insert = async (overrides: Partial<Parameters<typeof insertCostInputRow>[1]> = {}) => {
      const id = await insertCostInputRow(em, {
        tenantId,
        organizationId,
        periodStart: '2026-03-10T00:00:00.000Z',
        periodEnd: '2026-03-20T00:00:00.000Z',
        costType: 'ai',
        amountMinor: '100',
        currencyCode: 'EUR',
        ...overrides,
      })
      created.push(id)
    }

    try {
      await insert({ costType: 'ai', amountMinor: '100' })
      await insert({ costType: 'agent', userId, amountMinor: '99', periodStart: '2026-03-05T00:00:00.000Z', periodEnd: '2026-03-15T00:00:00.000Z' })
      await insert({ costType: 'channel', channelId, amountMinor: '300', periodStart: '2026-03-01T00:00:00.000Z', periodEnd: '2026-03-10T00:00:00.000Z' })
      await insert({ amountMinor: '500', currencyCode: 'USD' })
      await insert({ amountMinor: '700', organizationId: siblingOrganizationId })

      const summary = await reader.summarizeAllocated({
        tenantId,
        organizationId,
        periodStart: new Date('2026-03-10T00:00:00.000Z'),
        periodEnd: new Date('2026-03-20T00:00:00.000Z'),
        currencyCode: 'EUR',
      })

      expect(summary).toMatchObject({
        contractVersion: 'connect_analytics.allocated_cost.v1',
        currencyCode: 'EUR',
        matchedInputCount: 2,
        byType: [
          { type: 'agent', allocatedMinor: { numerator: '99', denominator: '2' } },
          { type: 'ai', allocatedMinor: { numerator: '100', denominator: '1' } },
        ],
      })
      expect(Date.parse(summary.generatedAt)).not.toBeNaN()
      expect(Object.keys(summary).sort()).toEqual([
        'byType', 'contractVersion', 'currencyCode', 'generatedAt', 'matchedInputCount',
      ])
    } finally {
      await hardDeleteCostInputs(em, created)
      await dispose()
    }
  })

  test('CSRC-PERF-001: more than 10k inputs still produce a three-row maximum', async () => {
    const { em, reader, dispose } = await readerFixture()
    const tenantId = randomUUID()
    const organizationId = randomUUID()

    try {
      await em.getConnection().execute(
        `insert into connect_cost_inputs
          (tenant_id, organization_id, period_start, period_end, cost_type,
           amount_minor, currency_code, source, created_at, updated_at)
         select ?, ?, '2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z',
                'ai', '31', 'EUR', 'manual', now(), now()
           from generate_series(1, 10001) as value`,
        [tenantId, organizationId],
      )

      const summary = await reader.summarizeAllocated({
        tenantId,
        organizationId,
        periodStart: new Date('2026-03-01T00:00:00.000Z'),
        periodEnd: new Date('2026-04-01T00:00:00.000Z'),
        currencyCode: 'EUR',
      })
      expect(summary.matchedInputCount).toBe(10001)
      expect(summary.byType).toHaveLength(1)

      const plan = await em.getConnection().execute<Array<{ 'QUERY PLAN': string }>>(
        `explain select period_start, period_end, cost_type, amount_minor
           from connect_cost_inputs
          where tenant_id = ? and organization_id = ? and currency_code = ?
            and deleted_at is null and period_start < ? and period_end > ?`,
        [tenantId, organizationId, 'EUR', new Date('2026-04-01T00:00:00.000Z'), new Date('2026-03-01T00:00:00.000Z')],
      )
      expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain('connect_cost_inputs_allocation_idx')
    } finally {
      await em.getConnection().execute(
        'delete from connect_cost_inputs where tenant_id = ? and organization_id = ?',
        [tenantId, organizationId],
      )
      await dispose()
    }
  })
})

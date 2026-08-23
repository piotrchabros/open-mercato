import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { config as loadEnv } from 'dotenv'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import type { ConnectCaseSlaReader } from '../lib/sla-source-reader'
import {
  deleteFactsForCases,
  insertCaseRow,
  insertDeliveryFact,
  insertWaitFact,
  nextCaseNumber,
} from './sla-source-sql'

/**
 * The scoped keyset reader against a real database.
 *
 * The watermark is the part that only a real database can prove: the reader
 * bounds every page by it precisely so a fact committed mid-sync — with an
 * `occurred_at` BELOW a page already read — cannot be silently skipped by the
 * next call.
 */

const APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
  ? path.resolve(process.env.OM_TEST_APP_ROOT)
  : path.resolve(process.cwd(), 'apps/mercato')

if (!process.env.OM_TEST_APP_ROOT) loadEnv({ path: path.resolve(APP_ROOT, '.env') })

const at = (minutes: number) => new Date(Date.UTC(2026, 7, 23, 10, minutes)).toISOString()

test.describe('TC-CONNECT-SLA-002: scoped keyset reader', () => {
  test('pages facts in scope order and refuses everything outside its bounds', async ({ request }) => {
    const token = await getAuthToken(request)
    const { tenantId, organizationId } = getTokenContext(token)
    const scope = { tenantId, organizationId }
    const caseId = randomUUID()
    const otherOrgCaseId = randomUUID()
    const channelId = randomUUID()

    await bootstrapFromAppRoot(APP_ROOT)
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')
    const reader = container.resolve<ConnectCaseSlaReader>('connectCaseSlaReader')

    try {
      await insertCaseRow(em, {
        ...scope,
        caseId,
        channelId,
        number: await nextCaseNumber(em, scope),
      })

      const before = await reader.captureHighWatermark(scope)

      for (const [index, minutes] of [0, 5, 10].entries()) {
        await insertDeliveryFact(em, {
          ...scope,
          sourceEventId: `sla-002-delivery-${index}:${caseId}`,
          caseId,
          generation: 0,
          outboundMessageId: randomUUID(),
          attemptId: randomUUID(),
          deliveryRevision: index + 1,
          confirmedAt: at(minutes),
          responseEvidence: index === 0 ? 'human' : 'unknown',
          occurredAt: at(minutes),
        })
      }

      // A neighbouring organization's facts must be invisible, whatever the
      // cursor says.
      await insertDeliveryFact(em, {
        tenantId,
        organizationId: randomUUID(),
        sourceEventId: `sla-002-foreign:${otherOrgCaseId}`,
        caseId: otherOrgCaseId,
        generation: 0,
        outboundMessageId: randomUUID(),
        attemptId: randomUUID(),
        deliveryRevision: 1,
        confirmedAt: at(7),
        responseEvidence: 'human',
        occurredAt: at(7),
      })

      const through = await reader.captureHighWatermark(scope)

      const first = await reader.listConfirmedDeliveries(scope, { after: before, through, limit: 2 })
      expect(first.items).toHaveLength(2)
      expect(first.nextCursor).not.toBeNull()
      expect(first.highWatermark).toEqual(through)
      expect(first.items.map((item) => item.confirmedAt)).toEqual([at(0), at(5)])
      expect(first.items[0]?.responseEvidence).toBe('human')

      const second = await reader.listConfirmedDeliveries(scope, {
        after: first.nextCursor ?? undefined,
        through,
        limit: 2,
      })
      expect(second.items.map((item) => item.confirmedAt)).toEqual([at(10)])
      expect(second.nextCursor).toBeNull()
      // Three own facts and not the foreign one.
      expect([...first.items, ...second.items].every((item) => item.caseId === caseId)).toBe(true)

      // A fact committed after the watermark stays outside this sync run and is
      // picked up by the next one — never lost, never duplicated.
      await insertWaitFact(em, {
        ...scope,
        sourceEventId: `sla-002-late:${caseId}`,
        caseId,
        generation: 0,
        boundary: 'started',
        startedAt: at(20),
        occurredAt: at(20),
      })
      const waits = await reader.listWaitIntervals(scope, { after: before, through, limit: 100 })
      expect(waits.items).toHaveLength(0)

      const nextThrough = await reader.captureHighWatermark(scope)
      const waitsAfter = await reader.listWaitIntervals(scope, {
        after: before,
        through: nextThrough,
        limit: 100,
      })
      expect(waitsAfter.items.map((item) => item.startedAt)).toEqual([at(20)])
      expect(waitsAfter.items[0]?.endedAt).toBeNull()

      await expect(
        reader.listConfirmedDeliveries(scope, { through, limit: 101 }),
      ).rejects.toThrow()

      // A Case in another organization is unreadable regardless of grants.
      await expect(
        reader.canReadCase(
          { tenantId, organizationId: randomUUID(), userId: randomUUID() },
          caseId,
        ),
      ).resolves.toBe(false)
    } finally {
      await em.getConnection().execute(
        `delete from connect_outbound_delivery_facts where case_id = ?`,
        [otherOrgCaseId],
      )
      await deleteFactsForCases(em, { ...scope, caseIds: [caseId] })
      await container.dispose()
    }
  })
})

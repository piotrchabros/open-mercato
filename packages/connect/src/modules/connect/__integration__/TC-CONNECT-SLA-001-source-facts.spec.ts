import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { config as loadEnv } from 'dotenv'
import { bootstrapFromAppRoot } from '@open-mercato/shared/lib/bootstrap/dynamicLoader'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  deleteFactsForCases,
  insertCaseRow,
  insertDeliveryFact,
  insertGenerationFact,
  insertWaitFact,
  nextCaseNumber,
} from './sla-source-sql'

/**
 * The database guarantees the fact tables are supposed to make unconditional.
 *
 * These are asserted against a real Postgres rather than a mocked EntityManager
 * because they are exactly the properties a unit test cannot prove: a unique
 * index that does not exist still lets every duplicate through, and a missing
 * CHECK lets a bad enum land in a reporting table nobody re-validates.
 */

const APP_ROOT = process.env.OM_TEST_APP_ROOT?.trim()
  ? path.resolve(process.env.OM_TEST_APP_ROOT)
  : path.resolve(process.cwd(), 'apps/mercato')

if (!process.env.OM_TEST_APP_ROOT) loadEnv({ path: path.resolve(APP_ROOT, '.env') })

test.describe('TC-CONNECT-SLA-001: append-only source facts', () => {
  test('enforces idempotency, scope and closed enums at the database', async ({ request }) => {
    const token = await getAuthToken(request)
    const { tenantId, organizationId } = getTokenContext(token)
    const scope = { tenantId, organizationId }
    const caseId = randomUUID()
    const channelId = randomUUID()
    const occurredAt = new Date('2026-08-23T10:00:00.000Z').toISOString()

    await bootstrapFromAppRoot(APP_ROOT)
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')

    try {
      await insertCaseRow(em, {
        ...scope,
        caseId,
        channelId,
        number: await nextCaseNumber(em, scope),
      })

      await insertGenerationFact(em, {
        ...scope,
        sourceEventId: `sla-001-open:${caseId}`,
        caseId,
        generation: 0,
        channelId,
        boundary: 'started',
        cause: 'opened',
        startedAt: occurredAt,
        occurredAt,
      })

      // A redelivered announcement must not become a second fact.
      await expect(
        insertGenerationFact(em, {
          ...scope,
          sourceEventId: `sla-001-open:${caseId}`,
          caseId,
          generation: 0,
          channelId,
          boundary: 'started',
          cause: 'opened',
          startedAt: occurredAt,
          occurredAt,
        }),
      ).rejects.toThrow()

      // A round can never run backwards.
      await expect(
        insertWaitFact(em, {
          ...scope,
          sourceEventId: `sla-001-negative:${caseId}`,
          caseId,
          generation: -1,
          boundary: 'started',
          startedAt: occurredAt,
          occurredAt,
        }),
      ).rejects.toThrow()

      // Evidence outside the closed set is refused rather than stored and later
      // read back as something a consumer has to interpret.
      await expect(
        insertDeliveryFact(em, {
          ...scope,
          sourceEventId: `sla-001-bad-evidence:${caseId}`,
          caseId,
          generation: 0,
          outboundMessageId: randomUUID(),
          attemptId: randomUUID(),
          deliveryRevision: 1,
          confirmedAt: occurredAt,
          responseEvidence: 'definitely_a_human',
          occurredAt,
        }),
      ).rejects.toThrow()

      // The same source event id is free to exist in a DIFFERENT organization:
      // idempotency is scoped, not global.
      await insertGenerationFact(em, {
        tenantId,
        organizationId: randomUUID(),
        sourceEventId: `sla-001-open:${caseId}`,
        caseId,
        generation: 0,
        channelId,
        boundary: 'started',
        cause: 'opened',
        startedAt: occurredAt,
        occurredAt,
      })

      const rows = await em.getConnection().execute<{ count: string }[]>(
        `select count(*)::text as count from connect_case_generation_facts where case_id = ?`,
        [caseId],
      )
      expect(Number(rows[0]?.count ?? '0')).toBe(2)
    } finally {
      await em.getConnection().execute(
        `delete from connect_case_generation_facts where case_id = ?`,
        [caseId],
      )
      await deleteFactsForCases(em, { ...scope, caseIds: [caseId] })
      await container.dispose()
    }
  })
})

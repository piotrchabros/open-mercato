import { expect, test } from '@playwright/test'
import type { EntityManager } from '@mikro-orm/postgresql'
import { readCase, seedCase, seedConversation } from './helpers/reparentingFixtures'
import { commandKey, openReparentingSpec, splitUrl } from './helpers/reparentingSpec'

/**
 * REP-INT-013 — Case numbers come from a locked sequence.
 *
 * `max(number) + 1` is a read, not an allocation: two openers see the same
 * maximum, both claim it, and one dies on the unique constraint after doing all
 * its other work. Split creation and inbound Case opening now share one locked
 * sequence row, so concurrent allocations queue instead of colliding.
 */

async function readSequence(
  em: EntityManager,
  scope: { tenantId: string; organizationId: string },
): Promise<number | null> {
  const rows = await em.getConnection().execute<Array<{ next_number: number }>>(
    `select next_number from connect_case_number_sequences where tenant_id = ? and organization_id = ?`,
    [scope.tenantId, scope.organizationId],
  )
  return rows[0] ? Number(rows[0].next_number) : null
}

test.describe('TC-CONNECT-REP-013: atomic case-number allocation', () => {
  test('seeds the sequence past every existing case number', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      // The migration seeds each scope from `max(number) + 1`, so the sequence
      // must already be ahead of anything the initial seed created.
      const highest = await ctx.em.getConnection().execute<Array<{ max: number | null }>>(
        `select max(number) as max from connect_cases where tenant_id = ? and organization_id = ?`,
        [ctx.scope.tenantId, ctx.scope.organizationId],
      )
      const sequence = await readSequence(ctx.em, ctx.scope)
      const existingMax = Number(highest[0]?.max ?? 0)
      if (sequence !== null && existingMax > 0) {
        expect(sequence).toBeGreaterThan(existingMax)
      }

      const seeded = await seedCase(ctx.em, ctx.scope, { channelId: ctx.channelId })
      ctx.ledger.trackCase(seeded.id)
      expect(seeded.number).toBeGreaterThan(existingMax)
      expect(await readSequence(ctx.em, ctx.scope)).toBeGreaterThan(seeded.number)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('gives a split child a distinct number that advances the sequence', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const source = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
      })
      ctx.ledger.trackCase(source.id)
      const staying = await seedConversation(ctx.em, ctx.scope, { channelId: ctx.channelId, caseId: source.id })
      const moving = await seedConversation(ctx.em, ctx.scope, { channelId: ctx.channelId, caseId: source.id })
      ctx.ledger.trackConversation(staying.id)
      ctx.ledger.trackConversation(moving.id)

      const beforeSequence = await readSequence(ctx.em, ctx.scope)

      const response = await request.post(splitUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          conversationIds: [moving.id],
          expectedUpdatedAt: source.updatedAt,
          clientCommandKey: commandKey('rep-013-child'),
          reason: 'Split allocating a child case number',
        },
      })
      expect(response.status()).toBe(201)
      const body = await response.json()
      ctx.ledger.trackCase(body.destinationCaseId)

      const child = await readCase(ctx.em, body.destinationCaseId)
      expect(child!.number).toBe(beforeSequence)
      expect(child!.number).not.toBe(source.number)
      expect(await readSequence(ctx.em, ctx.scope)).toBe(beforeSequence! + 1)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('never issues the same number to concurrent splits', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      // Four independent sources, each split at the same moment. Under
      // `max(number) + 1` these would race for one number and some would fail
      // on the unique constraint; under the locked sequence they queue.
      const sources = []
      for (let index = 0; index < 4; index += 1) {
        const source = await seedCase(ctx.em, ctx.scope, {
          channelId: ctx.channelId,
          customerKind: 'person',
          customerId: ctx.customerId,
        })
        ctx.ledger.trackCase(source.id)
        const staying = await seedConversation(ctx.em, ctx.scope, {
          channelId: ctx.channelId,
          caseId: source.id,
        })
        const moving = await seedConversation(ctx.em, ctx.scope, {
          channelId: ctx.channelId,
          caseId: source.id,
        })
        ctx.ledger.trackConversation(staying.id)
        ctx.ledger.trackConversation(moving.id)
        sources.push({ source, moving })
      }

      const responses = await Promise.all(
        sources.map(({ source, moving }, index) =>
          request.post(splitUrl(source.id), {
            headers: ctx.authHeaders,
            data: {
              conversationIds: [moving.id],
              expectedUpdatedAt: source.updatedAt,
              clientCommandKey: commandKey(`rep-013-concurrent-${index}`),
              reason: `Concurrent split ${index}`,
            },
          }),
        ),
      )

      const numbers: number[] = []
      for (const response of responses) {
        expect(response.status()).toBe(201)
        const body = await response.json()
        ctx.ledger.trackCase(body.destinationCaseId)
        const child = await readCase(ctx.em, body.destinationCaseId)
        numbers.push(child!.number)
      }

      // Every child got its own human-facing number.
      expect(new Set(numbers).size).toBe(numbers.length)
      expect(await readSequence(ctx.em, ctx.scope)).toBeGreaterThan(Math.max(...numbers))
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })
})

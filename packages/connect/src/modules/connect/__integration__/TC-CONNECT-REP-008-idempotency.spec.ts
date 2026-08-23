import { expect, test } from '@playwright/test'
import {
  countActiveBindings,
  readBindings,
  readOutboxEventTypes,
  readReparentings,
  seedCase,
  seedConversation,
} from './helpers/reparentingFixtures'
import { commandKey, openReparentingSpec, splitUrl } from './helpers/reparentingSpec'

/**
 * REP-INT-008 — idempotency and a stable source event id.
 *
 * A lost response is the normal case, not the exotic one: the operator's browser
 * retries and MUST NOT perform a second correction. The command key makes the
 * retry resolve to the original operation, and the reparenting row's id doubles
 * as the outbox `source_event_id` so a consumer receiving the event twice can
 * deduplicate it without querying Connect.
 */
test.describe('TC-CONNECT-REP-008: idempotent retries and stable event identity', () => {
  test('replays the original result and creates no second correction', async ({ request }) => {
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

      const key = commandKey('rep-008-replay')
      const payload = {
        conversationIds: [moving.id],
        expectedUpdatedAt: source.updatedAt,
        clientCommandKey: key,
        reason: 'Split retried after a lost response',
      }

      const first = await request.post(splitUrl(source.id), { headers: ctx.authHeaders, data: payload })
      expect(first.status()).toBe(201)
      const firstBody = await first.json()
      ctx.ledger.trackCase(firstBody.destinationCaseId)

      // The retry carries the SAME key and the SAME payload — including the now
      // stale `expectedUpdatedAt`, which is what a real retry would send.
      const retry = await request.post(splitUrl(source.id), { headers: ctx.authHeaders, data: payload })
      expect(retry.status()).toBe(200)
      const retryBody = await retry.json()
      expect(retryBody).toMatchObject({
        idempotentReplay: true,
        reparentingId: firstBody.reparentingId,
        sourceCaseId: firstBody.sourceCaseId,
        destinationCaseId: firstBody.destinationCaseId,
        movedConversationIds: firstBody.movedConversationIds,
        sourceUpdatedAt: firstBody.sourceUpdatedAt,
        destinationUpdatedAt: firstBody.destinationUpdatedAt,
      })

      // Exactly one of everything: no duplicate binding, audit row or event.
      expect(await readReparentings(ctx.em, ctx.scope, source.id)).toHaveLength(1)
      expect(await readBindings(ctx.em, moving.id)).toHaveLength(2)
      expect(await countActiveBindings(ctx.em, moving.id)).toBe(1)
      expect(await readOutboxEventTypes(ctx.em, ctx.scope, [firstBody.reparentingId])).toHaveLength(1)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('rejects the same key carrying a different payload', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const source = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
      })
      ctx.ledger.trackCase(source.id)
      const staying = await seedConversation(ctx.em, ctx.scope, { channelId: ctx.channelId, caseId: source.id })
      const first = await seedConversation(ctx.em, ctx.scope, { channelId: ctx.channelId, caseId: source.id })
      const second = await seedConversation(ctx.em, ctx.scope, { channelId: ctx.channelId, caseId: source.id })
      ctx.ledger.trackConversation(staying.id)
      ctx.ledger.trackConversation(first.id)
      ctx.ledger.trackConversation(second.id)

      const key = commandKey('rep-008-conflict')
      const original = await request.post(splitUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          conversationIds: [first.id],
          expectedUpdatedAt: source.updatedAt,
          clientCommandKey: key,
          reason: 'Original split',
        },
      })
      expect(original.status()).toBe(201)
      ctx.ledger.trackCase((await original.json()).destinationCaseId)

      // Reusing a key for a DIFFERENT correction is a client bug. Quietly
      // returning the first result for it would hide a real mistake.
      const reused = await request.post(splitUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          conversationIds: [second.id],
          expectedUpdatedAt: source.updatedAt,
          clientCommandKey: key,
          reason: 'Different split under a reused key',
        },
      })
      expect(reused.status()).toBe(409)
      expect(await reused.json()).toMatchObject({ code: 'command_key_conflict' })

      // The second conversation never moved.
      expect(await readBindings(ctx.em, second.id)).toHaveLength(1)
      expect(await readReparentings(ctx.em, ctx.scope, source.id)).toHaveLength(1)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('uses the reparenting id as a stable, deduplicable source event id', async ({ request }) => {
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

      const response = await request.post(splitUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          conversationIds: [moving.id],
          expectedUpdatedAt: source.updatedAt,
          clientCommandKey: commandKey('rep-008-event'),
          reason: 'Split announced once',
        },
      })
      const body = await response.json()
      ctx.ledger.trackCase(body.destinationCaseId)

      const events = await readOutboxEventTypes(ctx.em, ctx.scope, [body.reparentingId])
      expect(events).toHaveLength(1)
      // The id a consumer deduplicates on is the same id it can reconcile with
      // through the read facade — one identifier, one meaning.
      expect(events[0].source_event_id).toBe(body.reparentingId)
      expect(events[0].payload).toMatchObject({
        sourceEventId: body.reparentingId,
        reparentingId: body.reparentingId,
        reversesReparentingId: null,
      })
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })
})

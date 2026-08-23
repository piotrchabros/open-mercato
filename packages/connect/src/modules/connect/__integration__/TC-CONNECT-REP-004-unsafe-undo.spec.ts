import { expect, test } from '@playwright/test'
import {
  readCase,
  readConversationCaseId,
  readReparentings,
  seedCase,
  seedConversation,
} from './helpers/reparentingFixtures'
import { UNDO_URL, commandKey, openReparentingSpec, splitUrl } from './helpers/reparentingSpec'

/**
 * REP-INT-004 — undo fails closed once the world has moved on.
 *
 * This is the whole reason undo is conditional. A mechanical reversal after
 * later traffic is a decision about work nobody reviewed: it would drag a
 * customer's new reply back onto a Case the supervisor had deliberately moved
 * it off. A `409` telling the operator to look is strictly safer.
 */
test.describe('TC-CONNECT-REP-004: unsafe undo is refused', () => {
  test('refuses after a moved conversation receives later activity', async ({ request }) => {
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

      const split = await request.post(splitUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          conversationIds: [moving.id],
          expectedUpdatedAt: source.updatedAt,
          clientCommandKey: commandKey('rep-004-activity'),
          reason: 'Split before later traffic',
        },
      })
      expect(split.status()).toBe(201)
      const splitBody = await split.json()
      ctx.ledger.trackCase(splitBody.destinationCaseId)

      // The customer replies after the correction.
      await ctx.em.getConnection().execute(
        `update connect_conversations set last_message_at = now(), updated_at = now() where id = ?`,
        [moving.id],
      )

      const undo = await request.post(UNDO_URL, {
        headers: ctx.authHeaders,
        data: { undoToken: splitBody.undoToken },
      })
      expect(undo.status()).toBe(409)
      expect(await undo.json()).toMatchObject({ code: 'unsafe_undo' })

      // Nothing moved, and the later work is preserved exactly where it landed.
      expect(await readConversationCaseId(ctx.em, moving.id)).toBe(splitBody.destinationCaseId)
      const child = await readCase(ctx.em, splitBody.destinationCaseId)
      expect(child!.deleted_at).toBeNull()
      const audit = await readReparentings(ctx.em, ctx.scope, source.id)
      expect(audit).toHaveLength(1)
      expect(audit[0].status).toBe('completed')
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('refuses after the source case itself changes', async ({ request }) => {
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

      const split = await request.post(splitUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          conversationIds: [moving.id],
          expectedUpdatedAt: source.updatedAt,
          clientCommandKey: commandKey('rep-004-source'),
          reason: 'Split before the source moves on',
        },
      })
      const splitBody = await split.json()
      ctx.ledger.trackCase(splitBody.destinationCaseId)

      // An agent picks the source up after the correction. Restoring the
      // recorded snapshot now would silently drop that assignment.
      await ctx.em.getConnection().execute(
        `update connect_cases set priority = 'high', updated_at = now() where id = ?`,
        [source.id],
      )

      const undo = await request.post(UNDO_URL, {
        headers: ctx.authHeaders,
        data: { undoToken: splitBody.undoToken },
      })
      expect(undo.status()).toBe(409)
      expect(await undo.json()).toMatchObject({ code: 'unsafe_undo' })
      expect(await readConversationCaseId(ctx.em, moving.id)).toBe(splitBody.destinationCaseId)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('refuses after a moved conversation is reparented again', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const source = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
      })
      const elsewhere = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
      })
      ctx.ledger.trackCase(source.id)
      ctx.ledger.trackCase(elsewhere.id)
      const staying = await seedConversation(ctx.em, ctx.scope, { channelId: ctx.channelId, caseId: source.id })
      const moving = await seedConversation(ctx.em, ctx.scope, { channelId: ctx.channelId, caseId: source.id })
      ctx.ledger.trackConversation(staying.id)
      ctx.ledger.trackConversation(moving.id)

      const split = await request.post(splitUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          conversationIds: [moving.id],
          expectedUpdatedAt: source.updatedAt,
          clientCommandKey: commandKey('rep-004-moved'),
          reason: 'Split before a second correction',
        },
      })
      const splitBody = await split.json()
      ctx.ledger.trackCase(splitBody.destinationCaseId)

      // A second supervisor moves the conversation on. Undoing the first
      // operation would silently reverse the second one too.
      await ctx.em.getConnection().execute(
        `update connect_conversations set current_case_id = ?, updated_at = now() where id = ?`,
        [elsewhere.id, moving.id],
      )

      const undo = await request.post(UNDO_URL, {
        headers: ctx.authHeaders,
        data: { undoToken: splitBody.undoToken },
      })
      expect(undo.status()).toBe(409)
      expect(await undo.json()).toMatchObject({ code: 'unsafe_undo' })
      expect(await readConversationCaseId(ctx.em, moving.id)).toBe(elsewhere.id)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })
})

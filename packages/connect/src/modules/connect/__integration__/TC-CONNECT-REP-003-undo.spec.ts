import { expect, test } from '@playwright/test'
import {
  countActiveBindings,
  readCase,
  readConversationCaseId,
  readReparentings,
  seedCase,
  seedConversation,
} from './helpers/reparentingFixtures'
import { UNDO_URL, commandKey, mergeUrl, openReparentingSpec, splitUrl } from './helpers/reparentingSpec'

/**
 * REP-INT-003 — safe undo of both operations, through the canonical URL.
 *
 * There is deliberately no `/case-reparentings/[id]/undo` route: the audit-log
 * undo endpoint is the only HTTP inverse, and the reparent command's own
 * `undo()` is the only implementation. This spec exercises that path end to
 * end for BOTH branches, because on this stack an undo-of-create branch once
 * shipped as unreachable dead code that no unit test caught (#32).
 */
test.describe('TC-CONNECT-REP-003: safe undo through the audit-log endpoint', () => {
  test('reverses a split, returns the conversation and retires the empty child', async ({ request }) => {
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
          clientCommandKey: commandKey('rep-003-split'),
          reason: 'Split that will be undone',
        },
      })
      expect(split.status()).toBe(201)
      const splitBody = await split.json()
      ctx.ledger.trackCase(splitBody.destinationCaseId)

      const undo = await request.post(UNDO_URL, {
        headers: ctx.authHeaders,
        data: { undoToken: splitBody.undoToken },
      })
      expect(undo.status()).toBe(200)
      expect(await undo.json()).toMatchObject({ ok: true })

      // The conversation is back on the source with one open interval.
      expect(await readConversationCaseId(ctx.em, moving.id)).toBe(source.id)
      expect(await countActiveBindings(ctx.em, moving.id)).toBe(1)

      // The child had no activity of its own, so it is retired rather than left
      // as an empty Case in the Inbox.
      const child = await readCase(ctx.em, splitBody.destinationCaseId)
      expect(child!.deleted_at).not.toBeNull()

      // History is append-only: the original is marked reversed and an inverse
      // row is added; neither is deleted.
      const audit = await readReparentings(ctx.em, ctx.scope, source.id)
      expect(audit).toHaveLength(2)
      const original = audit.find((row) => row.id === splitBody.reparentingId)!
      const inverse = audit.find((row) => row.reverses_reparenting_id === splitBody.reparentingId)!
      expect(original.status).toBe('reversed')
      expect(inverse).toMatchObject({ operation: 'undo_split', status: 'completed' })
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('reverses a merge and restores the source lifecycle', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const source = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
        status: 'waiting_customer',
      })
      const target = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
      })
      ctx.ledger.trackCase(source.id)
      ctx.ledger.trackCase(target.id)
      const moving = await seedConversation(ctx.em, ctx.scope, { channelId: ctx.channelId, caseId: source.id })
      ctx.ledger.trackConversation(moving.id)

      const merge = await request.post(mergeUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          targetCaseId: target.id,
          expectedSourceUpdatedAt: source.updatedAt,
          expectedTargetUpdatedAt: target.updatedAt,
          clientCommandKey: commandKey('rep-003-merge'),
          reason: 'Merge that will be undone',
        },
      })
      expect(merge.status()).toBe(201)
      const mergeBody = await merge.json()

      const undo = await request.post(UNDO_URL, {
        headers: ctx.authHeaders,
        data: { undoToken: mergeBody.undoToken },
      })
      expect(undo.status()).toBe(200)

      // The source is live again, with the exact status it held before, and no
      // longer claims to have been merged anywhere.
      const sourceAfter = await readCase(ctx.em, source.id)
      expect(sourceAfter).toMatchObject({
        status: 'waiting_customer',
        merged_into_case_id: null,
        closed_at: null,
      })
      expect(await readConversationCaseId(ctx.em, moving.id)).toBe(source.id)
      expect(await countActiveBindings(ctx.em, moving.id)).toBe(1)

      // The target survives the reversal untouched apart from its lineage
      // version — an undo must not retire a Case that was never retired.
      const targetAfter = await readCase(ctx.em, target.id)
      expect(targetAfter!.deleted_at).toBeNull()
      expect(targetAfter!.merged_into_case_id).toBeNull()

      const audit = await readReparentings(ctx.em, ctx.scope, source.id)
      const inverse = audit.find((row) => row.reverses_reparenting_id === mergeBody.reparentingId)!
      expect(inverse).toMatchObject({ operation: 'undo_merge', status: 'completed' })
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('refuses to reverse the same operation twice', async ({ request }) => {
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
          clientCommandKey: commandKey('rep-003-twice'),
          reason: 'Split undone twice',
        },
      })
      const splitBody = await split.json()
      ctx.ledger.trackCase(splitBody.destinationCaseId)

      expect((await request.post(UNDO_URL, { headers: ctx.authHeaders, data: { undoToken: splitBody.undoToken } })).status()).toBe(200)

      // A second undo must not move the conversation again. The token is spent,
      // and the audit row is already `reversed`.
      const second = await request.post(UNDO_URL, {
        headers: ctx.authHeaders,
        data: { undoToken: splitBody.undoToken },
      })
      expect(second.status()).not.toBe(200)
      expect(await readConversationCaseId(ctx.em, moving.id)).toBe(source.id)
      expect(await countActiveBindings(ctx.em, moving.id)).toBe(1)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })
})

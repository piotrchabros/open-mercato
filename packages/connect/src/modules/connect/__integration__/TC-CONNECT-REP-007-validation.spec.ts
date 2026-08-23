import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { readCase, seedCase, seedConversation } from './helpers/reparentingFixtures'
import { commandKey, mergeUrl, openReparentingSpec, splitUrl } from './helpers/reparentingSpec'

/**
 * REP-INT-007 — the guarded action-route contract.
 *
 * Both endpoints run the mutation-guard registry with operation `update` before
 * touching the command, re-parse their body with zod, and enforce optimistic
 * tokens. This spec pins the observable half of that contract: every rejected
 * shape is refused with its documented status and leaves the aggregate at
 * lineage version 0 — no partial write, no audit row, no event.
 */
test.describe('TC-CONNECT-REP-007: request validation and optimistic locking', () => {
  test('refuses a stale optimistic token without mutating anything', async ({ request }) => {
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
          // A token from before the Case was last written.
          expectedUpdatedAt: new Date(Date.now() - 86_400_000).toISOString(),
          clientCommandKey: commandKey('rep-007-stale'),
          reason: 'Split with a stale token',
        },
      })
      expect(response.status()).toBe(409)
      expect(await response.json()).toMatchObject({
        error: 'record_conflict',
        code: 'optimistic_lock_conflict',
        caseId: source.id,
      })
      expect((await readCase(ctx.em, source.id))!.lineage_version).toBe(0)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('refuses a selection that would empty the source', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const source = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
      })
      ctx.ledger.trackCase(source.id)
      const only = await seedConversation(ctx.em, ctx.scope, { channelId: ctx.channelId, caseId: source.id })
      ctx.ledger.trackConversation(only.id)

      // Moving every conversation is a merge wearing a different name, and it
      // would skip the merge path's target checks entirely.
      const response = await request.post(splitUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          conversationIds: [only.id],
          expectedUpdatedAt: source.updatedAt,
          clientCommandKey: commandKey('rep-007-empty'),
          reason: 'Split everything out',
        },
      })
      expect(response.status()).toBe(422)
      expect(await response.json()).toMatchObject({
        code: 'invalid_selection',
        reason: 'source_would_be_empty',
      })
      expect((await readCase(ctx.em, source.id))!.lineage_version).toBe(0)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('reports a conversation from another case as not found', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const source = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
      })
      const other = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
      })
      ctx.ledger.trackCase(source.id)
      ctx.ledger.trackCase(other.id)
      const mine = await seedConversation(ctx.em, ctx.scope, { channelId: ctx.channelId, caseId: source.id })
      const theirs = await seedConversation(ctx.em, ctx.scope, { channelId: ctx.channelId, caseId: other.id })
      ctx.ledger.trackConversation(mine.id)
      ctx.ledger.trackConversation(theirs.id)

      const response = await request.post(splitUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          conversationIds: [theirs.id],
          expectedUpdatedAt: source.updatedAt,
          clientCommandKey: commandKey('rep-007-foreign'),
          reason: 'Split a conversation this case does not own',
        },
      })
      // A conversation on another Case is reported exactly like one that does
      // not exist, so the endpoint cannot be used to probe for them.
      expect(response.status()).toBe(404)
      expect((await readCase(ctx.em, other.id))!.lineage_version).toBe(0)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('rejects malformed bodies with 422', async ({ request }) => {
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

      const base = {
        conversationIds: [moving.id],
        expectedUpdatedAt: source.updatedAt,
        clientCommandKey: commandKey('rep-007-body'),
        reason: 'Valid reason',
      }

      const malformed: Array<Record<string, unknown>> = [
        // A reason of spaces is not an audit reason.
        { ...base, reason: '   ' },
        { ...base, conversationIds: [] },
        { ...base, conversationIds: [moving.id, moving.id] },
        // The key lands in a unique index and in log context.
        { ...base, clientCommandKey: 'key with spaces' },
        { ...base, expectedUpdatedAt: 'yesterday' },
      ]

      for (const data of malformed) {
        const response = await request.post(splitUrl(source.id), { headers: ctx.authHeaders, data })
        expect(response.status()).toBe(422)
      }
      expect((await readCase(ctx.em, source.id))!.lineage_version).toBe(0)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('rejects an invalid case id in the path with 400', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    const response = await request.post(splitUrl('not-a-uuid'), {
      headers: ctx.authHeaders,
      data: {
        conversationIds: [randomUUID()],
        expectedUpdatedAt: new Date().toISOString(),
        clientCommandKey: commandKey('rep-007-path'),
        reason: 'Invalid path id',
      },
    })
    expect(response.status()).toBe(400)
  })

  test('refuses merging a case into itself', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const source = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
      })
      ctx.ledger.trackCase(source.id)

      const response = await request.post(mergeUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          targetCaseId: source.id,
          expectedSourceUpdatedAt: source.updatedAt,
          expectedTargetUpdatedAt: source.updatedAt,
          clientCommandKey: commandKey('rep-007-self'),
          reason: 'Merging a case into itself',
        },
      })
      expect(response.status()).toBe(422)
      expect(await response.json()).toMatchObject({ code: 'invalid_selection', reason: 'same_case' })
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })
})

import { expect, test } from '@playwright/test'
import {
  countActiveBindings,
  readBindings,
  readCase,
  readConversationCaseId,
  readOutboxEventTypes,
  readReparentings,
  seedCase,
  seedConversation,
} from './helpers/reparentingFixtures'
import { commandKey, mergeUrl, openReparentingSpec } from './helpers/reparentingSpec'

/**
 * REP-INT-002 — a successful merge.
 *
 * The property that matters most: the source is PRESERVED. Zammad-style merge
 * semantics keep the retired ticket readable so old links resolve and the audit
 * trail survives; deleting it would destroy the evidence of what was done for
 * the customer. Here that means `status='closed'` plus `merged_into_case_id`,
 * never a missing row.
 */
test.describe('TC-CONNECT-REP-002: merge two cases', () => {
  test('moves every conversation to the target and keeps the source as history', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const source = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
        firstInboundAt: new Date(Date.now() - 7_200_000),
        lastInboundAt: new Date(Date.now() - 300_000),
      })
      const target = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
        firstInboundAt: new Date(Date.now() - 3_600_000),
        lastInboundAt: new Date(Date.now() - 1_800_000),
      })
      ctx.ledger.trackCase(source.id)
      ctx.ledger.trackCase(target.id)

      const sourceConversation = await seedConversation(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        caseId: source.id,
      })
      const targetConversation = await seedConversation(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        caseId: target.id,
      })
      ctx.ledger.trackConversation(sourceConversation.id)
      ctx.ledger.trackConversation(targetConversation.id)

      const response = await request.post(mergeUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          targetCaseId: target.id,
          expectedSourceUpdatedAt: source.updatedAt,
          expectedTargetUpdatedAt: target.updatedAt,
          clientCommandKey: commandKey('rep-002'),
          reason: 'Duplicate case for the same customer',
        },
      })
      expect(response.status()).toBe(201)
      const body = await response.json()
      expect(body).toMatchObject({
        status: 'reparented',
        operation: 'merge',
        sourceCaseId: source.id,
        destinationCaseId: target.id,
        movedConversationCount: 1,
      })
      expect(body.undoToken).toBeTruthy()

      // The source survives as closed history that names where its work went.
      const sourceAfter = await readCase(ctx.em, source.id)
      expect(sourceAfter).not.toBeNull()
      expect(sourceAfter).toMatchObject({
        status: 'closed',
        merged_into_case_id: target.id,
        deleted_at: null,
      })
      expect(sourceAfter!.closed_at).not.toBeNull()
      expect(sourceAfter!.lineage_version).toBe(1)

      // The target keeps its own lifecycle; only the inbound range folds so its
      // triage position reflects the traffic it is now responsible for.
      const targetAfter = await readCase(ctx.em, target.id)
      expect(targetAfter).toMatchObject({ status: 'in_progress', merged_into_case_id: null })
      expect(targetAfter!.lineage_version).toBe(1)
      expect(new Date(targetAfter!.first_inbound_at!).getTime()).toBe(
        new Date(sourceAfter!.first_inbound_at!).getTime(),
      )
      expect(new Date(targetAfter!.last_inbound_at!).getTime()).toBeGreaterThan(
        new Date(target.updatedAt).getTime() - 1_900_000,
      )

      expect(await readConversationCaseId(ctx.em, sourceConversation.id)).toBe(target.id)
      expect(await readConversationCaseId(ctx.em, targetConversation.id)).toBe(target.id)

      const movedBindings = await readBindings(ctx.em, sourceConversation.id)
      expect(movedBindings).toHaveLength(2)
      expect(movedBindings[0].unbound_at).not.toBeNull()
      expect(movedBindings[1]).toMatchObject({ case_id: target.id, unbound_at: null, reason: 'merge' })
      expect(await countActiveBindings(ctx.em, sourceConversation.id)).toBe(1)
      // The target's own conversation is untouched by the merge.
      expect(await readBindings(ctx.em, targetConversation.id)).toHaveLength(1)

      const audit = await readReparentings(ctx.em, ctx.scope, source.id)
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({
        operation: 'merge',
        source_case_id: source.id,
        destination_case_id: target.id,
        status: 'completed',
      })

      const events = await readOutboxEventTypes(ctx.em, ctx.scope, [body.reparentingId])
      expect(events[0].event_type).toBe('connect.case.merged')
      expect(events[0].payload).toMatchObject({
        operation: 'merge',
        lineageInstruction: 'source_into_target',
        sourceCaseId: source.id,
        destinationCaseId: target.id,
        movedConversationCount: 1,
      })
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })
})

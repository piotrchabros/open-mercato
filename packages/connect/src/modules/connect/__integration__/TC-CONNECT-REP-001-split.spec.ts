import { expect, test } from '@playwright/test'
import {
  countActiveBindings,
  countTransitions,
  readBindings,
  readCase,
  readConversationCaseId,
  readOutboxEventTypes,
  readReparentings,
  seedCase,
  seedConversation,
} from './helpers/reparentingFixtures'
import { commandKey, openReparentingSpec, splitUrl } from './helpers/reparentingSpec'

/**
 * REP-INT-001 — a successful split.
 *
 * Asserts the whole aggregate agrees afterwards: the child exists with the
 * inherited snapshot, each moved conversation has exactly one closed interval
 * and one open one, the source keeps what stayed, and the audit row and outbox
 * event describe the same operation.
 */
test.describe('TC-CONNECT-REP-001: split a case', () => {
  test('moves the selected conversations into a new child case', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const source = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
        slaGeneration: 3,
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

      const response = await request.post(splitUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          conversationIds: [moving.id],
          expectedUpdatedAt: source.updatedAt,
          clientCommandKey: commandKey('rep-001'),
          reason: 'Unrelated conversations were grouped together',
        },
      })
      expect(response.status()).toBe(201)
      const body = await response.json()
      expect(body).toMatchObject({
        status: 'reparented',
        operation: 'split',
        sourceCaseId: source.id,
        movedConversationIds: [moving.id],
        idempotentReplay: false,
      })
      expect(body.undoToken).toBeTruthy()
      ctx.ledger.trackCase(body.destinationCaseId)

      // The child inherits lineage, customer and timing from the source, and
      // its channel comes from the conversation it actually holds.
      const child = await readCase(ctx.em, body.destinationCaseId)
      expect(child).toMatchObject({
        split_from_case_id: source.id,
        merged_into_case_id: null,
        status: 'in_progress',
        customer_id: ctx.customerId,
        channel_id: ctx.channelId,
        sla_generation: 3,
      })
      expect(child!.lineage_version).toBe(1)
      expect(child!.number).not.toBe(source.number)

      // The source is untouched apart from its lineage version: a split
      // corrects grouping, it does not restart the source's work.
      const sourceAfter = await readCase(ctx.em, source.id)
      expect(sourceAfter).toMatchObject({ status: 'in_progress', merged_into_case_id: null })
      expect(sourceAfter!.lineage_version).toBe(1)

      expect(await readConversationCaseId(ctx.em, moving.id)).toBe(body.destinationCaseId)
      expect(await readConversationCaseId(ctx.em, staying.id)).toBe(source.id)

      // Exactly one closed interval and one open one for the moved
      // conversation; the one that stayed is untouched.
      const movedBindings = await readBindings(ctx.em, moving.id)
      expect(movedBindings).toHaveLength(2)
      expect(movedBindings[0]).toMatchObject({ case_id: source.id })
      expect(movedBindings[0].unbound_at).not.toBeNull()
      expect(movedBindings[1]).toMatchObject({
        case_id: body.destinationCaseId,
        unbound_at: null,
        reason: 'split',
      })
      expect(await countActiveBindings(ctx.em, moving.id)).toBe(1)
      expect(await readBindings(ctx.em, staying.id)).toHaveLength(1)

      // The child records its own creation, including that its inbound range is
      // inherited rather than measured.
      expect(await countTransitions(ctx.em, body.destinationCaseId)).toBe(1)

      const audit = await readReparentings(ctx.em, ctx.scope, source.id)
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({
        operation: 'split',
        source_case_id: source.id,
        destination_case_id: body.destinationCaseId,
        status: 'completed',
      })
      expect(audit[0].id).toBe(body.reparentingId)

      const events = await readOutboxEventTypes(ctx.em, ctx.scope, [body.reparentingId])
      expect(events).toHaveLength(1)
      expect(events[0].event_type).toBe('connect.case.split')
      expect(events[0].payload).toMatchObject({
        operation: 'split',
        lineageInstruction: 'child_of_source',
        lineageVersion: 1,
        sourceCaseId: source.id,
        destinationCaseId: body.destinationCaseId,
        movedConversationCount: 1,
        sourceSlaGeneration: 3,
        destinationSlaGeneration: 3,
      })
      // Identifier-only: nothing the customer wrote may reach the event store.
      const serialized = JSON.stringify(events[0].payload)
      for (const forbidden of ['subject', 'wrapUp', 'displayLabel', 'reason', 'handle']) {
        expect(serialized).not.toContain(forbidden)
      }
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })
})

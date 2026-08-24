import { expect, test } from '@playwright/test'
import { readCase, seedCase, seedConversation } from '../../connect/__integration__/helpers/reparentingFixtures'
import { commandKey, openReparentingSpec, splitUrl } from '../../connect/__integration__/helpers/reparentingSpec'

test.describe('TC-CONNECT-SLA-103: reparent generation lineage', () => {
  test('copies the source generation to a split child and its lineage event', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const source = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
        slaGeneration: 7,
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
          clientCommandKey: commandKey('sla-generation-split'),
          reason: 'Verify SLA generation propagation',
        },
      })
      expect(response.status()).toBe(201)
      const body = await response.json()
      ctx.ledger.trackCase(body.destinationCaseId)
      expect((await readCase(ctx.em, body.destinationCaseId))?.sla_generation).toBe(7)

      const events = await ctx.em.getConnection().execute<Array<{ payload: Record<string, unknown> }>>(
        `select payload from connect_domain_outbox
          where tenant_id = ? and organization_id = ? and source_event_id = ?`,
        [ctx.scope.tenantId, ctx.scope.organizationId, body.reparentingId],
      )
      expect(events[0]?.payload).toMatchObject({
        sourceSlaGeneration: 7,
        destinationSlaGeneration: 7,
      })
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })
})

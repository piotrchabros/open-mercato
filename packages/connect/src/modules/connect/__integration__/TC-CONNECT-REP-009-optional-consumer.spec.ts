import { expect, test } from '@playwright/test'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { readCase, readOutboxEventTypes, seedCase, seedConversation } from './helpers/reparentingFixtures'
import { commandKey, openReparentingSpec, splitUrl } from './helpers/reparentingSpec'

/**
 * REP-INT-009 — Connect works with no lineage consumer installed.
 *
 * `connect_sla` is not installed in this app, and that is the point: a core Case
 * correction must not depend on an optional module. Connect publishes lineage
 * facts outward and answers a scoped read facade; it never resolves a consumer,
 * so the consumer's absence changes no reparenting outcome.
 *
 * The facade is also exercised the way a consumer would reach it — through DI,
 * with a mandatory scope — because that is the contract third-party code sees.
 */
test.describe('TC-CONNECT-REP-009: optional consumers are absent and nothing breaks', () => {
  test('splits successfully with no clock consumer resolvable', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const container = await createRequestContainer()
      const hasRegistration = (container as { hasRegistration?: (name: string) => boolean }).hasRegistration

      // No consumer is registered — Connect has no hard dependency to satisfy.
      expect(typeof hasRegistration).toBe('function')
      expect(hasRegistration!('connectSlaClockService')).toBe(false)

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
          clientCommandKey: commandKey('rep-009'),
          reason: 'Split with no consumer installed',
        },
      })
      expect(response.status()).toBe(201)
      const body = await response.json()
      ctx.ledger.trackCase(body.destinationCaseId)

      // The lineage fact is staged regardless: a consumer installed later
      // reconciles from the outbox and the facade, not from Connect calling it.
      const events = await readOutboxEventTypes(ctx.em, ctx.scope, [body.reparentingId])
      expect(events).toHaveLength(1)
      expect(events[0].payload).toMatchObject({ lineageInstruction: 'child_of_source' })

      expect((await readCase(ctx.em, body.destinationCaseId))!.split_from_case_id).toBe(source.id)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('exposes the lineage facade a consumer would reconcile through', async ({ request }) => {
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
          clientCommandKey: commandKey('rep-009-facade'),
          reason: 'Split read back through the facade',
        },
      })
      const body = await response.json()
      ctx.ledger.trackCase(body.destinationCaseId)

      const container = await createRequestContainer()
      type LineageReader = {
        getById(scope: { tenantId: string; organizationId: string }, id: string): Promise<Record<string, unknown> | null>
        getCaseLineage(
          scope: { tenantId: string; organizationId: string },
          caseId: string,
        ): Promise<Record<string, unknown> | null>
      }
      const reader = container.resolve('connectCaseReparentingReader') as LineageReader

      const projection = await reader.getById(ctx.scope, body.reparentingId)
      expect(projection).toMatchObject({
        operation: 'split',
        sourceCaseId: source.id,
        destinationCaseId: body.destinationCaseId,
        lineageInstruction: 'child_of_source',
        movedConversationCount: 1,
        sourceEventId: body.reparentingId,
      })

      // Identifiers, enums and timestamps only — never what the customer wrote.
      const serialized = JSON.stringify(projection)
      for (const forbidden of ['subject', 'wrapUp', 'displayLabel', 'reason', 'handle']) {
        expect(serialized).not.toContain(forbidden)
      }

      const lineage = await reader.getCaseLineage(ctx.scope, body.destinationCaseId)
      expect(lineage).toMatchObject({
        caseId: body.destinationCaseId,
        splitFromCaseId: source.id,
        mergedIntoCaseId: null,
      })

      // The scope is mandatory and is a predicate, not a label: a sibling
      // organization sees nothing at all.
      const otherScope = { tenantId: ctx.scope.tenantId, organizationId: body.reparentingId }
      expect(await reader.getById(otherScope, body.reparentingId)).toBeNull()
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('answers the canonical-root denominator without counting split children', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const container = await createRequestContainer()
      type DenominatorReader = {
        countCanonicalRoots(input: {
          tenantId: string
          organizationId: string
          from: string
          to: string
        }): Promise<{ contractVersion: string; count: number }>
      }
      const reader = container.resolve('connectContactDenominatorReader') as DenominatorReader
      const from = new Date(Date.now() - 3_600_000).toISOString()
      const to = new Date(Date.now() + 3_600_000).toISOString()

      const before = await reader.countCanonicalRoots({ ...ctx.scope, from, to })

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

      const afterSeed = await reader.countCanonicalRoots({ ...ctx.scope, from, to })
      expect(afterSeed.count).toBe(before.count + 1)

      const response = await request.post(splitUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          conversationIds: [moving.id],
          expectedUpdatedAt: source.updatedAt,
          clientCommandKey: commandKey('rep-009-denominator'),
          reason: 'Split must not inflate the contact denominator',
        },
      })
      expect(response.status()).toBe(201)
      ctx.ledger.trackCase((await response.json()).destinationCaseId)

      // The decisive assertion: correcting a mis-grouped Case must not make
      // cost-per-contact fall. One customer got in touch, before and after.
      const afterSplit = await reader.countCanonicalRoots({ ...ctx.scope, from, to })
      expect(afterSplit.count).toBe(afterSeed.count)
      expect(afterSplit.contractVersion).toBe('connect.contact_root_created.v1')
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })
})

import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readCase, seedCase, seedConversation } from './helpers/reparentingFixtures'
import { commandKey, mergeUrl, openReparentingSpec, splitUrl } from './helpers/reparentingSpec'

/**
 * REP-INT-006 — the feature gates.
 *
 * Two distinct grants, deliberately not bundled. `connect.cases.reparent` lets
 * a supervisor correct grouping; `connect.cases.reparent.override` waives the
 * same-customer safeguard. Bundling them would make the safeguard advisory,
 * which is exactly how one customer's thread reaches another's agent.
 */
test.describe('TC-CONNECT-REP-006: reparenting features are enforced', () => {
  test('denies a front-line agent who lacks the reparent feature', async ({ request }) => {
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

      // `employee` holds connect.inbox.handle but deliberately not reparent.
      const employeeToken = await getAuthToken(request, 'employee')
      const response = await request.post(splitUrl(source.id), {
        headers: { Authorization: `Bearer ${employeeToken}`, 'Content-Type': 'application/json' },
        data: {
          conversationIds: [moving.id],
          expectedUpdatedAt: source.updatedAt,
          clientCommandKey: commandKey('rep-006-denied'),
          reason: 'Attempt without the reparent feature',
        },
      })
      expect([401, 403]).toContain(response.status())

      const sourceAfter = await readCase(ctx.em, source.id)
      expect(sourceAfter!.lineage_version).toBe(0)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('refuses a customer mismatch by default and points at the override', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const source = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
      })
      const target = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        // A different customer entirely.
        customerId: randomUUID(),
      })
      ctx.ledger.trackCase(source.id)
      ctx.ledger.trackCase(target.id)
      const conversation = await seedConversation(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        caseId: source.id,
      })
      ctx.ledger.trackConversation(conversation.id)

      const withoutFlag = await request.post(mergeUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          targetCaseId: target.id,
          expectedSourceUpdatedAt: source.updatedAt,
          expectedTargetUpdatedAt: target.updatedAt,
          clientCommandKey: commandKey('rep-006-mismatch'),
          reason: 'Merging two different customers',
        },
      })
      expect(withoutFlag.status()).toBe(422)
      expect(await withoutFlag.json()).toMatchObject({
        code: 'customer_mismatch',
        reason: 'different_customer',
      })
      expect((await readCase(ctx.em, source.id))!.merged_into_case_id).toBeNull()
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('allows the override for an admin who holds the override feature', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const source = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
      })
      const target = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: randomUUID(),
      })
      ctx.ledger.trackCase(source.id)
      ctx.ledger.trackCase(target.id)
      const conversation = await seedConversation(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        caseId: source.id,
      })
      ctx.ledger.trackConversation(conversation.id)

      // The default `admin` role carries `connect.*`, which the wildcard-aware
      // policy resolves to include the override.
      const response = await request.post(mergeUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          targetCaseId: target.id,
          expectedSourceUpdatedAt: source.updatedAt,
          expectedTargetUpdatedAt: target.updatedAt,
          clientCommandKey: commandKey('rep-006-override'),
          reason: 'Deliberate supervised override with an audited reason',
          allowCustomerMismatch: true,
        },
      })
      expect(response.status()).toBe(201)
      expect((await readCase(ctx.em, source.id))!.merged_into_case_id).toBe(target.id)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('keeps the audit trail behind its own feature', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    const employeeToken = await getAuthToken(request, 'employee')
    const response = await request.get('/api/connect/case-reparentings', {
      headers: { Authorization: `Bearer ${employeeToken}` },
    })
    // Reading why a supervisor corrected something names the customer and the
    // mistake, so it is not part of the front-line grant.
    expect([401, 403]).toContain(response.status())
  })
})

import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { readCase, seedCase, seedConversation } from './helpers/reparentingFixtures'
import { commandKey, lineageUrl, mergeUrl, openReparentingSpec, splitUrl } from './helpers/reparentingSpec'

/**
 * REP-INT-005 — cross-scope references are 404, never 403.
 *
 * A merge is the most dangerous operation in Connect: supply a target id from a
 * sibling organization and you would gain its conversations. Every reference is
 * therefore scoped, and — just as important — an out-of-scope id must be
 * indistinguishable from one that does not exist. A 403 would confirm the Case
 * is real, which is itself information about another organization's traffic.
 */
test.describe('TC-CONNECT-REP-005: cross-scope references are indistinguishable from missing', () => {
  test('refuses a merge whose target belongs to a sibling organization', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    const siblingOrganizationId = randomUUID()
    try {
      const source = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
      })
      ctx.ledger.trackCase(source.id)
      const sourceConversation = await seedConversation(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        caseId: source.id,
      })
      ctx.ledger.trackConversation(sourceConversation.id)

      // A real Case, in the same tenant, in another organization.
      const foreign = await seedCase(
        ctx.em,
        { tenantId: ctx.scope.tenantId, organizationId: siblingOrganizationId },
        { channelId: ctx.channelId, customerKind: 'person', customerId: ctx.customerId },
      )
      ctx.ledger.trackCase(foreign.id)

      const response = await request.post(mergeUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          targetCaseId: foreign.id,
          expectedSourceUpdatedAt: source.updatedAt,
          expectedTargetUpdatedAt: foreign.updatedAt,
          clientCommandKey: commandKey('rep-005-merge'),
          reason: 'Attempted cross-organization merge',
        },
      })
      expect(response.status()).toBe(404)

      // Nothing moved, and the foreign Case is untouched.
      const foreignAfter = await readCase(ctx.em, foreign.id)
      expect(foreignAfter).toMatchObject({ merged_into_case_id: null, lineage_version: 0 })
      const sourceAfter = await readCase(ctx.em, source.id)
      expect(sourceAfter).toMatchObject({ merged_into_case_id: null, lineage_version: 0 })
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('reports a sibling-organization source as 404 on every reparenting route', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    const siblingOrganizationId = randomUUID()
    try {
      const foreign = await seedCase(
        ctx.em,
        { tenantId: ctx.scope.tenantId, organizationId: siblingOrganizationId },
        { channelId: ctx.channelId, customerKind: 'person', customerId: ctx.customerId },
      )
      ctx.ledger.trackCase(foreign.id)
      const foreignConversation = await seedConversation(
        ctx.em,
        { tenantId: ctx.scope.tenantId, organizationId: siblingOrganizationId },
        { channelId: ctx.channelId, caseId: foreign.id },
      )
      ctx.ledger.trackConversation(foreignConversation.id)

      const split = await request.post(splitUrl(foreign.id), {
        headers: ctx.authHeaders,
        data: {
          conversationIds: [foreignConversation.id],
          expectedUpdatedAt: foreign.updatedAt,
          clientCommandKey: commandKey('rep-005-split'),
          reason: 'Attempted cross-organization split',
        },
      })
      expect(split.status()).toBe(404)

      const lineage = await request.get(lineageUrl(foreign.id), { headers: ctx.authHeaders })
      expect(lineage.status()).toBe(404)

      const audit = await request.get(`/api/connect/case-reparentings?caseId=${foreign.id}`, {
        headers: ctx.authHeaders,
      })
      // The audit list is scoped rather than 404: it simply has nothing to show
      // for a Case in another organization.
      expect(audit.status()).toBe(200)
      expect((await audit.json()).items).toEqual([])
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('reports an unknown id and an out-of-scope id identically', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    const siblingOrganizationId = randomUUID()
    try {
      const foreign = await seedCase(
        ctx.em,
        { tenantId: ctx.scope.tenantId, organizationId: siblingOrganizationId },
        { channelId: ctx.channelId },
      )
      ctx.ledger.trackCase(foreign.id)
      const unknownId = randomUUID()

      const forForeign = await request.get(lineageUrl(foreign.id), { headers: ctx.authHeaders })
      const forUnknown = await request.get(lineageUrl(unknownId), { headers: ctx.authHeaders })

      expect(forForeign.status()).toBe(forUnknown.status())
      expect(await forForeign.json()).toEqual(await forUnknown.json())
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })
})

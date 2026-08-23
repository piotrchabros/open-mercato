import { expect, test } from '@playwright/test'
import { readCase, seedCase, seedConversation } from './helpers/reparentingFixtures'
import { commandKey, lineageUrl, mergeUrl, openReparentingSpec, splitUrl } from './helpers/reparentingSpec'

/**
 * REP-INT-012 — a merged source is read-only history everywhere.
 *
 * Lineage columns alone are not the feature. If the Inbox still offered a merged
 * source for triage, an agent would open a Case they cannot reply in; if
 * customer context still counted it, every merge would inflate a customer's open
 * total. Each surface in the spec's impact table is asserted here against a real
 * merged Case.
 */
test.describe('TC-CONNECT-REP-012: downstream readers respect lineage', () => {
  test('excludes a merged source from triage but keeps it readable', async ({ request }) => {
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
        customerId: ctx.customerId,
      })
      ctx.ledger.trackCase(source.id)
      ctx.ledger.trackCase(target.id)
      const conversation = await seedConversation(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        caseId: source.id,
      })
      ctx.ledger.trackConversation(conversation.id)

      const merge = await request.post(mergeUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          targetCaseId: target.id,
          expectedSourceUpdatedAt: source.updatedAt,
          expectedTargetUpdatedAt: target.updatedAt,
          clientCommandKey: commandKey('rep-012-merge'),
          reason: 'Merge for downstream reader checks',
        },
      })
      expect(merge.status()).toBe(201)

      // Inbox: gone from the active list, present in closed history.
      const triage = await request.get('/api/connect/inbox?filter=all&pageSize=100', {
        headers: ctx.authHeaders,
      })
      const triageIds = (await triage.json()).items.map((row: { id: string }) => row.id)
      expect(triageIds).not.toContain(source.id)
      expect(triageIds).toContain(target.id)

      const history = await request.get('/api/connect/inbox?filter=all&includeClosed=true&pageSize=100', {
        headers: ctx.authHeaders,
      })
      const historyItems = (await history.json()).items as Array<{ id: string; mergedIntoCaseId: string | null }>
      const historical = historyItems.find((row) => row.id === source.id)
      expect(historical).toBeTruthy()
      expect(historical!.mergedIntoCaseId).toBe(target.id)

      // Case detail: still readable, and it says where its work went, so an old
      // link resolves instead of dead-ending.
      const detail = await request.get(`/api/connect/cases?id=${source.id}`, { headers: ctx.authHeaders })
      expect(detail.status()).toBe(200)
      expect((await detail.json()).items[0]).toMatchObject({
        id: source.id,
        status: 'closed',
        mergedIntoCaseId: target.id,
      })
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('rejects every mutation on a merged source with its canonical target', async ({ request }) => {
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
        customerId: ctx.customerId,
      })
      ctx.ledger.trackCase(source.id)
      ctx.ledger.trackCase(target.id)
      const conversation = await seedConversation(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        caseId: source.id,
      })
      ctx.ledger.trackConversation(conversation.id)

      await request.post(mergeUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          targetCaseId: target.id,
          expectedSourceUpdatedAt: source.updatedAt,
          expectedTargetUpdatedAt: target.updatedAt,
          clientCommandKey: commandKey('rep-012-readonly'),
          reason: 'Merge before mutation attempts',
        },
      })
      const merged = await readCase(ctx.em, source.id)

      const attempts: Array<{ label: string; response: Awaited<ReturnType<typeof request.post>> }> = [
        {
          label: 'resolve',
          response: await request.post(`/api/connect/cases/${source.id}/resolve`, {
            headers: ctx.authHeaders,
            data: { wrapUp: 'Attempted wrap-up' },
          }),
        },
        {
          label: 'reopen',
          response: await request.post(`/api/connect/cases/${source.id}/reopen`, {
            headers: ctx.authHeaders,
            data: {},
          }),
        },
        {
          label: 'assign',
          response: await request.post(`/api/connect/cases/${source.id}/assign`, {
            headers: ctx.authHeaders,
            data: { assigneeUserId: null },
          }),
        },
        {
          label: 'thread',
          response: await request.get(`/api/connect/cases/${source.id}/thread`, {
            headers: ctx.authHeaders,
          }) as never,
        },
      ]

      for (const attempt of attempts) {
        expect(attempt.response.status(), `${attempt.label} must refuse a merged source`).toBe(409)
        expect(await attempt.response.json()).toMatchObject({
          code: 'case_merged',
          canonicalCaseId: target.id,
        })
      }

      // Priority is the one generically mutable field, and it is refused too.
      const priority = await request.put('/api/connect/cases', {
        headers: ctx.authHeaders,
        data: { id: source.id, priority: 'high' },
      })
      expect(priority.status()).toBe(409)
      expect(await priority.json()).toMatchObject({ code: 'case_merged', canonicalCaseId: target.id })

      // Nothing actually changed on the historical Case.
      const after = await readCase(ctx.em, source.id)
      expect(after!.status).toBe('closed')
      expect(after!.updated_at).toBe(merged!.updated_at)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('stops counting a merged source in customer context', async ({ request }) => {
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
        customerId: ctx.customerId,
      })
      ctx.ledger.trackCase(source.id)
      ctx.ledger.trackCase(target.id)
      const conversation = await seedConversation(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        caseId: source.id,
      })
      ctx.ledger.trackConversation(conversation.id)

      const before = await request.post('/api/connect/customer-context/query', {
        headers: ctx.authHeaders,
        data: { refs: [{ kind: 'person', id: ctx.customerId }] },
      })
      expect(before.status()).toBe(200)
      const beforeCount = (await before.json()).items?.[0]?.openCaseCount ?? 0
      expect(beforeCount).toBe(2)

      await request.post(mergeUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          targetCaseId: target.id,
          expectedSourceUpdatedAt: source.updatedAt,
          expectedTargetUpdatedAt: target.updatedAt,
          clientCommandKey: commandKey('rep-012-context'),
          reason: 'Merge two duplicates for one customer',
        },
      })

      // Consolidating duplicates must reduce the customer's open total to one,
      // not leave a Case nobody can work inflating it.
      const after = await request.post('/api/connect/customer-context/query', {
        headers: ctx.authHeaders,
        data: { refs: [{ kind: 'person', id: ctx.customerId }] },
      })
      expect((await after.json()).items?.[0]?.openCaseCount).toBe(1)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('reports lineage for both sides of a split', async ({ request }) => {
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
          clientCommandKey: commandKey('rep-012-lineage'),
          reason: 'Split for the lineage read',
        },
      })
      const body = await split.json()
      ctx.ledger.trackCase(body.destinationCaseId)

      const childLineage = await request.get(lineageUrl(body.destinationCaseId), { headers: ctx.authHeaders })
      expect(childLineage.status()).toBe(200)
      expect(await childLineage.json()).toMatchObject({
        caseId: body.destinationCaseId,
        splitFromCaseId: source.id,
        mergedIntoCaseId: null,
        lineageVersion: 1,
      })

      const sourceLineage = await request.get(lineageUrl(source.id), { headers: ctx.authHeaders })
      const sourceBody = await sourceLineage.json()
      expect(sourceBody).toMatchObject({ caseId: source.id, splitFromCaseId: null })
      expect(sourceBody.operations).toHaveLength(1)
      expect(sourceBody.operations[0]).toMatchObject({
        id: body.reparentingId,
        operation: 'split',
        sourceCaseId: source.id,
        destinationCaseId: body.destinationCaseId,
      })
      // Lineage is a navigation aid, not the audit trail — no reason here.
      expect(JSON.stringify(sourceBody)).not.toContain('Split for the lineage read')
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })
})

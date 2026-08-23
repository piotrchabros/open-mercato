import { expect, test } from '@playwright/test'
import { seedCase, seedConversation } from './helpers/reparentingFixtures'
import { commandKey, openReparentingSpec, splitUrl } from './helpers/reparentingSpec'

/**
 * REP-INT-010 — keyset pagination over the audit trail.
 *
 * Offset pagination would skip or repeat rows while corrections continue to be
 * made underneath a reader, which for an audit surface is worse than useless.
 * This spec walks a page at a time WHILE inserting a further correction, and
 * asserts the walk still yields every row exactly once.
 */
test.describe('TC-CONNECT-REP-010: audit keyset pagination', () => {
  test('pages without duplicates or omissions while new rows arrive', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    try {
      const source = await seedCase(ctx.em, ctx.scope, {
        channelId: ctx.channelId,
        customerKind: 'person',
        customerId: ctx.customerId,
      })
      ctx.ledger.trackCase(source.id)

      // One conversation must always stay behind, so seed four and split three
      // of them one at a time.
      const staying = await seedConversation(ctx.em, ctx.scope, { channelId: ctx.channelId, caseId: source.id })
      ctx.ledger.trackConversation(staying.id)

      const expectedIds: string[] = []
      for (let index = 0; index < 3; index += 1) {
        const conversation = await seedConversation(ctx.em, ctx.scope, {
          channelId: ctx.channelId,
          caseId: source.id,
        })
        ctx.ledger.trackConversation(conversation.id)
        const current = await request.get(`/api/connect/cases?id=${source.id}`, { headers: ctx.authHeaders })
        const currentUpdatedAt = (await current.json()).items[0].updatedAt

        const response = await request.post(splitUrl(source.id), {
          headers: ctx.authHeaders,
          data: {
            conversationIds: [conversation.id],
            expectedUpdatedAt: currentUpdatedAt,
            clientCommandKey: commandKey(`rep-010-${index}`),
            reason: `Split number ${index + 1}`,
          },
        })
        expect(response.status()).toBe(201)
        const body = await response.json()
        ctx.ledger.trackCase(body.destinationCaseId)
        expectedIds.push(body.reparentingId)
      }

      // Walk one row per page. After the first page, insert another correction —
      // a keyset cursor must be unaffected by rows appended behind it.
      const seen: string[] = []
      let cursor: string | null = null
      let injected = false

      for (let guard = 0; guard < 20; guard += 1) {
        const url = `/api/connect/case-reparentings?caseId=${source.id}&pageSize=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
        const page = await request.get(url, { headers: ctx.authHeaders })
        expect(page.status()).toBe(200)
        const body = await page.json()
        for (const item of body.items) seen.push(item.id)

        if (!injected) {
          injected = true
          const extra = await seedConversation(ctx.em, ctx.scope, {
            channelId: ctx.channelId,
            caseId: source.id,
          })
          ctx.ledger.trackConversation(extra.id)
          const current = await request.get(`/api/connect/cases?id=${source.id}`, { headers: ctx.authHeaders })
          const response = await request.post(splitUrl(source.id), {
            headers: ctx.authHeaders,
            data: {
              conversationIds: [extra.id],
              expectedUpdatedAt: (await current.json()).items[0].updatedAt,
              clientCommandKey: commandKey('rep-010-concurrent'),
              reason: 'Correction made while the audit is being paged',
            },
          })
          expect(response.status()).toBe(201)
          const injectedBody = await response.json()
          ctx.ledger.trackCase(injectedBody.destinationCaseId)
          expectedIds.push(injectedBody.reparentingId)
        }

        cursor = body.nextCursor
        if (!cursor) break
      }

      // No duplicates, and every row created before its page was reached.
      expect(new Set(seen).size).toBe(seen.length)
      for (const id of expectedIds) expect(seen).toContain(id)
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('omits reasons and snapshots from the list projection', async ({ request }) => {
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

      const secretReason = 'Confidential note naming the customer'
      const response = await request.post(splitUrl(source.id), {
        headers: ctx.authHeaders,
        data: {
          conversationIds: [moving.id],
          expectedUpdatedAt: source.updatedAt,
          clientCommandKey: commandKey('rep-010-projection'),
          reason: secretReason,
        },
      })
      const body = await response.json()
      ctx.ledger.trackCase(body.destinationCaseId)

      const list = await request.get(`/api/connect/case-reparentings?caseId=${source.id}`, {
        headers: ctx.authHeaders,
      })
      const listBody = await list.json()
      // The overview says who corrected what; the free text stays behind the
      // explicit detail read.
      expect(JSON.stringify(listBody)).not.toContain(secretReason)
      expect(listBody.items[0]).not.toHaveProperty('sourceBefore')
      expect(listBody.items[0]).toMatchObject({ operation: 'split', status: 'completed' })

      const detail = await request.get(`/api/connect/case-reparentings/${body.reparentingId}`, {
        headers: ctx.authHeaders,
      })
      expect(detail.status()).toBe(200)
      const detailBody = await detail.json()
      // Decrypted on the way out, for a caller holding the audit feature.
      expect(detailBody.reason).toBe(secretReason)
      expect(detailBody.items).toHaveLength(1)
      expect(detailBody.items[0]).toMatchObject({
        conversationId: moving.id,
        fromCaseId: source.id,
        toCaseId: body.destinationCaseId,
      })
    } finally {
      await ctx.ledger.cleanup(ctx.em)
    }
  })

  test('rejects a tampered cursor instead of trusting it', async ({ request }) => {
    const ctx = await openReparentingSpec(request)
    const response = await request.get('/api/connect/case-reparentings?cursor=not-a-real-cursor', {
      headers: ctx.authHeaders,
    })
    expect(response.status()).toBe(422)
    expect(await response.json()).toMatchObject({ code: 'invalid_cursor' })
  })
})

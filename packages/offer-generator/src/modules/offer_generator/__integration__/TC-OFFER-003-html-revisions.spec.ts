import { expect, test } from '@playwright/test'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  OPTIMISTIC_LOCK_CONFLICT_CODE,
  OPTIMISTIC_LOCK_CONFLICT_ERROR,
} from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import {
  buildOfferHtml,
  createOfferFixture,
  listRevisions,
  lockHeaders,
  orgFetch,
  putOfferHtml,
  readOffer,
  readOfferHtml,
  setupOfferTestEnv,
  STALE_UPDATED_AT,
  type OfferTestEnv,
} from './support/fixtures'

type HtmlWriteResult = { offerId?: string; revisionId?: string | null; updatedAt?: string }

test.describe('TC-OFFER-003: Offer HTML editing and revisions', () => {
  test('validates, sanitizes, locks and restores offer HTML', async ({ request }) => {
    let env: OfferTestEnv | null = null
    try {
      env = await setupOfferTestEnv(request)
      const offerId = await createOfferFixture(env, { title: 'QA html offer' })

      const incompleteHtml = buildOfferHtml('incomplete').replace('</html>', '')
      const incomplete = await putOfferHtml(env, offerId, incompleteHtml)
      expect(incomplete.status(), 'HTML without </html> should be rejected').toBe(400)
      const incompleteBody = await readJsonSafe<{ code?: string; issue?: string }>(incomplete)
      expect(incompleteBody).toMatchObject({ code: 'incomplete_html', issue: 'no-html-close' })
      expect((await readOffer(env, offerId)).hasHtml).toBe(false)

      const unsafeHtml = buildOfferHtml(
        'first',
        '<script>window.__offerPwned = true</script><p><button onclick="alert(1)">Accept the offer</button></p>',
      )
      const first = await putOfferHtml(env, offerId, unsafeHtml)
      expect(first.status(), 'first complete HTML write should succeed').toBe(200)
      const firstResult = await readJsonSafe<HtmlWriteResult>(first)
      expect(firstResult?.revisionId ?? null, 'the first HTML write keeps no revision').toBeNull()

      const stored = await readOfferHtml(env, offerId)
      expect(stored.html).toContain('data-marker="first"')
      expect(stored.html).toContain('Accept the offer')
      expect(stored.html).not.toMatch(/<script/i)
      expect(stored.html).not.toContain('__offerPwned')
      expect(stored.html).not.toMatch(/onclick/i)
      expect(stored.updatedAt).toBeTruthy()

      const stale = await putOfferHtml(env, offerId, buildOfferHtml('stale'), STALE_UPDATED_AT)
      expect(stale.status(), 'HTML write with a stale updatedAt should be refused').toBe(409)
      const conflict = await readJsonSafe<Record<string, unknown>>(stale)
      expect(conflict).toMatchObject({ error: OPTIMISTIC_LOCK_CONFLICT_ERROR, code: OPTIMISTIC_LOCK_CONFLICT_CODE })
      expect((await readOfferHtml(env, offerId)).html).toContain('data-marker="first"')

      const second = await putOfferHtml(env, offerId, buildOfferHtml('second'), stored.updatedAt)
      expect(second.status(), 'HTML write with the current updatedAt should succeed').toBe(200)
      const secondResult = await readJsonSafe<HtmlWriteResult>(second)
      expect(secondResult?.revisionId, 'replacing HTML keeps the previous version').toBeTruthy()

      const revisions = await listRevisions(env, offerId)
      expect(revisions).toHaveLength(1)
      expect(revisions[0].id).toBe(secondResult?.revisionId)
      expect(revisions[0].source).toBe('manual_edit')
      expect(revisions[0].sizeBytes).toBeGreaterThan(0)

      const current = await readOfferHtml(env, offerId)
      expect(current.html).toContain('data-marker="second"')

      const staleRestore = await orgFetch(env, 'POST', `/api/offer_generator/offers/${offerId}/revisions`, {
        data: { revisionId: revisions[0].id },
        headers: lockHeaders(STALE_UPDATED_AT),
      })
      expect(staleRestore.status(), 'restore with a stale updatedAt should be refused').toBe(409)

      const restore = await orgFetch(env, 'POST', `/api/offer_generator/offers/${offerId}/revisions`, {
        data: { revisionId: revisions[0].id },
        headers: lockHeaders(current.updatedAt),
      })
      expect(restore.status(), 'restore with the current updatedAt should succeed').toBe(200)

      const restored = await readOfferHtml(env, offerId)
      expect(restored.html).toContain('data-marker="first"')
      expect(restored.html).not.toContain('data-marker="second"')
      const afterRestore = await listRevisions(env, offerId)
      expect(afterRestore).toHaveLength(2)
      expect(afterRestore.some((revision) => revision.source === 'restore')).toBe(true)
    } finally {
      if (env) await env.cleanup()
    }
  })
})

import { expect, test } from '@playwright/test'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  buildOfferHtml,
  createOfferFixture,
  orgFetch,
  setOfferHtml,
  setupOfferTestEnv,
  type OfferTestEnv,
} from './support/fixtures'

test.describe('TC-OFFER-006: Offer PDF export', () => {
  test('returns a PDF when Chromium is available and a 503 otherwise', async ({ request }) => {
    test.setTimeout(90_000)
    let env: OfferTestEnv | null = null
    try {
      env = await setupOfferTestEnv(request)
      const offerId = await createOfferFixture(env, { title: 'QA pdf offer' })

      const empty = await orgFetch(env, 'GET', `/api/offer_generator/offers/${offerId}/pdf`)
      expect(empty.status(), 'an offer without HTML has nothing to export').toBe(404)

      await setOfferHtml(env, offerId, buildOfferHtml('pdf'))
      const response = await orgFetch(env, 'GET', `/api/offer_generator/offers/${offerId}/pdf`)
      expect([200, 503], 'PDF export should succeed or report the runtime as unavailable').toContain(response.status())

      if (response.status() === 200) {
        expect(response.headers()['content-type'] ?? '').toContain('application/pdf')
        expect(response.headers()['content-disposition'] ?? '').toContain('attachment;')
        const pdf = await response.body()
        expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
      } else {
        const body = await readJsonSafe<{ error?: string; code?: string }>(response)
        expect(
          ['pdf_runtime_unavailable', 'pdf_overloaded', 'pdf_render_timeout'],
          'a 503 should carry a stable PDF error code',
        ).toContain(body?.code)
        expect(typeof body?.error === 'string' && body.error.length > 0, 'a 503 should explain the outage').toBe(true)
        expect(response.headers()['content-type'] ?? '').toContain('application/json')
      }
    } finally {
      if (env) await env.cleanup()
    }
  })
})

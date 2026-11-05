import { expect, test } from '@playwright/test'
import { withCredentialIsolatedRequest } from '@open-mercato/core/helpers/integration/api'
import {
  buildOfferHtml,
  createOfferFixture,
  readOffer,
  segmentFromPublicUrl,
  setOfferHtml,
  setupOfferTestEnv,
  updateOffer,
  type OfferTestEnv,
} from './support/fixtures'

function replaceToken(segment: string): string {
  const index = segment.lastIndexOf('-')
  const token = segment.slice(index + 1)
  const forged = token === 'aaaaaaaaaaaa' ? 'bbbbbbbbbbbb' : 'aaaaaaaaaaaa'
  return `${segment.slice(0, index + 1)}${forged}`
}

test.describe('TC-OFFER-004: Public offer render', () => {
  test('serves only sent offers with a valid token under a script-free CSP', async ({ request }) => {
    let env: OfferTestEnv | null = null
    try {
      env = await setupOfferTestEnv(request)
      const offerId = await createOfferFixture(env, { title: 'QA public offer' })
      await setOfferHtml(env, offerId, buildOfferHtml('public'))
      const draft = await readOffer(env, offerId)
      expect(draft.status).toBe('draft')
      const segment = segmentFromPublicUrl(draft.publicUrl)
      const renderPath = `/api/offer_generator/render/public/${encodeURIComponent(segment)}`

      await withCredentialIsolatedRequest(async (anonymous) => {
        const draftResponse = await anonymous.get(renderPath)
        expect(draftResponse.status(), 'a draft offer must not be public').toBe(404)
      })

      const sent = await updateOffer(env, offerId, { status: 'sent' })
      expect(sent.status(), 'PUT offer status sent should return 200').toBe(200)

      await withCredentialIsolatedRequest(async (anonymous) => {
        const response = await anonymous.get(renderPath)
        expect(response.status(), 'a sent offer should render publicly').toBe(200)
        expect(response.headers()['content-type'] ?? '').toContain('text/html')
        expect(response.headers()['content-security-policy'] ?? '').toContain("script-src 'none'")
        const html = await response.text()
        expect(html).toContain('data-marker="public"')

        const forged = await anonymous.get(`/api/offer_generator/render/public/${encodeURIComponent(replaceToken(segment))}`)
        expect(forged.status(), 'a wrong access token must not render the offer').toBe(404)
        expect(await forged.text()).not.toContain('data-marker="public"')

        const page = await anonymous.get(`/oferta/${encodeURIComponent(segment)}`)
        expect(page.status(), 'the public offer page should load').toBe(200)
        expect(page.headers()['content-type'] ?? '').toContain('text/html')
      })
    } finally {
      if (env) await env.cleanup()
    }
  })
})

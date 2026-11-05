import { randomUUID } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'
import { withCredentialIsolatedRequest } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import type { TrackingBody } from '../data/validators'
import type { OfferInsightsDto } from '../lib/views-repository'
import {
  BOT_USER_AGENT,
  BROWSER_USER_AGENT,
  createPublishedOffer,
  orgFetch,
  readOffer,
  resolveAppOrigin,
  resolveUrl,
  segmentFromPublicUrl,
  setupOfferTestEnv,
  type OfferTestEnv,
} from './support/fixtures'

const SESSIONS_PATH = '/api/offer_generator/public/sessions'

type SessionStartResponse = { ok?: boolean; counted?: boolean; visitorId?: string; internal?: boolean; code?: string }

function sendTracking(
  request: APIRequestContext,
  body: TrackingBody,
  options: { origin: string; userAgent: string; token?: string },
) {
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain;charset=UTF-8',
    Origin: options.origin,
    'User-Agent': options.userAgent,
  }
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  return request.fetch(resolveUrl(SESSIONS_PATH), { method: 'POST', headers, data: JSON.stringify(body) })
}

async function readInsights(env: OfferTestEnv, offerId: string): Promise<OfferInsightsDto> {
  const response = await orgFetch(env, 'GET', `/api/offer_generator/offers/${offerId}/insights`)
  expect(response.status(), 'GET offer insights should return 200').toBe(200)
  const body = await readJsonSafe<OfferInsightsDto>(response)
  expect(body, 'GET offer insights should return a body').toBeTruthy()
  return body as OfferInsightsDto
}

test.describe('TC-OFFER-005: Public view tracking and insights', () => {
  test('counts browser views, ignores bots, rejects foreign origins and flags internal views', async ({ request }) => {
    let env: OfferTestEnv | null = null
    try {
      env = await setupOfferTestEnv(request)
      const offer = await createPublishedOffer(env, 'tracking')
      expect(offer.status).toBe('sent')
      expect(offer.viewedAt).toBeNull()
      const seg = segmentFromPublicUrl(offer.publicUrl)
      const origin = resolveAppOrigin()
      const viewKey = randomUUID()

      await withCredentialIsolatedRequest(async (anonymous) => {
        const start = await sendTracking(
          anonymous,
          { t: 'start', seg, key: viewKey, ref: 'https://mail.example.com/' },
          { origin, userAgent: BROWSER_USER_AGENT },
        )
        expect(start.status(), 'a browser start should be accepted').toBe(200)
        const startBody = await readJsonSafe<SessionStartResponse>(start)
        expect(startBody).toMatchObject({ ok: true, counted: true, internal: false })

        const beat = await sendTracking(
          anonymous,
          {
            t: 'beat',
            seg,
            key: viewKey,
            ms: 4000,
            sc: 75,
            sx: [
              { k: 'intro', l: 'Introduction', ms: 1500 },
              { k: 'pricing', l: 'Pricing', ms: 2500 },
            ],
          },
          { origin, userAgent: BROWSER_USER_AGENT },
        )
        expect(beat.status(), 'a beat should be accepted with 204').toBe(204)

        const bot = await sendTracking(
          anonymous,
          { t: 'start', seg, key: randomUUID(), ref: null },
          { origin, userAgent: BOT_USER_AGENT },
        )
        expect(bot.status(), 'a bot start is acknowledged').toBe(200)
        expect(await readJsonSafe<SessionStartResponse>(bot)).toMatchObject({ ok: true, counted: false })

        const foreign = await sendTracking(
          anonymous,
          { t: 'start', seg, key: randomUUID(), ref: null },
          { origin: 'https://evil.example.com', userAgent: BROWSER_USER_AGENT },
        )
        expect(foreign.status(), 'a foreign Origin must be rejected').toBe(403)
      })

      const insights = await readInsights(env, offer.id)
      expect(insights.stats.views).toBe(1)
      expect(insights.stats.internalViews).toBe(0)
      expect(insights.views).toHaveLength(1)
      expect(insights.views[0].isInternal).toBe(false)
      expect(insights.views[0].sectionsSeen).toBe(2)
      expect(insights.views[0].maxScrollPct).toBe(75)
      const sectionKeys = insights.sections.map((section) => section.key)
      expect(sectionKeys).toEqual(expect.arrayContaining(['intro', 'pricing']))

      const viewed = await readOffer(env, offer.id)
      expect(viewed.status).toBe('viewed')
      expect(viewed.viewedAt).toBeTruthy()
      expect(viewed.viewCount).toBe(1)

      const internalStart = await sendTracking(
        env.request,
        { t: 'start', seg, key: randomUUID(), ref: null },
        { origin, userAgent: BROWSER_USER_AGENT, token: env.token },
      )
      expect(internalStart.status(), 'an authenticated start should be accepted').toBe(200)
      expect(await readJsonSafe<SessionStartResponse>(internalStart)).toMatchObject({ ok: true, counted: true, internal: true })

      const afterInternal = await readInsights(env, offer.id)
      expect(afterInternal.stats.views).toBe(1)
      expect(afterInternal.stats.internalViews).toBe(1)
      expect(afterInternal.views.some((view) => view.isInternal)).toBe(true)
      expect((await readOffer(env, offer.id)).viewCount).toBe(1)
    } finally {
      if (env) await env.cleanup()
    }
  })
})

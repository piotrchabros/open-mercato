import { expect, test } from '@playwright/test'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  OPTIMISTIC_LOCK_CONFLICT_CODE,
  OPTIMISTIC_LOCK_CONFLICT_ERROR,
} from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import type { SettingsDto } from '../lib/serializers'
import { buildOfferHtml, lockHeaders, orgFetch, setupOfferTestEnv, STALE_UPDATED_AT, type OfferTestEnv } from './support/fixtures'

const SETTINGS_PATH = '/api/offer_generator/settings'

async function readSettings(env: OfferTestEnv): Promise<SettingsDto> {
  const response = await orgFetch(env, 'GET', SETTINGS_PATH)
  expect(response.status(), 'GET settings should return 200').toBe(200)
  const body = await readJsonSafe<SettingsDto>(response)
  expect(body, 'GET settings should return a body').toBeTruthy()
  return body as SettingsDto
}

test.describe('TC-OFFER-008: Offer generator settings with optimistic lock', () => {
  test('returns defaults, saves changes and refuses a stale save', async ({ request }) => {
    let env: OfferTestEnv | null = null
    try {
      env = await setupOfferTestEnv(request)

      const defaults = await readSettings(env)
      expect(defaults.companyName).toBe('BlueBee')
      expect(defaults.defaultLanguage).toBe('pl')
      expect(defaults.defaultCurrency).toBe('PLN')
      expect(defaults.defaultModel).toBeNull()
      expect(defaults.alternateModels).toEqual([])
      expect(defaults.templateHtml.length).toBeGreaterThan(0)

      const payload = {
        companyName: 'QA Offer Studio',
        templateHtml: buildOfferHtml('template'),
        extraInstructions: 'Always mention the support SLA.',
        defaultLanguage: 'en',
        defaultCurrency: 'eur',
        defaultModel: null,
        alternateModels: [],
      }
      const firstSave = await orgFetch(env, 'PUT', SETTINGS_PATH, {
        data: payload,
        headers: lockHeaders(defaults.updatedAt),
      })
      expect(firstSave.status(), 'first settings save should succeed').toBe(200)
      const saved = await readJsonSafe<SettingsDto>(firstSave)
      expect(saved).toMatchObject({
        companyName: 'QA Offer Studio',
        extraInstructions: 'Always mention the support SLA.',
        defaultLanguage: 'en',
        defaultCurrency: 'EUR',
      })
      expect(saved?.templateHtml).toContain('data-marker="template"')
      expect(saved?.updatedAt, 'saved settings should expose updatedAt').toBeTruthy()

      const reloaded = await readSettings(env)
      expect(reloaded.companyName).toBe('QA Offer Studio')
      expect(reloaded.updatedAt).toBe(saved?.updatedAt)

      const secondSave = await orgFetch(env, 'PUT', SETTINGS_PATH, {
        data: { ...payload, companyName: 'QA Offer Studio Two' },
        headers: lockHeaders(reloaded.updatedAt),
      })
      expect(secondSave.status(), 'settings save with the current updatedAt should succeed').toBe(200)

      const stale = await orgFetch(env, 'PUT', SETTINGS_PATH, {
        data: { ...payload, companyName: 'QA Offer Studio Stale' },
        headers: lockHeaders(STALE_UPDATED_AT),
      })
      expect(stale.status(), 'settings save with a stale updatedAt should be refused').toBe(409)
      const conflict = await readJsonSafe<Record<string, unknown>>(stale)
      expect(conflict).toMatchObject({ error: OPTIMISTIC_LOCK_CONFLICT_ERROR, code: OPTIMISTIC_LOCK_CONFLICT_CODE })
      expect((await readSettings(env)).companyName).toBe('QA Offer Studio Two')
    } finally {
      if (env) await env.cleanup()
    }
  })
})

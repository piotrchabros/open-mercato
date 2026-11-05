import { expect, test } from '@playwright/test'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  OPTIMISTIC_LOCK_CONFLICT_CODE,
  OPTIMISTIC_LOCK_CONFLICT_ERROR,
} from '@open-mercato/shared/lib/crud/optimistic-lock-headers'
import {
  createExtraOrganization,
  createOfferFixture,
  deleteExtraOrganization,
  deleteOfferIfExists,
  findOffer,
  orgFetch,
  orgFetchFor,
  readOffer,
  setupOfferTestEnv,
  STALE_UPDATED_AT,
  updateOffer,
  type OfferTestEnv,
} from './support/fixtures'

test.describe('TC-OFFER-001: Offer CRUD, optimistic lock and organization isolation', () => {
  test('creates, updates, rejects a stale update, hides the offer from another org and deletes it', async ({ request }) => {
    let env: OfferTestEnv | null = null
    let otherOrgId: string | null = null
    let offerId: string | null = null
    try {
      env = await setupOfferTestEnv(request)
      offerId = await createOfferFixture(env, {
        title: 'QA CRUD offer',
        clientName: 'Acme Widgets',
        valueAmount: 1200,
        currencyCode: 'EUR',
      })

      const created = await readOffer(env, offerId)
      expect(created.title).toBe('QA CRUD offer')
      expect(created.clientName).toBe('Acme Widgets')
      expect(created.status).toBe('draft')
      expect(created.hasHtml).toBe(false)
      expect(created.slug.length).toBeGreaterThan(0)
      expect(created.publicUrl).toContain(`/oferta/${created.slug}-`)
      expect(created.updatedAt, 'list/detail responses must expose updatedAt').toBeTruthy()

      const update = await updateOffer(env, offerId, { title: 'QA CRUD offer updated' }, created.updatedAt)
      expect(update.status(), 'PUT with the current updatedAt should succeed').toBe(200)

      const updated = await readOffer(env, offerId)
      expect(updated.title).toBe('QA CRUD offer updated')
      expect(updated.updatedAt).not.toBe(created.updatedAt)

      const stale = await updateOffer(env, offerId, { title: 'QA CRUD offer stale' }, STALE_UPDATED_AT)
      expect(stale.status(), 'PUT with a stale updatedAt should be refused').toBe(409)
      const conflict = await readJsonSafe<Record<string, unknown>>(stale)
      expect(conflict).toMatchObject({ error: OPTIMISTIC_LOCK_CONFLICT_ERROR, code: OPTIMISTIC_LOCK_CONFLICT_CODE })
      expect((await readOffer(env, offerId)).title).toBe('QA CRUD offer updated')

      otherOrgId = await createExtraOrganization(env, 'isolation')
      expect(await findOffer(env, offerId, otherOrgId), 'another organization must not list the offer').toBeNull()
      const foreignHtml = await orgFetchFor(env, otherOrgId, 'GET', `/api/offer_generator/offers/${offerId}/html`)
      expect(foreignHtml.status(), 'another organization must not read the offer HTML').toBe(404)
      const foreignUpdate = await orgFetchFor(env, otherOrgId, 'PUT', '/api/offer_generator/offers', {
        data: { id: offerId, title: 'Hijacked' },
      })
      expect(foreignUpdate.status(), 'another organization must not update the offer').toBeGreaterThanOrEqual(400)
      expect((await readOffer(env, offerId)).title).toBe('QA CRUD offer updated')

      const deletion = await orgFetch(env, 'DELETE', `/api/offer_generator/offers?id=${encodeURIComponent(offerId)}`)
      expect(deletion.status(), 'DELETE offer should succeed').toBe(200)
      expect(await findOffer(env, offerId), 'deleted offer should no longer be listed').toBeNull()
      offerId = null
    } finally {
      if (env) {
        await deleteOfferIfExists(env, offerId)
        await deleteExtraOrganization(env, otherOrgId)
        await env.cleanup()
      }
    }
  })
})

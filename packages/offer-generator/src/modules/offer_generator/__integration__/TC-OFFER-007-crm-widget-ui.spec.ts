import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { login } from '@open-mercato/core/helpers/integration/auth'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createPersonFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { withClient } from '@open-mercato/core/helpers/integration/dbFixtures'
import { expectId, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { uniqueSuffix } from './support/fixtures'

const englishStrings = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../i18n/en.json'), 'utf8'),
) as Record<string, string>
const offersTabLabel = englishStrings['offer_generator.widgets.crmOffers.tab']
const newOfferLabel = englishStrings['offer_generator.widgets.crmOffers.new']

export const integrationMeta = { dependsOnModules: ['customers'] }

async function openOffersTab(page: Page): Promise<void> {
  const offersTab = page.getByRole('tab', { name: offersTabLabel, exact: true }).first()
  if (await offersTab.isVisible().catch(() => false)) {
    await offersTab.click()
    return
  }
  const expandPanel = page.getByRole('button', { name: /expand form panel/i })
  if (await expandPanel.isVisible().catch(() => false)) {
    await expandPanel.click()
  }
  await expect(offersTab).toBeVisible({ timeout: 15_000 })
  await offersTab.click()
}

test.describe('TC-OFFER-007: Offers tab on the CRM person detail page', () => {
  test('lists the linked offer and prefills a new offer for the person', async ({ page, request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const stamp = uniqueSuffix()
    const displayName = `QA Offer Person ${stamp}`
    const offerTitle = `QA CRM offer ${stamp}`
    let personId: string | null = null
    let offerId: string | null = null
    try {
      personId = await createPersonFixture(request, token, {
        firstName: 'QA',
        lastName: `Offer ${stamp}`,
        displayName,
      })
      const response = await apiRequest(request, 'POST', '/api/offer_generator/offers', {
        token,
        data: {
          title: offerTitle,
          clientName: displayName,
          language: 'en',
          customerEntityId: personId,
          customerKind: 'person',
        },
      })
      const body = await readJsonSafe<{ id?: string }>(response)
      expect(response.status(), 'POST /api/offer_generator/offers should return 201').toBe(201)
      offerId = expectId(body?.id, 'Offer creation response should include id')

      await login(page, 'admin')
      await page.goto(`/backend/customers/people-v2/${personId}`, { waitUntil: 'domcontentloaded' })
      await openOffersTab(page)

      const offerLink = page.getByRole('link', { name: new RegExp(offerTitle) })
      await expect(offerLink).toBeVisible({ timeout: 15_000 })
      await expect(offerLink).toHaveAttribute('href', `/backend/offer-generator/${offerId}`)

      const newOffer = page.getByRole('link', { name: newOfferLabel, exact: true }).first()
      await expect(newOffer).toBeVisible()
      await newOffer.click()

      await page.waitForURL(/\/backend\/offer-generator\/create\?/, { timeout: 15_000 })
      const createUrl = new URL(page.url())
      expect(createUrl.searchParams.get('customerEntityId')).toBe(personId)
      expect(createUrl.searchParams.get('customerKind')).toBe('person')
      await expect(page.locator('[data-crud-field-id="clientName"] input')).toHaveValue(displayName, { timeout: 15_000 })
    } finally {
      if (offerId) {
        await apiRequest(request, 'DELETE', `/api/offer_generator/offers?id=${encodeURIComponent(offerId)}`, { token }).catch(
          () => undefined,
        )
        const createdOfferId = offerId
        await withClient(async (client) => {
          await client.query('delete from offer_generator_offers where id = $1', [createdOfferId])
        }).catch(() => undefined)
      }
      await deleteEntityIfExists(request, token, '/api/customers/people', personId)
    }
  })
})

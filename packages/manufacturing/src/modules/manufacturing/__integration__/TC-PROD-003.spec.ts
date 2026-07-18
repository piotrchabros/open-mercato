import { expect, test } from '@playwright/test'
import { login } from '@open-mercato/core/helpers/integration/auth'
import {
  apiRequest,
  getAuthToken,
  readJsonSafe,
  ensureManufacturingEnabledToggle,
  createWorkCenter,
  deleteWorkCenterIfExists,
  createRouting,
  deleteRoutingIfExists,
  uniqueName,
} from './helpers/manufacturing'

/**
 * TC-PROD-003: Routing create with operations + activate + backend list UI
 * visibility (task 1.3).
 *
 * Self-contained: creates its own work-center + routing fixtures via the API
 * and deletes them in `finally`; the toggle is ensured idempotently.
 */
test.describe('TC-PROD-003: Routing create + operations + activate', () => {
  test('creates a routing with operations, activates it, and sees it in the backend list', async ({ request, page }) => {
    test.setTimeout(60_000)

    const superadminToken = await getAuthToken(request, 'superadmin')
    const adminToken = await getAuthToken(request, 'admin')
    await ensureManufacturingEnabledToggle(request, superadminToken)

    let workCenterId: string | null = null
    let routingId: string | null = null

    try {
      workCenterId = await createWorkCenter(request, adminToken, { name: uniqueName('QA Routing Work Center') })

      const name = uniqueName('QA Routing')
      const { id, productId } = await createRouting(
        request,
        adminToken,
        {
          name,
          status: 'draft',
          operations: [
            {
              sequence: 10,
              name: 'Cut',
              workCenterId,
              setupTimeMinutes: 5,
              runTimePerUnitSeconds: 20,
              isReportingPoint: true,
            },
            {
              sequence: 20,
              name: 'Assemble',
              workCenterId,
              setupTimeMinutes: 2,
              runTimePerUnitSeconds: 45,
              isReportingPoint: false,
            },
          ],
        },
      )
      routingId = id

      const detailResponse = await apiRequest(request, 'GET', `/api/manufacturing/routings/${routingId}`, { token: adminToken })
      expect(detailResponse.status()).toBe(200)
      const detailBody = await readJsonSafe<{ operations?: Array<{ sequence?: number; name?: string; workCenterId?: string }> }>(detailResponse)
      expect(detailBody?.operations?.length).toBe(2)
      expect(detailBody?.operations?.[0]?.workCenterId).toBe(workCenterId)

      const activateResponse = await apiRequest(request, 'POST', `/api/manufacturing/routings/${routingId}/activate`, { token: adminToken })
      expect(activateResponse.status()).toBe(200)

      const listResponse = await apiRequest(request, 'GET', `/api/manufacturing/routings?productId=${productId}`, { token: adminToken })
      const listBody = await readJsonSafe<{ items?: Array<{ id?: string; status?: string }> }>(listResponse)
      expect((listBody?.items ?? []).find((item) => item.id === routingId)?.status).toBe('active')

      // Backend list UI: the fixture row should render for an authenticated admin.
      await login(page, 'admin')
      await page.goto('/backend/manufacturing/routings')
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) })
      await expect(row).toBeVisible({ timeout: 10_000 })
    } finally {
      await deleteRoutingIfExists(request, adminToken, routingId)
      await deleteWorkCenterIfExists(request, adminToken, workCenterId)
    }
  })
})

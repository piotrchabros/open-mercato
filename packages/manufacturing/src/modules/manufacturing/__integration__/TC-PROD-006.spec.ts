import { expect, test } from '@playwright/test'
import {
  apiRequest,
  getAuthToken,
  readJsonSafe,
  ensureManufacturingEnabledToggle,
  createWorkCenter,
  deleteWorkCenterIfExists,
  createBom,
  deleteBomIfExists,
  createRouting,
  deleteRoutingIfExists,
  createPlanningParams,
  createManufacturingOrder,
  deleteManufacturingOrderIfExists,
  uniqueUuid,
} from './helpers/manufacturing'

type OrderDetailResponse = {
  id?: string
  status?: string
  materials?: Array<{ componentProductId?: string; qtyRequired?: string; reservedQty?: number }>
}

type ReleaseResponse = {
  ok?: boolean
  reservations?: number
  shortages?: Array<{ componentProductId?: string; reason?: string }>
}

type OrdersListResponse = {
  items?: Array<{ id?: string; sourceType?: string; sourceId?: string; status?: string }>
}

/**
 * TC-PROD-006: Manufacturing orders UI happy path (task 3.4) — sales order ->
 * manufacturing order -> release, at the API level backing the backend UI's
 * list (status/source filters), detail (operations/materials), and
 * plan/release actions.
 *
 * `sourceType: 'sales_order'` models the sales-order-triggered flow; the
 * manufacturing API never resolves `sourceId` against the sales module (same
 * convention as `productId`/`componentProductId` staying raw fixture UUIDs
 * across every existing TC-PROD spec), so a fixture UUID stands in for a
 * real sales order id.
 *
 * Self-contained: creates its own work center, BOM (+activate), routing
 * (+activate), planning params, stock receipt, and manufacturing order via the
 * API, cleaning up fixtures in `finally`. The toggle is ensured idempotently.
 */
test.describe('TC-PROD-006: Manufacturing order happy path — sales order -> release', () => {
  test('plans and releases a manufacturing order sourced from a sales order, with reservations and no shortages', async ({ request }) => {
    test.setTimeout(60_000)

    const superadminToken = await getAuthToken(request, 'superadmin')
    const adminToken = await getAuthToken(request, 'admin')
    await ensureManufacturingEnabledToggle(request, superadminToken)

    const productId = uniqueUuid()
    const componentProductId = uniqueUuid()
    const salesOrderId = uniqueUuid()

    let workCenterId: string | null = null
    let bomId: string | null = null
    let routingId: string | null = null
    let orderId: string | null = null

    try {
      workCenterId = await createWorkCenter(request, adminToken, { kind: 'machine' })

      const bom = await createBom(request, adminToken, {
        productId,
        status: 'active',
        items: [
          { componentProductId, qtyPerUnit: 2, uom: 'PCS', scrapFactor: 0, isPhantom: false },
        ],
      })
      bomId = bom.id

      const routing = await createRouting(
        request,
        adminToken,
        { productId, status: 'active' },
        workCenterId,
      )
      routingId = routing.id

      await createPlanningParams(request, adminToken, { productId, procurement: 'make' })

      // Enough on-hand stock (2 units required, receive 10) so release
      // reserves the full requirement with no shortage.
      const receiveResponse = await apiRequest(request, 'POST', '/api/manufacturing/stock/receipts', {
        token: adminToken,
        data: { productId: componentProductId, qty: 10, uom: 'PCS' },
      })
      expect(receiveResponse.status(), 'POST stock/receipts should return 201').toBe(201)

      orderId = await createManufacturingOrder(request, adminToken, {
        productId,
        qtyPlanned: 5,
        uom: 'PCS',
        sourceType: 'sales_order',
        sourceId: salesOrderId,
      })

      // --- List filters by sourceType/sourceId (the sales-widget lookup shape) ---
      const listResponse = await apiRequest(
        request,
        'GET',
        `/api/manufacturing/orders?sourceType=sales_order&sourceId=${salesOrderId}`,
        { token: adminToken },
      )
      expect(listResponse.status()).toBe(200)
      const listBody = await readJsonSafe<OrdersListResponse>(listResponse)
      const listedOrder = (listBody?.items ?? []).find((item) => item.id === orderId)
      expect(listedOrder, 'the created order should be returned by the sourceType/sourceId filter').toBeTruthy()
      expect(listedOrder?.status).toBe('draft')

      // --- Plan: draft -> planned ---
      const planResponse = await apiRequest(request, 'POST', `/api/manufacturing/orders/${orderId}/plan`, { token: adminToken })
      expect(planResponse.status()).toBe(200)

      // --- Release: planned -> released, materials/operations snapshot + reservations ---
      const releaseResponse = await apiRequest(request, 'POST', `/api/manufacturing/orders/${orderId}/release`, { token: adminToken })
      expect(releaseResponse.status()).toBe(200)
      const releaseBody = await readJsonSafe<ReleaseResponse>(releaseResponse)
      expect(releaseBody?.ok).toBe(true)
      expect(releaseBody?.reservations ?? 0).toBeGreaterThan(0)
      expect(releaseBody?.shortages ?? []).toHaveLength(0)

      // --- Detail: released order exposes the materials snapshot with the reservation reflected ---
      const detailResponse = await apiRequest(request, 'GET', `/api/manufacturing/orders/${orderId}`, { token: adminToken })
      expect(detailResponse.status()).toBe(200)
      const detailBody = await readJsonSafe<OrderDetailResponse>(detailResponse)
      expect(detailBody?.status).toBe('released')
      const material = (detailBody?.materials ?? []).find((m) => m.componentProductId === componentProductId)
      expect(material, 'the released order should have a materials row for the BOM component').toBeTruthy()
      expect(Number(material?.qtyRequired)).toBe(2)
      expect(material?.reservedQty ?? 0).toBeGreaterThan(0)

      // --- Shortages (on-demand recompute): none, since stock covers the requirement ---
      const shortagesResponse = await apiRequest(request, 'GET', `/api/manufacturing/orders/${orderId}/shortages`, { token: adminToken })
      expect(shortagesResponse.status()).toBe(200)
      const shortagesBody = await readJsonSafe<{ lines?: unknown[] }>(shortagesResponse)
      expect(shortagesBody?.lines ?? []).toHaveLength(0)
    } finally {
      await deleteManufacturingOrderIfExists(request, adminToken, orderId)
      await deleteRoutingIfExists(request, adminToken, routingId)
      await deleteBomIfExists(request, adminToken, bomId)
      await deleteWorkCenterIfExists(request, adminToken, workCenterId)
    }
  })
})

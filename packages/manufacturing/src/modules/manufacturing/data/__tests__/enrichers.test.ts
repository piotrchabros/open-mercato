export {}

import { enrichers } from '../enrichers.js'
import type { EnricherContext } from '@open-mercato/shared/lib/crud/response-enricher'
import { applyResponseEnrichers } from '@open-mercato/shared/lib/crud/enricher-runner'

const manufacturingOrdersStatusEnricher = enrichers[0]

function makeEm(rows: Array<Record<string, unknown>>) {
  return {
    find: jest.fn(async (_entity: unknown, filter: Record<string, unknown>) => {
      const sourceIds = (filter.sourceId as { $in?: string[] } | undefined)?.$in ?? []
      return rows.filter((row) => sourceIds.includes(row.sourceId as string))
    }),
  }
}

function makeContext(em: unknown, overrides?: Partial<EnricherContext>): EnricherContext {
  return {
    organizationId: 'org-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    em,
    container: {},
    ...overrides,
  }
}

describe('manufacturing.orders-status enricher', () => {
  it('declares the exact sales order target entity and view-only ACL gate', () => {
    expect(manufacturingOrdersStatusEnricher.id).toBe('manufacturing.orders-status')
    expect(manufacturingOrdersStatusEnricher.targetEntity).toBe('sales:sales_order')
    expect(manufacturingOrdersStatusEnricher.features).toEqual(['manufacturing.orders.view'])
    expect(manufacturingOrdersStatusEnricher.fallback).toEqual({ _manufacturing: null })
    expect(manufacturingOrdersStatusEnricher.cacheableOnListHit).toBe(false)
  })

  it('enrichMany batches by sourceId and attaches _manufacturing.orders', async () => {
    const em = makeEm([
      { id: 'po-1', number: 1, status: 'released', qtyPlanned: '10', qtyCompleted: '4', sourceId: 'order-1' },
      { id: 'po-2', number: 2, status: 'draft', qtyPlanned: '5', qtyCompleted: '0', sourceId: 'order-2' },
    ])
    const records = [{ id: 'order-1' }, { id: 'order-2' }, { id: 'order-3' }]

    const result = await manufacturingOrdersStatusEnricher.enrichMany!(records, makeContext(em))

    expect(em.find).toHaveBeenCalledTimes(1)
    expect(result[0]).toMatchObject({ id: 'order-1', _manufacturing: { orders: [{ id: 'po-1', number: 1 }] } })
    expect(result[1]).toMatchObject({ id: 'order-2', _manufacturing: { orders: [{ id: 'po-2', number: 2 }] } })
    expect(result[2]).toMatchObject({ id: 'order-3', _manufacturing: null })
  })

  it('returns _manufacturing: null for orders with no linked manufacturing orders (fallback shape)', async () => {
    const em = makeEm([])
    const result = await manufacturingOrdersStatusEnricher.enrichMany!([{ id: 'order-1' }], makeContext(em))
    expect(result[0]._manufacturing).toBeNull()
  })

  it('enrichOne delegates to enrichMany for a single record', async () => {
    const em = makeEm([{ id: 'po-1', number: 1, status: 'draft', qtyPlanned: '1', qtyCompleted: '0', sourceId: 'order-9' }])
    const result = await manufacturingOrdersStatusEnricher.enrichOne({ id: 'order-9' }, makeContext(em))
    expect(result._manufacturing).toMatchObject({ orders: [{ id: 'po-1' }] })
  })

  it('ACL gate: a caller without manufacturing.orders.view (e.g. every portal/customer-facing request) gets no _manufacturing data at all', async () => {
    const em = makeEm([{ id: 'po-1', number: 1, status: 'released', qtyPlanned: '10', qtyCompleted: '4', sourceId: 'order-1' }])
    const preFilteredEntries = [{ moduleId: 'manufacturing', enricher: manufacturingOrdersStatusEnricher }]

    const portalResult = await applyResponseEnrichers(
      [{ id: 'order-1' }],
      'sales:sales_order',
      makeContext(em, { userFeatures: [] }),
      preFilteredEntries,
    )
    // Filtered out before it ever runs — no enricher execution, no fallback merge, no _manufacturing key.
    expect(em.find).not.toHaveBeenCalled()
    expect(portalResult._meta.enrichedBy).toEqual([])
    expect(portalResult.items[0]).not.toHaveProperty('_manufacturing')

    const backendResult = await applyResponseEnrichers(
      [{ id: 'order-1' }],
      'sales:sales_order',
      makeContext(em, { userFeatures: ['manufacturing.orders.view'] }),
      preFilteredEntries,
    )
    expect(backendResult._meta.enrichedBy).toEqual(['manufacturing.orders-status'])
    expect(backendResult.items[0]).toMatchObject({ _manufacturing: { orders: [{ id: 'po-1' }] } })
  })
})

import { describe, it, expect } from '@jest/globals'
import { MetadataStorage } from '@mikro-orm/core'
import {
  WorkCenter,
  ManufacturingBom,
  ManufacturingBomItem,
  Routing,
  RoutingOperation,
  ProductPlanningParams,
  ManufacturingOrder,
  ManufacturingOrderOperation,
  ManufacturingOrderMaterial,
} from '../entities'
import { E } from '../../../../../generated/entities.ids.generated'
import { extensions } from '../extensions'

function metaFor(entityClass: { name: string }) {
  const map = MetadataStorage.getMetadata(entityClass.name) as Record<string, any>
  const key = Object.keys(map).find((k) => map[k]?.class === entityClass || map[k]?.className === entityClass.name)
  return key ? map[key] : Object.values(map)[0]
}

function expectStandardColumns(entityClass: { name: string }) {
  const meta = metaFor(entityClass)
  const props = Object.keys(meta.properties)
  expect(props).toEqual(expect.arrayContaining(['id', 'tenantId', 'organizationId', 'createdAt', 'updatedAt', 'deletedAt']))
}

describe('WorkCenter entity', () => {
  it('should be constructible', () => {
    const wc = new WorkCenter()
    expect(wc).toBeInstanceOf(WorkCenter)
  })

  it('maps to manufacturing_work_centers table', () => {
    const meta = metaFor(WorkCenter)
    expect(meta.tableName).toBe('manufacturing_work_centers')
  })

  it('has standard tenant/org/audit columns', () => {
    expectStandardColumns(WorkCenter)
  })

  it('has key columns from spec', () => {
    const meta = metaFor(WorkCenter)
    const props = Object.keys(meta.properties)
    expect(props).toEqual(expect.arrayContaining([
      'name',
      'kind',
      'costRatePerHour',
      'parallelStations',
      'efficiencyFactor',
      'availabilityRuleSetId',
      'isActive',
    ]))
  })
})

describe('ManufacturingBom entity', () => {
  it('maps to manufacturing_boms table', () => {
    const meta = metaFor(ManufacturingBom)
    expect(meta.tableName).toBe('manufacturing_boms')
  })

  it('has standard tenant/org/audit columns', () => {
    expectStandardColumns(ManufacturingBom)
  })

  it('has key columns from spec', () => {
    const meta = metaFor(ManufacturingBom)
    const props = Object.keys(meta.properties)
    expect(props).toEqual(expect.arrayContaining([
      'productId',
      'variantId',
      'version',
      'status',
      'validFrom',
      'validTo',
      'name',
    ]))
  })

  it('has a unique constraint on tenant/org/product/variant/version', () => {
    const meta = metaFor(ManufacturingBom)
    expect(meta.uniques.length).toBeGreaterThan(0)
    const properties = meta.uniques.flatMap((u: any) => u.properties)
    expect(properties).toEqual(expect.arrayContaining(['tenantId', 'organizationId', 'productId', 'variantId', 'version']))
  })
})

describe('ManufacturingBomItem entity', () => {
  it('maps to manufacturing_bom_items table', () => {
    const meta = metaFor(ManufacturingBomItem)
    expect(meta.tableName).toBe('manufacturing_bom_items')
  })

  it('has standard tenant/org/audit columns', () => {
    expectStandardColumns(ManufacturingBomItem)
  })

  it('has key columns from spec', () => {
    const meta = metaFor(ManufacturingBomItem)
    const props = Object.keys(meta.properties)
    expect(props).toEqual(expect.arrayContaining([
      'bomId',
      'componentProductId',
      'componentVariantId',
      'qtyPerUnit',
      'uom',
      'scrapFactor',
      'isPhantom',
      'operationSequence',
    ]))
  })
})

describe('Routing entity', () => {
  it('maps to manufacturing_routings table', () => {
    const meta = metaFor(Routing)
    expect(meta.tableName).toBe('manufacturing_routings')
  })

  it('has standard tenant/org/audit columns', () => {
    expectStandardColumns(Routing)
  })

  it('has a unique constraint on tenant/org/product/variant/version', () => {
    const meta = metaFor(Routing)
    expect(meta.uniques.length).toBeGreaterThan(0)
    const properties = meta.uniques.flatMap((u: any) => u.properties)
    expect(properties).toEqual(expect.arrayContaining(['tenantId', 'organizationId', 'productId', 'variantId', 'version']))
  })
})

describe('RoutingOperation entity', () => {
  it('maps to manufacturing_routing_operations table', () => {
    const meta = metaFor(RoutingOperation)
    expect(meta.tableName).toBe('manufacturing_routing_operations')
  })

  it('has standard tenant/org/audit columns', () => {
    expectStandardColumns(RoutingOperation)
  })

  it('has key columns from spec', () => {
    const meta = metaFor(RoutingOperation)
    const props = Object.keys(meta.properties)
    expect(props).toEqual(expect.arrayContaining([
      'routingId',
      'sequence',
      'name',
      'workCenterId',
      'setupTimeMinutes',
      'runTimePerUnitSeconds',
      'isReportingPoint',
    ]))
  })
})

describe('ProductPlanningParams entity', () => {
  it('maps to manufacturing_planning_params table', () => {
    const meta = metaFor(ProductPlanningParams)
    expect(meta.tableName).toBe('manufacturing_planning_params')
  })

  it('has standard tenant/org/audit columns', () => {
    expectStandardColumns(ProductPlanningParams)
  })

  it('has key columns from spec', () => {
    const meta = metaFor(ProductPlanningParams)
    const props = Object.keys(meta.properties)
    expect(props).toEqual(expect.arrayContaining([
      'productId',
      'variantId',
      'procurement',
      'leadTimeDays',
      'minLot',
      'lotMultiple',
      'safetyStock',
      'backflush',
    ]))
  })

  it('has a unique constraint scoped per tenant/org/product/variant', () => {
    const meta = metaFor(ProductPlanningParams)
    expect(meta.uniques.length).toBeGreaterThan(0)
    const properties = meta.uniques.flatMap((u: any) => u.properties)
    expect(properties).toEqual(expect.arrayContaining(['tenantId', 'organizationId', 'productId', 'variantId']))
  })
})

describe('ManufacturingOrder entity', () => {
  it('maps to manufacturing_orders table', () => {
    const meta = metaFor(ManufacturingOrder)
    expect(meta.tableName).toBe('manufacturing_orders')
  })

  it('has standard tenant/org/audit columns', () => {
    expectStandardColumns(ManufacturingOrder)
  })

  it('has key columns from spec', () => {
    const meta = metaFor(ManufacturingOrder)
    const props = Object.keys(meta.properties)
    expect(props).toEqual(expect.arrayContaining([
      'number',
      'productId',
      'variantId',
      'qtyPlanned',
      'uom',
      'dueDate',
      'priority',
      'status',
      'sourceType',
      'sourceId',
      'bomVersionId',
      'routingVersionId',
      'releasedAt',
      'qtyCompleted',
      'qtyScrapped',
    ]))
  })

  it('has a unique constraint on tenant/org/number', () => {
    const meta = metaFor(ManufacturingOrder)
    expect(meta.uniques.length).toBeGreaterThan(0)
    const properties = meta.uniques.flatMap((u: any) => u.properties)
    expect(properties).toEqual(expect.arrayContaining(['tenantId', 'organizationId', 'number']))
  })
})

describe('ManufacturingOrderOperation entity', () => {
  it('maps to manufacturing_order_operations table', () => {
    const meta = metaFor(ManufacturingOrderOperation)
    expect(meta.tableName).toBe('manufacturing_order_operations')
  })

  it('has standard tenant/org/audit columns', () => {
    expectStandardColumns(ManufacturingOrderOperation)
  })

  it('has key columns from spec, incl. the traceability-only sourceOperationId', () => {
    const meta = metaFor(ManufacturingOrderOperation)
    const props = Object.keys(meta.properties)
    expect(props).toEqual(expect.arrayContaining([
      'orderId',
      'sequence',
      'name',
      'workCenterId',
      'setupTimeMinutes',
      'runTimePerUnitSeconds',
      'isReportingPoint',
      'status',
      'qtyGood',
      'qtyScrap',
      'sourceOperationId',
    ]))
  })
})

describe('ManufacturingOrderMaterial entity', () => {
  it('maps to manufacturing_order_materials table', () => {
    const meta = metaFor(ManufacturingOrderMaterial)
    expect(meta.tableName).toBe('manufacturing_order_materials')
  })

  it('has standard tenant/org/audit columns', () => {
    expectStandardColumns(ManufacturingOrderMaterial)
  })

  it('has key columns from spec, incl. the traceability-only sourceBomItemId', () => {
    const meta = metaFor(ManufacturingOrderMaterial)
    const props = Object.keys(meta.properties)
    expect(props).toEqual(expect.arrayContaining([
      'orderId',
      'operationSequence',
      'componentProductId',
      'componentVariantId',
      'qtyRequired',
      'uom',
      'scrapFactor',
      'qtyIssued',
      'sourceBomItemId',
    ]))
  })
})

describe('manufacturing:work_center entity extension link', () => {
  it('references the generated entity id (manufacturing:work_center, not the table name)', () => {
    // Entity ids derive from toSnake(className), not the table name: WorkCenter -> 'manufacturing:work_center'.
    // Locks against the regression fixed in review (extensions.ts previously used 'manufacturing:manufacturing_work_center').
    expect(E.manufacturing.work_center).toBe('manufacturing:work_center')
    const link = extensions.find((e) => e.base === 'planner:planner_availability_rule_set')
    expect(link?.extension).toBe('manufacturing:work_center')
    expect(link?.extension).toBe(E.manufacturing.work_center)
  })
})


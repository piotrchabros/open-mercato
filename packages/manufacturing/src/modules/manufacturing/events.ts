import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Typed event declarations for the manufacturing module (spec § Events).
 * Declared up front as part of the module contract; emitters arrive with
 * their phases (technology P1, stock P2, orders P3, reports P4, MRP P5).
 */
const events = [
  // Technology (Phase 1)
  { id: 'manufacturing.work_center.created', label: 'Work Center Created', entity: 'work_center', category: 'crud' },
  { id: 'manufacturing.work_center.updated', label: 'Work Center Updated', entity: 'work_center', category: 'crud' },
  { id: 'manufacturing.work_center.deleted', label: 'Work Center Deleted', entity: 'work_center', category: 'crud' },
  { id: 'manufacturing.bom.created', label: 'BOM Created', entity: 'bom', category: 'crud' },
  { id: 'manufacturing.bom.updated', label: 'BOM Updated', entity: 'bom', category: 'crud' },
  { id: 'manufacturing.bom.deleted', label: 'BOM Deleted', entity: 'bom', category: 'crud' },
  { id: 'manufacturing.bom.activated', label: 'BOM Version Activated', entity: 'bom', category: 'lifecycle' },
  { id: 'manufacturing.routing.created', label: 'Routing Created', entity: 'routing', category: 'crud' },
  { id: 'manufacturing.routing.updated', label: 'Routing Updated', entity: 'routing', category: 'crud' },
  { id: 'manufacturing.routing.deleted', label: 'Routing Deleted', entity: 'routing', category: 'crud' },
  { id: 'manufacturing.routing.activated', label: 'Routing Version Activated', entity: 'routing', category: 'lifecycle' },
  // Stock ledger (Phase 2)
  { id: 'manufacturing.stock_movement.created', label: 'Stock Movement Created', entity: 'stock_movement', category: 'lifecycle' },
  // Orders (Phase 3)
  { id: 'manufacturing.order.created', label: 'Manufacturing Order Created', entity: 'order', category: 'crud' },
  { id: 'manufacturing.order.updated', label: 'Manufacturing Order Updated', entity: 'order', category: 'crud' },
  { id: 'manufacturing.order.deleted', label: 'Manufacturing Order Deleted', entity: 'order', category: 'crud' },
  { id: 'manufacturing.order.released', label: 'Manufacturing Order Released', entity: 'order', category: 'lifecycle' },
  { id: 'manufacturing.order.completed', label: 'Manufacturing Order Completed', entity: 'order', category: 'lifecycle' },
  { id: 'manufacturing.order.cancelled', label: 'Manufacturing Order Cancelled', entity: 'order', category: 'lifecycle' },
  // Shop-floor reports (Phase 4)
  { id: 'manufacturing.report.created', label: 'Manufacturing Report Created', entity: 'report', category: 'lifecycle' },
  { id: 'manufacturing.report.reversed', label: 'Manufacturing Report Reversed', entity: 'report', category: 'lifecycle' },
  // MRP (Phase 5)
  { id: 'manufacturing.mrp_run.completed', label: 'MRP Run Completed', entity: 'mrp_run', category: 'lifecycle', clientBroadcast: true },
  { id: 'manufacturing.mrp_suggestion.accepted', label: 'MRP Suggestion Accepted', entity: 'mrp_suggestion', category: 'lifecycle' },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'manufacturing',
  events,
})

/** Type-safe event emitter for the manufacturing module */
export const emitManufacturingEvent = eventsConfig.emit

/** Event IDs that can be emitted by the manufacturing module */
export type ManufacturingEventId = typeof events[number]['id']

export default eventsConfig

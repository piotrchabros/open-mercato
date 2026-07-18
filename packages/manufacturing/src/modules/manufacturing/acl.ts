/**
 * Feature flags for the manufacturing module.
 *
 * Ids are immutable contract surfaces (spec § Access Control). The operator
 * surface deliberately has its own minimal pair so shared shop-floor devices
 * can run a role that exposes nothing beyond the work queue (spec decision e).
 */
export const features = [
  { id: 'manufacturing.technology.view', title: 'View technology (BOMs, routings, work centers)', module: 'manufacturing' },
  { id: 'manufacturing.technology.manage', title: 'Manage technology (BOMs, routings, work centers)', module: 'manufacturing' },
  { id: 'manufacturing.stock.view', title: 'View manufacturing stock', module: 'manufacturing' },
  { id: 'manufacturing.stock.manage', title: 'Manage manufacturing stock (receipts, issues, adjustments)', module: 'manufacturing' },
  { id: 'manufacturing.orders.view', title: 'View manufacturing orders', module: 'manufacturing' },
  { id: 'manufacturing.orders.manage', title: 'Manage manufacturing orders', module: 'manufacturing' },
  { id: 'manufacturing.reports.view', title: 'View manufacturing reports', module: 'manufacturing' },
  { id: 'manufacturing.reports.manage', title: 'Manage manufacturing reports', module: 'manufacturing' },
  { id: 'manufacturing.operator.view', title: 'View operator work queue', module: 'manufacturing' },
  { id: 'manufacturing.operator.report', title: 'Report operations from the shop floor', module: 'manufacturing' },
  { id: 'manufacturing.mrp.view', title: 'View MRP runs and suggestions', module: 'manufacturing' },
  { id: 'manufacturing.mrp.manage', title: 'Run MRP and manage suggestions', module: 'manufacturing' },
]

export default features

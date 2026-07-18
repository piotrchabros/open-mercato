import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/**
 * Soft sales integration (spec § Sales integration): a "Manufacturing" tab
 * injected into the sales order detail's tab spot only (not the quote
 * spot — manufacturing orders only ever originate from placed orders).
 * Mirrors the shape of `sales.injection.document-history` at the same
 * spot (`packages/core/src/modules/sales/widgets/injection-table.ts`).
 */
export const injectionTable: ModuleInjectionTable = {
  'sales.document.detail.order:tabs': [
    {
      widgetId: 'manufacturing.injection.order-manufacturing-tab',
      kind: 'tab',
      groupLabel: 'manufacturing.injection.tab.label',
      priority: 60,
    },
  ],
}

export default injectionTable

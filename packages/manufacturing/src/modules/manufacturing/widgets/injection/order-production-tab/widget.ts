import type { InjectionWidgetModule } from '@open-mercato/shared/modules/widgets/injection'
import OrderManufacturingTabWidget from './widget.client'

/**
 * Feature-gated: `manufacturing.orders.manage` covers both viewing the tab's
 * manufacturing-order list and creating new draft orders from make-flagged
 * lines (the widget offers no read-only vs write-only split at the ACL
 * layer — a caller without this feature never sees the tab widget load).
 * Tenant-runtime gating (the `manufacturing_enabled` toggle, which is
 * per-tenant and can't be expressed as a static ACL feature) is enforced
 * inside the client widget itself — see widget.client.tsx.
 */
const widget: InjectionWidgetModule = {
  metadata: {
    id: 'manufacturing.injection.order-manufacturing-tab',
    title: 'Manufacturing',
    description: 'Manufacturing orders linked to this sales order, and drafting new ones from make-flagged lines',
    features: ['manufacturing.orders.manage'],
    priority: 60,
  },
  Widget: OrderManufacturingTabWidget,
}

export default widget

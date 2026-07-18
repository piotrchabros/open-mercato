import type { RouteVisibilityContext } from '@open-mercato/shared/modules/registry'
import { isManufacturingEnabledForTenant } from '../../../../lib/manufacturingToggle'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['manufacturing.orders.view'],
  visible: (ctx: RouteVisibilityContext) => isManufacturingEnabledForTenant(ctx.auth?.tenantId ?? null),
  pageTitle: 'Manufacturing Order',
  pageTitleKey: 'manufacturing.orders.detail.title',
  pageGroup: 'Manufacturing',
  pageGroupKey: 'manufacturing.nav.group',
  breadcrumb: [
    { label: 'Manufacturing', labelKey: 'manufacturing.nav.title' },
    { label: 'Manufacturing Orders', labelKey: 'manufacturing.orders.title' },
    { label: 'Detail', labelKey: 'manufacturing.orders.detail.title' },
  ],
} as const

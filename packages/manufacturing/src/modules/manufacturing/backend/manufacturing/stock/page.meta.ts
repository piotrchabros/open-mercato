import type { RouteVisibilityContext } from '@open-mercato/shared/modules/registry'
import { isManufacturingEnabledForTenant } from '../../../lib/manufacturingToggle'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['manufacturing.stock.view'],
  visible: (ctx: RouteVisibilityContext) => isManufacturingEnabledForTenant(ctx.auth?.tenantId ?? null),
  pageTitle: 'Stock',
  pageTitleKey: 'manufacturing.stock.title',
  pageGroup: 'Manufacturing',
  pageGroupKey: 'manufacturing.nav.group',
  pageOrder: 25,
  breadcrumb: [
    { label: 'Manufacturing', labelKey: 'manufacturing.nav.title' },
    { label: 'Stock', labelKey: 'manufacturing.stock.title' },
  ],
} as const

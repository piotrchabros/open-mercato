import type { RouteVisibilityContext } from '@open-mercato/shared/modules/registry'
import { isManufacturingEnabledForTenant } from '../../../lib/manufacturingToggle'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['manufacturing.mrp.view'],
  visible: (ctx: RouteVisibilityContext) => isManufacturingEnabledForTenant(ctx.auth?.tenantId ?? null),
  pageTitle: 'MRP Runs',
  pageTitleKey: 'manufacturing.mrp.title',
  pageGroup: 'Manufacturing',
  pageGroupKey: 'manufacturing.nav.group',
  pageOrder: 55,
  breadcrumb: [
    { label: 'Manufacturing', labelKey: 'manufacturing.nav.title' },
    { label: 'MRP Runs', labelKey: 'manufacturing.mrp.title' },
  ],
} as const

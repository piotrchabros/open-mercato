import type { RouteVisibilityContext } from '@open-mercato/shared/modules/registry'
import { isManufacturingEnabledForTenant } from '../../../../../lib/manufacturingToggle'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['manufacturing.mrp.view'],
  visible: (ctx: RouteVisibilityContext) => isManufacturingEnabledForTenant(ctx.auth?.tenantId ?? null),
  pageTitle: 'MRP Run Suggestions',
  pageTitleKey: 'manufacturing.mrp.suggestions.title',
  pageGroup: 'Manufacturing',
  pageGroupKey: 'manufacturing.nav.group',
  breadcrumb: [
    { label: 'Manufacturing', labelKey: 'manufacturing.nav.title' },
    { label: 'MRP Runs', labelKey: 'manufacturing.mrp.title' },
    { label: 'Suggestions', labelKey: 'manufacturing.mrp.suggestions.title' },
  ],
} as const

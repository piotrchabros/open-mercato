import type { RouteVisibilityContext } from '@open-mercato/shared/modules/registry'
import { isManufacturingEnabledForTenant } from '../../../lib/manufacturingToggle'

/**
 * MVP analytics/reports page (task 6.1, spec § Scope: quantity-based-only
 * reports, no valuation). Gated on `manufacturing.reports.view` — the same
 * read-only oversight feature the shop-floor reports list already uses.
 */
export const metadata = {
  requireAuth: true,
  requireFeatures: ['manufacturing.reports.view'],
  visible: (ctx: RouteVisibilityContext) => isManufacturingEnabledForTenant(ctx.auth?.tenantId ?? null),
  pageTitle: 'Reports & Analytics',
  pageTitleKey: 'manufacturing.analytics.title',
  pageGroup: 'Manufacturing',
  pageGroupKey: 'manufacturing.nav.group',
  pageOrder: 70,
  breadcrumb: [
    { label: 'Manufacturing', labelKey: 'manufacturing.nav.title' },
    { label: 'Reports & Analytics', labelKey: 'manufacturing.analytics.title' },
  ],
} as const

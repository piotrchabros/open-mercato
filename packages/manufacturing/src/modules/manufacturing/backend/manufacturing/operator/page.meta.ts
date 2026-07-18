import type { RouteVisibilityContext } from '@open-mercato/shared/modules/registry'
import { isManufacturingEnabledForTenant } from '../../../lib/manufacturingToggle'

/**
 * Operator "lite" panel (task 4.3, spec decision e): the shop-floor surface
 * gated on `manufacturing.operator.view` ONLY, so a shared tablet/device
 * logged in as the `operator` role sees nothing beyond this page.
 */
export const metadata = {
  requireAuth: true,
  requireFeatures: ['manufacturing.operator.view'],
  visible: (ctx: RouteVisibilityContext) => isManufacturingEnabledForTenant(ctx.auth?.tenantId ?? null),
  pageTitle: 'Operator',
  pageTitleKey: 'manufacturing.operator.title',
  pageGroup: 'Manufacturing',
  pageGroupKey: 'manufacturing.nav.group',
  pageOrder: 60,
  breadcrumb: [
    { label: 'Manufacturing', labelKey: 'manufacturing.nav.title' },
    { label: 'Operator', labelKey: 'manufacturing.operator.title' },
  ],
} as const

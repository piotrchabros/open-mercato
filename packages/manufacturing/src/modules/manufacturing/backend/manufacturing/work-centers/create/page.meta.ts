import type { RouteVisibilityContext } from '@open-mercato/shared/modules/registry'
import { isManufacturingEnabledForTenant } from '../../../../lib/manufacturingToggle'

export const metadata = {
  requireAuth: true,
  requireFeatures: ['manufacturing.technology.manage'],
  visible: (ctx: RouteVisibilityContext) => isManufacturingEnabledForTenant(ctx.auth?.tenantId ?? null),
  pageTitle: 'Create work center',
  pageTitleKey: 'manufacturing.work_centers.create.title',
  pageGroup: 'Manufacturing',
  pageGroupKey: 'manufacturing.nav.group',
  pageOrder: 21,
  breadcrumb: [
    { label: 'Manufacturing', labelKey: 'manufacturing.nav.title' },
    { label: 'Work Centers', labelKey: 'manufacturing.work_centers.title' },
    { label: 'Create', labelKey: 'manufacturing.work_centers.create.title' },
  ],
} as const

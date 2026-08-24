export const metadata = {
  requireAuth: true,
  requireFeatures: ['connect_cost_reporting.view'],
  pageTitle: 'Cost per contact',
  pageTitleKey: 'connect_cost_reporting.nav.title',
  pageGroup: 'Integrations',
  pageGroupKey: 'connect.nav.group',
  pageOrder: 33,
  icon: 'badge-dollar-sign',
  pageContext: 'main' as const,
  breadcrumb: [{ label: 'Cost per contact', labelKey: 'connect_cost_reporting.nav.title' }],
} as const

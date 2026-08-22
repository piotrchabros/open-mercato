export const metadata = {
  requireAuth: true,
  requireFeatures: ['connect.metrics.view'],
  pageTitle: 'Connect metrics',
  pageTitleKey: 'connect.metrics.nav.title',
  pageGroup: 'Integrations',
  pageGroupKey: 'connect.nav.group',
  pageOrder: 30,
  icon: 'chart-line',
  pageContext: 'main' as const,
  breadcrumb: [{ label: 'Connect metrics', labelKey: 'connect.metrics.nav.title' }],
} as const

export const metadata = {
  requireAuth: true,
  requireFeatures: ['connect.customer_match.read'],
  pageTitle: 'Customer matching',
  pageTitleKey: 'connect.customerMatch.nav.title',
  pageGroup: 'Integrations',
  pageGroupKey: 'connect.nav.group',
  pageOrder: 20,
  icon: 'user-check',
  pageContext: 'main' as const,
  breadcrumb: [{ label: 'Customer matching', labelKey: 'connect.customerMatch.nav.title' }],
} as const

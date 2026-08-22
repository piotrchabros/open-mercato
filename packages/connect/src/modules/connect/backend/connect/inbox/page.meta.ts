export const metadata = {
  requireAuth: true,
  requireFeatures: ['connect.inbox.handle'],
  pageTitle: 'Connect inbox',
  pageTitleKey: 'connect.inbox.nav.title',
  pageGroup: 'Integrations',
  pageGroupKey: 'connect.nav.group',
  pageOrder: 10,
  icon: 'inbox',
  pageContext: 'main' as const,
  breadcrumb: [{ label: 'Connect inbox', labelKey: 'connect.inbox.nav.title' }],
} as const

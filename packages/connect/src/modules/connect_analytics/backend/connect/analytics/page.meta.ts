/**
 * Coexists with `/backend/connect/metrics`; it does not replace it.
 *
 * Metrics stays the operational and recovery surface — exceptions, rebuild,
 * the things an operator DOES. Analytics is read-only trend reporting and never
 * links to a rebuild. Distinct order (30 vs 31) so both are reachable and
 * neither aliases the other.
 */
export const metadata = {
  requireAuth: true,
  requireFeatures: ['connect_analytics.view'],
  pageTitle: 'Connect analytics',
  pageTitleKey: 'connect_analytics.nav.title',
  pageGroup: 'Integrations',
  pageGroupKey: 'connect.nav.group',
  pageOrder: 31,
  icon: 'chart-no-axes-combined',
  pageContext: 'main' as const,
  breadcrumb: [{ label: 'Connect analytics', labelKey: 'connect_analytics.nav.title' }],
} as const

export const metadata = {
  requireAuth: true,
  requireFeatures: ['connect_analytics.cost_inputs.manage'],
  pageTitle: 'Record cost input',
  pageTitleKey: 'connect_analytics.costInputs.create.title',
  pageGroup: 'Integrations',
  pageGroupKey: 'connect.nav.group',
  navHidden: true,
  breadcrumb: [
    { label: 'Cost inputs', labelKey: 'connect_analytics.costInputs.nav.title', href: '/backend/connect/analytics/cost-inputs' },
    { label: 'Record cost input', labelKey: 'connect_analytics.costInputs.create.title' },
  ],
}

export default metadata

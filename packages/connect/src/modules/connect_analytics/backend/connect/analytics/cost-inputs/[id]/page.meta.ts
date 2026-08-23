export const metadata = {
  requireAuth: true,
  requireFeatures: ['connect_analytics.cost_inputs.manage'],
  pageTitle: 'Edit cost input',
  pageTitleKey: 'connect_analytics.costInputs.edit.title',
  pageGroup: 'Integrations',
  pageGroupKey: 'connect.nav.group',
  navHidden: true,
  breadcrumb: [
    { label: 'Cost inputs', labelKey: 'connect_analytics.costInputs.nav.title', href: '/backend/connect/analytics/cost-inputs' },
    { label: 'Edit cost input', labelKey: 'connect_analytics.costInputs.edit.title' },
  ],
}

export default metadata

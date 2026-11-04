export const metadata = {
  requireAuth: true,
  requireFeatures: ['webhook_calcom.transcripts.view'],
  pageTitle: 'Unassigned transcripts',
  pageTitleKey: 'webhook_calcom.inbox.nav.title',
  pageGroup: 'Customers',
  pageGroupKey: 'customers.nav.group',
  pagePriority: 10,
  pageOrder: 130,
  icon: 'inbox',
  breadcrumb: [{ label: 'Unassigned transcripts', labelKey: 'webhook_calcom.inbox.nav.title' }],
}

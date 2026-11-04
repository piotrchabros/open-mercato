export const metadata = {
  requireAuth: true,
  requireFeatures: ['webhook_calcom.transcripts.view'],
  pageTitle: 'Unassigned transcript',
  pageTitleKey: 'webhook_calcom.inbox.detail.title',
  pageGroup: 'Customers',
  pageGroupKey: 'customers.nav.group',
  navHidden: true,
  breadcrumb: [
    { label: 'Unassigned transcripts', labelKey: 'webhook_calcom.inbox.nav.title', href: '/backend/unassigned-transcripts' },
    { label: 'Unassigned transcript', labelKey: 'webhook_calcom.inbox.detail.title' },
  ],
}

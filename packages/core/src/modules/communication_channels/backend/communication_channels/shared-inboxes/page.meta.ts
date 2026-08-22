export const metadata = {
  requireAuth: true,
  requireFeatures: ['communication_channels.shared_inbox.manage'],
  pageTitle: 'Shared inboxes',
  pageTitleKey: 'communication_channels.sharedInbox.nav.title',
  pageGroup: 'Integrations',
  pageGroupKey: 'communication_channels.nav.group',
  pageOrder: 91,
  icon: 'users',
  pageContext: 'main' as const,
  breadcrumb: [
    { label: 'Communication Channels', labelKey: 'communication_channels.nav.title' },
    { label: 'Shared inboxes', labelKey: 'communication_channels.sharedInbox.nav.title' },
  ],
} as const

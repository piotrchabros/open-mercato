import { SharedInboxesAdminPage } from '@open-mercato/core/modules/communication_channels/components/shared-inboxes/SharedInboxesAdminPage'

/**
 * Server-component page root (Frontend Architecture Contract): the route shell
 * stays a server component and mounts one client leaf, so the page's data
 * fetching and interactivity are the only client-side code on this route.
 */
export default function SharedInboxesPage() {
  return <SharedInboxesAdminPage />
}

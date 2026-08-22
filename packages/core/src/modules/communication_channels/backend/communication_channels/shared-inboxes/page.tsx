import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { SharedInboxesAdminPage } from '@open-mercato/core/modules/communication_channels/components/shared-inboxes/SharedInboxesAdminPage'

/**
 * Server-component page root (Frontend Architecture Contract): the route shell
 * and its page chrome stay server-rendered, and one client leaf carries the
 * data fetching and interactivity.
 */
export default function SharedInboxesPage() {
  return (
    <Page>
      <PageBody>
        <SharedInboxesAdminPage />
      </PageBody>
    </Page>
  )
}

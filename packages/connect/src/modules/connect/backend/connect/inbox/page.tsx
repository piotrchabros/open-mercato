import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { ConnectInboxPage } from '@open-mercato/connect/modules/connect/components/inbox/ConnectInboxPage'

/**
 * Server-component route shell.
 *
 * The identity and the two capability flags the Inbox branches on are resolved
 * here from RBAC, not from anything the browser sends. The API re-checks every
 * decision anyway, but building the UI as if the client could decide "can see
 * all" would make a filter look like a gate.
 */

type RbacServiceLike = {
  loadAcl: (
    userId: string,
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<{ isSuperAdmin: boolean; features: string[]; organizations: string[] | null }>
}

export default async function ConnectInboxRoute() {
  const auth = await getAuthFromCookies()
  const userId = (auth?.sub as string | undefined) ?? ''
  const tenantId = (auth?.tenantId as string | null) ?? null
  const organizationId = (auth?.orgId as string | null) ?? null

  let features: string[] = []
  if (userId && tenantId) {
    try {
      const container = await createRequestContainer()
      const rbac = container.resolve('rbacService') as RbacServiceLike
      const acl = await rbac.loadAcl(userId, { tenantId, organizationId })
      features = acl?.isSuperAdmin ? ['*'] : Array.isArray(acl?.features) ? acl.features : []
    } catch {
      // Fail closed: with no resolvable grants the Inbox renders in its most
      // restricted shape, and every API call still enforces the real rules.
      features = []
    }
  }

  const canSeeAll =
    features.includes('*') ||
    features.includes('connect.*') ||
    features.includes('connect.cases.view.all') ||
    features.includes('connect.cases.assign')
  const canClose =
    features.includes('*') || features.includes('connect.*') || features.includes('connect.cases.manage')

  return (
    <Page>
      <PageBody>
        <ConnectInboxPage currentUserId={userId} canSeeAll={canSeeAll} canClose={canClose} />
      </PageBody>
    </Page>
  )
}

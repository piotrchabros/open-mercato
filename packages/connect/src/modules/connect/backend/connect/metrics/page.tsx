import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { ConnectMetricsPage } from '@open-mercato/connect/modules/connect/components/metrics/ConnectMetricsPage'

/**
 * Server-component shell for the operations metrics screen.
 *
 * `connect.metrics.manage` is resolved here rather than inferred client-side.
 * It only decides whether the rebuild control renders; the route enforces it
 * again, because a hidden button is not an authorization boundary.
 */

type RbacServiceLike = {
  loadAcl: (
    userId: string,
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<{ isSuperAdmin: boolean; features: string[]; organizations: string[] | null }>
}

export default async function ConnectMetricsRoute() {
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
      // Fail closed: the screen renders read-only.
      features = []
    }
  }

  const canManage =
    features.includes('*') || features.includes('connect.*') || features.includes('connect.metrics.manage')

  return (
    <Page>
      <PageBody>
        <ConnectMetricsPage canManage={canManage} />
      </PageBody>
    </Page>
  )
}

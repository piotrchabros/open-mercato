import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { ConnectCustomerMatchPage } from '@open-mercato/connect/modules/connect/components/customer-match/ConnectCustomerMatchPage'

/**
 * Server-component shell for manual customer matching.
 *
 * The three capability flags are resolved from RBAC here, never inferred in the
 * browser. Every API the page calls re-checks them, so these only decide which
 * controls are worth rendering — but rendering an unlink button an agent cannot
 * use would make a denial look like a bug.
 */

type RbacServiceLike = {
  loadAcl: (
    userId: string,
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<{ isSuperAdmin: boolean; features: string[]; organizations: string[] | null }>
}

function hasFeature(features: string[], feature: string): boolean {
  return features.includes('*') || features.includes('connect.*') || features.includes(feature)
}

export default async function ConnectCustomerMatchRoute() {
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
      // Fail closed: with no resolvable grants the page renders read-only.
      features = []
    }
  }

  return (
    <Page>
      <PageBody>
        <ConnectCustomerMatchPage
          canLink={hasFeature(features, 'connect.customer_match.link')}
          canUnlink={hasFeature(features, 'connect.customer_match.unlink')}
          canRecover={hasFeature(features, 'connect.customer_match.recover')}
        />
      </PageBody>
    </Page>
  )
}

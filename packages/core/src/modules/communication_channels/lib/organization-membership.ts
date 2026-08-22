import type { EntityManager } from '@mikro-orm/postgresql'
import { authorizeFeatures } from '@open-mercato/shared/security/featurePolicy'
import { SHARED_INBOX_MANAGE_FEATURE } from './shared-inbox-authorization'

/**
 * Organization-membership probes used by shared-inbox administration
 * (Connect upstream Contract E).
 *
 * The hub does not own users or RBAC, so both probes go through the auth
 * module's `rbacService` and the shared `users` row rather than importing auth
 * business logic. `User` is referenced by entity-class NAME so no cross-module
 * ORM relationship is created — MikroORM resolves it through the generated
 * entity registry, the same technique the customers module uses to read hub
 * rows.
 */

type ContainerLike = {
  resolve: <T = unknown>(name: string) => T
}

type RbacServiceLike = {
  loadAcl: (
    userId: string,
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<{ isSuperAdmin: boolean; features: string[]; organizations: string[] | null }>
}

type UserRow = {
  id: string
  tenantId?: string | null
  deletedAt?: Date | null
  isConfirmed?: boolean
}

/**
 * True when `userId` is a live, confirmed user of `scope.tenantId` whose
 * organization visibility covers `scope.organizationId`.
 *
 * A membership grant to a user outside the owning organization would create an
 * authorization row that survives the user leaving the org, so this is checked
 * before every grant. Fails closed on any resolution error.
 */
export async function isActiveOrganizationMember(
  container: ContainerLike,
  em: EntityManager,
  userId: string,
  scope: { tenantId: string; organizationId: string },
): Promise<boolean> {
  const user = (await em.findOne('User' as never, { id: userId } as never)) as UserRow | null
  if (!user) return false
  if (user.deletedAt) return false
  if (user.isConfirmed === false) return false
  if (user.tenantId && user.tenantId !== scope.tenantId) return false

  try {
    const rbac = container.resolve<RbacServiceLike>('rbacService')
    const acl = await rbac.loadAcl(userId, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    })
    // `organizations: null` means unrestricted visibility (super-admin or an
    // unrestricted role grant) — such a user is a legitimate member of every
    // organization in the tenant.
    if (acl?.organizations == null) return true
    return acl.organizations.includes(scope.organizationId)
  } catch {
    return false
  }
}

/**
 * Feature that identifies an organization administrator. Shared-inbox
 * administration is deliberately gated on BOTH this and
 * `communication_channels.shared_inbox.manage`: the first says "you administer
 * this organization", the second says "you may administer its shared inboxes".
 * Splitting them lets policy hand shared-inbox setup to a channel operator
 * without also handing over organization administration, or vice versa.
 */
export const ORGANIZATION_ADMIN_FEATURE = 'directory.organizations.manage'

/**
 * True when `userId` holds an ACTIVE organization-admin scope over
 * `scope.organizationId` — that is, their ACL covers the organization AND they
 * hold {@link ORGANIZATION_ADMIN_FEATURE}. Super-admins qualify everywhere in
 * their tenant. Fails closed.
 */
export async function hasActiveOrganizationAdminScope(
  container: ContainerLike,
  userId: string,
  scope: { tenantId: string; organizationId: string },
): Promise<boolean> {
  try {
    const rbac = container.resolve<RbacServiceLike>('rbacService')
    const acl = await rbac.loadAcl(userId, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    })
    if (acl?.isSuperAdmin) return true
    // `organizations: null` means unrestricted visibility.
    if (acl?.organizations != null && !acl.organizations.includes(scope.organizationId)) return false
    const grantedFeatures = Array.isArray(acl?.features) ? acl.features : []
    return authorizeFeatures([ORGANIZATION_ADMIN_FEATURE], { grantedFeatures })
  } catch {
    return false
  }
}

/**
 * True when `userId` effectively holds `communication_channels.shared_inbox.manage`
 * in the given scope. Wildcard-aware: a role granted `communication_channels.*`
 * counts, which is why this never string-compares the raw feature array.
 *
 * Used by the last-manager protection on revoke. Fails closed.
 */
export async function holdsSharedInboxManage(
  container: ContainerLike,
  userId: string,
  scope: { tenantId: string; organizationId: string },
): Promise<boolean> {
  try {
    const rbac = container.resolve<RbacServiceLike>('rbacService')
    const acl = await rbac.loadAcl(userId, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    })
    if (acl?.isSuperAdmin) return true
    const grantedFeatures = Array.isArray(acl?.features) ? acl.features : []
    return authorizeFeatures([SHARED_INBOX_MANAGE_FEATURE], { grantedFeatures })
  } catch {
    return false
  }
}

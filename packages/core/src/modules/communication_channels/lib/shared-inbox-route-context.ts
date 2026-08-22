import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer, type AppContainer } from '@open-mercato/shared/lib/di/container'
import { hasActiveOrganizationAdminScope } from './organization-membership'

/**
 * Request-context resolution for every shared-inbox route (Connect upstream
 * Contract E).
 *
 * Everything the authorization rule consumes — user, tenant, organization,
 * granted features, organization-admin scope — is derived HERE from the
 * authenticated session. Routes never read any of it from a request body, so a
 * browser payload cannot grant shared-channel authority.
 */

type RbacServiceLike = {
  loadAcl: (
    userId: string,
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<{ isSuperAdmin: boolean; features: string[]; organizations: string[] | null }>
}

export type SharedInboxAdminContext = {
  container: AppContainer
  auth: Record<string, unknown>
  actor: {
    userId: string
    tenantId: string
    organizationId: string
    features: string[]
    isOrganizationAdmin: boolean
  }
}

export type SharedInboxAdminContextResult =
  | { ok: true; context: SharedInboxAdminContext }
  | { ok: false; response: Response }

/**
 * Resolve the administrative actor for a shared-inbox route.
 *
 * A shared inbox is organization-owned, so an administrator with no selected
 * organization has no scope to act in — that is a 400, not a silent tenant-wide
 * fallback which would let one organization's admin touch another's inbox.
 */
export async function resolveSharedInboxAdminContext(
  req: Request,
): Promise<SharedInboxAdminContextResult> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth?.tenantId) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const organizationId = (auth as { orgId?: string | null }).orgId ?? null
  if (!organizationId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Select an organization to administer its shared inboxes.', code: 'organization_required' },
        { status: 400 },
      ),
    }
  }

  const container = await createRequestContainer()
  const scope = { tenantId: auth.tenantId as string, organizationId }

  let features: string[] = []
  try {
    const rbac = container.resolve('rbacService') as RbacServiceLike
    const acl = await rbac.loadAcl(auth.sub as string, scope)
    features = acl?.isSuperAdmin ? ['*'] : Array.isArray(acl?.features) ? acl.features : []
  } catch {
    features = []
  }

  const isOrganizationAdmin = await hasActiveOrganizationAdminScope(
    container,
    auth.sub as string,
    scope,
  )

  return {
    ok: true,
    context: {
      container,
      auth: auth as unknown as Record<string, unknown>,
      actor: {
        userId: auth.sub as string,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        features,
        isOrganizationAdmin,
      },
    },
  }
}

/**
 * Uniform masking for every administrative denial.
 *
 * `forbidden` and `not_found` deliberately produce the SAME 404 body: an actor
 * without shared-inbox administration must not be able to use the response to
 * learn that a given channel id exists in this organization.
 */
export function sharedInboxDenialResponse(): Response {
  return NextResponse.json({ error: 'Shared inbox not found' }, { status: 404 })
}

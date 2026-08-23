import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer, type AppContainer } from '@open-mercato/shared/lib/di/container'
import type { CaseActor } from './case-access'

/**
 * Request-context resolution for every Inbox route.
 *
 * Tenant, organization and effective features are all server-derived. Nothing
 * an agent's browser sends can widen what they see: the Case access matrix
 * consumes only what is resolved here.
 */

type RbacServiceLike = {
  loadAcl: (
    userId: string,
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<{ isSuperAdmin: boolean; features: string[]; organizations: string[] | null }>
}

export type InboxContext = {
  container: AppContainer
  auth: Record<string, unknown>
  actor: CaseActor
}

export type InboxContextResult = { ok: true; context: InboxContext } | { ok: false; response: Response }

export async function resolveInboxContext(req: Request): Promise<InboxContextResult> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth?.tenantId) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  const organizationId = (auth as { orgId?: string | null }).orgId ?? null
  // Every Connect row is organization-scoped, so a caller with no selected
  // organization has no scope at all. Falling back to the tenant would show one
  // organization's customer conversations to another's agents.
  if (!organizationId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Select an organization to use the Connect inbox.', code: 'organization_required' },
        { status: 400 },
      ),
    }
  }

  const container = await createRequestContainer()
  let features: string[] = []
  try {
    const rbac = container.resolve('rbacService') as RbacServiceLike
    const acl = await rbac.loadAcl(auth.sub as string, {
      tenantId: auth.tenantId as string,
      organizationId,
    })
    features = acl?.isSuperAdmin ? ['*'] : Array.isArray(acl?.features) ? acl.features : []
  } catch {
    features = []
  }

  return {
    ok: true,
    context: {
      container,
      auth: auth as unknown as Record<string, unknown>,
      actor: {
        userId: auth.sub as string,
        tenantId: auth.tenantId as string,
        organizationId,
        features,
      },
    },
  }
}

/**
 * The single denial shape. A Case in another organization, a Case owned by
 * another agent, and a Case that does not exist are all 404 — telling an agent
 * which one it was is itself information about the organization's traffic.
 */
export function inboxNotFound(): Response {
  return NextResponse.json({ error: 'Case not found' }, { status: 404 })
}

/**
 * The single response shape for "this Case was merged away".
 *
 * Unlike a 404 this deliberately DOES disclose something — the canonical
 * target's id — because the caller has already passed the visibility check for
 * the source, and the two Cases are in the same organization by construction.
 * Withholding the target would leave an agent staring at a Case they cannot act
 * on with no way to find the conversation.
 */
export function caseMergedConflict(canonicalCaseId: string): Response {
  return NextResponse.json(
    {
      error: 'record_conflict',
      code: 'case_merged',
      canonicalCaseId,
    },
    { status: 409 },
  )
}

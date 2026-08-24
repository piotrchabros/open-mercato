import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer, type AppContainer } from '@open-mercato/shared/lib/di/container'
import type { ConnectCaseSlaReader } from '../../connect/lib/sla-source-reader'

export type ClockRouteContext = {
  container: AppContainer
  tenantId: string
  organizationId: string
  userId: string
  features: string[]
  reader: ConnectCaseSlaReader
}

export async function resolveClockRouteContext(req: Request): Promise<{ ok: true; value: ClockRouteContext } | { ok: false; response: Response }> {
  const auth = await getAuthFromRequest(req)
  if (!auth?.sub || !auth.tenantId) return { ok: false, response: apiError(401, 'unauthorized', 'Unauthorized') }
  const organizationId = auth.orgId ?? null
  if (!organizationId) return { ok: false, response: apiError(400, 'organization_scope_required', 'Organization context is required') }
  const container = await createRequestContainer()
  let reader: ConnectCaseSlaReader | null = null
  try {
    const registered = container as { hasRegistration?: (name: string) => boolean }
    if (registered.hasRegistration?.('connectCaseSlaReader')) reader = container.resolve('connectCaseSlaReader') as ConnectCaseSlaReader
  } catch {
    reader = null
  }
  if (!reader) return { ok: false, response: apiError(503, 'dependency_unavailable', 'Connect case access is unavailable') }
  return {
    ok: true,
    value: {
      container,
      tenantId: auth.tenantId,
      organizationId,
      userId: auth.sub,
      features: Array.isArray(auth.features) ? auth.features : [],
      reader,
    },
  }
}

export function apiError(status: number, code: string, error: string): Response {
  return NextResponse.json({ error, code }, { status })
}

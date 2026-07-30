// Build backend (admin) URLs that honor an organization's custom domain (#4271).
//
// The sibling of urlForCustomerOrg, for the admin app. Use it from senders that
// run OUTSIDE a request — queue workers, event subscribers, CLI commands — where
// there is no Host header to derive the organization from. Request-scoped code
// should keep using getSecurityEmailBaseUrl, which now prefers the request's own
// (allowlisted) origin and needs no orgId.

import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { backendCustomDomainsUsable } from '@open-mercato/core/modules/customer_accounts/lib/backendCustomDomains'

const logger = createLogger('customer_accounts').child({ component: 'backend-url' })

type DomainMappingService = {
  resolveActiveByOrg(orgId: string, target?: 'portal' | 'backend'): Promise<{ hostname: string } | null>
}

function platformBaseUrl(): string {
  const fromEnv = process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/+$/, '')
  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_URL is required in production. Configure it before sending backend links.')
  }
  return 'http://localhost:3000'
}

/**
 * Absolute backend URL for an organization.
 *
 * Falls back to the platform host when the organization has no active backend
 * domain, when `orgId` is unknown, or when resolution fails — a platform link
 * beats a broken one. Unlike urlForCustomerOrg, a failure is logged at warn
 * rather than swallowed silently; a link quietly pointing at the wrong host is
 * the kind of thing that should leave a trace.
 *
 * The lookup is target-filtered. Without that, an admin invite would happily
 * resolve to the organization's storefront domain.
 */
export async function urlForOrgBackend(
  orgId: string | null | undefined,
  path: string,
  options?: { container?: AppContainer },
): Promise<string> {
  const safePath = path.startsWith('/') ? path : `/${path}`
  const platform = platformBaseUrl()

  if (!orgId || !backendCustomDomainsUsable()) return `${platform}${safePath}`

  try {
    const container = options?.container ?? (await createRequestContainer())
    if (!container.hasRegistration('domainMappingService')) return `${platform}${safePath}`
    const service = container.resolve('domainMappingService') as DomainMappingService
    const active = await service.resolveActiveByOrg(orgId, 'backend')
    if (active?.hostname) return `https://${active.hostname}${safePath}`
  } catch (err) {
    logger.warn('Falling back to the platform host for a backend link', { orgId, err })
  }

  return `${platform}${safePath}`
}

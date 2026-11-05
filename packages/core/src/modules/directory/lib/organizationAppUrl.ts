import type { EntityManager } from '@mikro-orm/postgresql'
import { runWithCacheTenant } from '@open-mercato/cache'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  getSecurityEmailBaseUrl,
  isAllowedAppOrigin,
  type OrganizationAppUrlResolver,
} from '@open-mercato/shared/lib/url'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import { resolveIsSuperAdmin } from '@open-mercato/core/modules/auth/lib/tenantAccess'
import { Organization } from '@open-mercato/core/modules/directory/data/entities'
import { ORGANIZATION_MANAGE_APP_URL_FEATURE } from '@open-mercato/core/modules/directory/constants'

const logger = createLogger('directory').child({ component: 'organization-app-url' })

const UUID_SHAPE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const warnedDisallowedOrganizationIds = new Set<string>()

export const ORGANIZATION_APP_URL_CACHE_TTL_MS = 60_000

export function organizationAppUrlCacheTag(organizationId: string): string {
  return `directory:organization:${organizationId}:app_url`
}

export function organizationAppUrlCacheKey(organizationId: string): string {
  return `directory:organization-app-url:${organizationId}`
}

export type OrganizationAppUrlCache = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, options?: { ttl?: number; tags?: string[] }): Promise<void>
  deleteByTags(tags: string[]): Promise<number>
}

type CachedOrganizationAppUrl = { appUrl: string | null }

function isCachedOrganizationAppUrl(value: unknown): value is CachedOrganizationAppUrl {
  if (!value || typeof value !== 'object') return false
  const appUrl = (value as Record<string, unknown>).appUrl
  return appUrl === null || typeof appUrl === 'string'
}

export function createOrganizationAppUrlResolver(deps: {
  em: EntityManager
  cache?: OrganizationAppUrlCache | null
  env?: Record<string, string | undefined>
}): OrganizationAppUrlResolver {
  const cache = deps.cache ?? null
  const env = deps.env ?? process.env

  async function readCached(organizationId: string): Promise<CachedOrganizationAppUrl | null> {
    if (!cache) return null
    try {
      const cached = await runWithCacheTenant(null, () => cache.get(organizationAppUrlCacheKey(organizationId)))
      return isCachedOrganizationAppUrl(cached) ? cached : null
    } catch {
      return null
    }
  }

  async function writeCached(organizationId: string, value: CachedOrganizationAppUrl): Promise<void> {
    if (!cache) return
    try {
      await runWithCacheTenant(null, () =>
        cache.set(organizationAppUrlCacheKey(organizationId), value, {
          ttl: ORGANIZATION_APP_URL_CACHE_TTL_MS,
          tags: [organizationAppUrlCacheTag(organizationId)],
        }),
      )
    } catch {
      return
    }
  }

  async function readStoredAppUrl(organizationId: string): Promise<string | null> {
    const cached = await readCached(organizationId)
    if (cached) return cached.appUrl
    const organization = await findOneWithDecryption(
      deps.em.fork(),
      Organization,
      { id: organizationId, deletedAt: null },
      undefined,
      { tenantId: null, organizationId },
    )
    const appUrl = typeof organization?.appUrl === 'string' && organization.appUrl.length > 0
      ? organization.appUrl
      : null
    await writeCached(organizationId, { appUrl })
    return appUrl
  }

  async function resolveOwn(organizationId: string | null | undefined): Promise<string | null> {
    if (typeof organizationId !== 'string' || !UUID_SHAPE_REGEX.test(organizationId)) return null
    const stored = await readStoredAppUrl(organizationId)
    if (!stored) return null
    if (isAllowedAppOrigin(stored, env)) return stored
    if (!warnedDisallowedOrganizationIds.has(organizationId)) {
      warnedDisallowedOrganizationIds.add(organizationId)
      logger.warn('Organization app URL is not in the allowed origins, falling back to APP_URL', {
        organizationId,
        appUrl: stored,
      })
    }
    return null
  }

  async function resolve(organizationId: string | null | undefined): Promise<string> {
    return (await resolveOwn(organizationId)) ?? getSecurityEmailBaseUrl(undefined, env)
  }

  async function invalidate(organizationId: string): Promise<void> {
    if (!cache) return
    try {
      await runWithCacheTenant(null, () => cache.deleteByTags([organizationAppUrlCacheTag(organizationId)]))
    } catch {
      return
    }
  }

  return { resolveOwn, resolve, invalidate }
}

export async function canManageOrganizationAppUrl(input: {
  container: { resolve<T = unknown>(name: string): T }
  auth: {
    sub?: string | null
    tenantId?: string | null
    orgId?: string | null
    isSuperAdmin?: boolean
  } | null
  systemActor?: boolean
}): Promise<boolean> {
  if (input.systemActor === true) return true
  try {
    if (await resolveIsSuperAdmin({ auth: input.auth, container: input.container })) return true
    const auth = input.auth
    if (!auth?.sub) return false
    const rbacService = input.container.resolve<RbacService>('rbacService')
    return await rbacService.userHasAllFeatures(auth.sub, [ORGANIZATION_MANAGE_APP_URL_FEATURE], {
      tenantId: auth.tenantId ?? null,
      organizationId: auth.orgId ?? null,
    })
  } catch {
    return false
  }
}

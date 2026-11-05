import { asClass, asFunction } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { ORGANIZATION_APP_URL_RESOLVER_DI_KEY } from '@open-mercato/shared/lib/url'
import { DefaultOrganizationScopeService } from './services/organizationScopeService'
import { DefaultOrganizationHierarchyService } from './services/organizationHierarchyService'
import { createOrganizationAppUrlResolver, type OrganizationAppUrlCache } from './lib/organizationAppUrl'

type OrganizationScopeRbac = ConstructorParameters<typeof DefaultOrganizationScopeService>[1]

function isOrganizationAppUrlCache(candidate: unknown): candidate is OrganizationAppUrlCache {
  if (!candidate || typeof candidate !== 'object') return false
  const record = candidate as Record<string, unknown>
  return typeof record.get === 'function' && typeof record.set === 'function' && typeof record.deleteByTags === 'function'
}

export function register(container: AppContainer) {
  container.register({
    organizationHierarchyService: asClass(DefaultOrganizationHierarchyService).scoped(),
    organizationScopeService: asFunction((cradle: { em: EntityManager; rbacService: OrganizationScopeRbac }) =>
      new DefaultOrganizationScopeService(cradle.em, cradle.rbacService, container),
    )
      .scoped()
      .proxy(),
    [ORGANIZATION_APP_URL_RESOLVER_DI_KEY]: asFunction(
      function organizationAppUrlResolverFactory(cradle: { em: EntityManager }) {
        let cache: OrganizationAppUrlCache | null = null
        try {
          if (container.hasRegistration('cache')) {
            const candidate = container.resolve('cache')
            if (isOrganizationAppUrlCache(candidate)) cache = candidate
          }
        } catch {
          cache = null
        }
        return createOrganizationAppUrlResolver({ em: cradle.em, cache })
      },
    )
      .scoped()
      .proxy(),
  })
}

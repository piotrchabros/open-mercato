/** @jest-environment node */

/**
 * Host-bound organization scope (#4271, task 3.5).
 *
 * Task 3.4 stamps `auth.hostBinding` and denies conflicting scope selections;
 * this layer applies the POSITIVE binding, with the access check 3.4
 * deliberately could not perform.
 */

import type { EntityManager } from '@mikro-orm/postgresql'
import type { AwilixContainer } from 'awilix'
import type { RbacService } from '@open-mercato/core/modules/auth/services/rbacService'
import type { AuthContext } from '@open-mercato/shared/lib/auth/server'
import { resolveOrganizationScopeForRequest } from '../organizationScope'

const USER = '00000000-0000-4000-8000-000000000001'
const BOUND = { hostname: 'crm.acme.com', tenantId: 'tenant-1', organizationId: 'org-bound' }

function createMockEm(orgs: Array<{ id: string; descendantIds: string[] }>) {
  const find = jest.fn((_entity: unknown, filter: { id?: { $in: string[] } }) => {
    const requestedIds = filter?.id?.$in ?? []
    return Promise.resolve(orgs.filter((row) => requestedIds.includes(row.id)))
  })
  return { find } as unknown as EntityManager
}

function createMockRbac(organizations: string[] | null) {
  return {
    loadAcl: jest.fn().mockResolvedValue({
      isSuperAdmin: organizations === null,
      features: [],
      organizations,
    }),
  } as unknown as RbacService
}

function createMemoryCache() {
  const store = new Map<string, { value: unknown; tags: string[] }>()
  return {
    store,
    get: jest.fn(async (key: string) => store.get(key)?.value ?? null),
    set: jest.fn(async (key: string, value: unknown, opts?: { tags?: string[] }) => {
      store.set(key, { value, tags: opts?.tags ?? [] })
    }),
    deleteByTags: jest.fn(async () => 0),
  }
}

function createContainer(em: EntityManager, rbac: RbacService, cache: unknown | null): AwilixContainer {
  return {
    resolve: (key: string) => {
      if (key === 'em') return em
      if (key === 'rbacService') return rbac
      if (key === 'cache') {
        if (cache === null) throw new Error('cache not registered')
        return cache
      }
      throw new Error(`unexpected DI key: ${key}`)
    },
  } as unknown as AwilixContainer
}

function auth(overrides: Record<string, unknown> = {}): AuthContext {
  return {
    sub: USER,
    tenantId: 'tenant-1',
    orgId: 'org-home',
    isSuperAdmin: false,
    ...overrides,
  } as AuthContext
}

describe('resolveOrganizationScopeForRequest with a host binding', () => {
  const originalTtl = process.env.OM_ORG_SCOPE_CACHE_TTL_MS

  afterEach(() => {
    if (originalTtl === undefined) delete process.env.OM_ORG_SCOPE_CACHE_TTL_MS
    else process.env.OM_ORG_SCOPE_CACHE_TTL_MS = originalTtl
  })

  it('leaves scope untouched when there is no binding', async () => {
    const em = createMockEm([{ id: 'org-home', descendantIds: [] }])
    const container = createContainer(em, createMockRbac(['org-home']), null)

    const scope = await resolveOrganizationScopeForRequest({ container, auth: auth() })

    expect(scope.selectedId).toBe('org-home')
    expect(scope.tenantId).toBe('tenant-1')
  })

  it('forces the bound organization over a conflicting cookie selection', async () => {
    const em = createMockEm([
      { id: 'org-bound', descendantIds: [] },
      { id: 'org-other', descendantIds: [] },
    ])
    const container = createContainer(em, createMockRbac(['org-bound', 'org-other']), null)

    const scope = await resolveOrganizationScopeForRequest({
      container,
      auth: auth({ hostBinding: BOUND }),
      // An explicit selection of a different org - the cookie equivalent.
      selectedId: 'org-other',
    })

    expect(scope.selectedId).toBe('org-bound')
    expect(scope.filterIds).toEqual(['org-bound'])
    expect(scope.allowedIds).toEqual(['org-bound'])
  })

  it('fails closed when the caller has no access to the bound organization', async () => {
    // The critical case: never fall back to the caller's home org, which would
    // silently serve a different organization under the bound brand.
    const em = createMockEm([
      { id: 'org-bound', descendantIds: [] },
      { id: 'org-home', descendantIds: [] },
    ])
    const container = createContainer(em, createMockRbac(['org-home']), null)

    const scope = await resolveOrganizationScopeForRequest({
      container,
      auth: auth({ hostBinding: BOUND }),
    })

    expect(scope.selectedId).toBeNull()
    expect(scope.filterIds).toEqual([])
    expect(scope.allowedIds).toEqual([])
    expect(scope.selectionRejected).toBe(true)
    expect(scope.tenantId).toBe('tenant-1')
  })

  it('does not leave a super-admin unrestricted on a bound host', async () => {
    // A super-admin resolves to filterIds/allowedIds === null ("unrestricted").
    // Leaving that as-is would make the binding pure decoration.
    const em = createMockEm([
      { id: 'org-bound', descendantIds: [] },
      { id: 'org-other', descendantIds: [] },
    ])
    const container = createContainer(em, createMockRbac(null), null)

    const scope = await resolveOrganizationScopeForRequest({
      container,
      auth: auth({ isSuperAdmin: true, hostBinding: BOUND }),
    })

    expect(scope.filterIds).not.toBeNull()
    expect(scope.allowedIds).not.toBeNull()
    expect(scope.filterIds).toEqual(['org-bound'])
    expect(scope.selectedId).toBe('org-bound')
  })

  it('includes descendants of the bound organization but nothing outside it', async () => {
    const em = createMockEm([
      { id: 'org-bound', descendantIds: ['org-child'] },
      { id: 'org-child', descendantIds: [] },
      { id: 'org-other', descendantIds: [] },
    ])
    const container = createContainer(em, createMockRbac(['org-bound', 'org-child', 'org-other']), null)

    const scope = await resolveOrganizationScopeForRequest({
      container,
      auth: auth({ hostBinding: BOUND }),
    })

    expect(scope.filterIds).toEqual(expect.arrayContaining(['org-bound', 'org-child']))
    expect(scope.filterIds).not.toContain('org-other')
    expect(scope.allowedIds).not.toContain('org-other')
  })

  it('does not share a cache entry between a bound and an unbound request', async () => {
    // The org-scope cache key carried no host component before #4271. With the
    // TTL enabled, one poisoned entry would serve a platform-host scope to a
    // bound-host request for the same user - visible only under concurrency.
    process.env.OM_ORG_SCOPE_CACHE_TTL_MS = '60000'
    const em = createMockEm([
      { id: 'org-bound', descendantIds: [] },
      { id: 'org-home', descendantIds: [] },
    ])
    const cache = createMemoryCache()
    const container = createContainer(em, createMockRbac(['org-bound', 'org-home']), cache)

    const unbound = await resolveOrganizationScopeForRequest({ container, auth: auth() })
    const bound = await resolveOrganizationScopeForRequest({
      container,
      auth: auth({ hostBinding: BOUND }),
    })

    expect(unbound.selectedId).toBe('org-home')
    expect(bound.selectedId).toBe('org-bound')
    expect(cache.store.size).toBe(2)
  })
})

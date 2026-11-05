import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  canManageOrganizationAppUrl,
  createOrganizationAppUrlResolver,
  organizationAppUrlCacheKey,
  organizationAppUrlCacheTag,
  ORGANIZATION_APP_URL_CACHE_TTL_MS,
  type OrganizationAppUrlCache,
} from '../lib/organizationAppUrl'
import { ORGANIZATION_MANAGE_APP_URL_FEATURE } from '../constants'

const mockWarn = jest.fn()

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/logger', () => {
  const logger = {
    warn: (...args: unknown[]) => mockWarn(...args),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    child: () => logger,
  }
  return { createLogger: () => logger }
})

const findOneMock = findOneWithDecryption as jest.MockedFunction<typeof findOneWithDecryption>

const ENV = {
  NODE_ENV: 'test',
  APP_URL: 'https://default.example.com',
  APP_ALLOWED_ORIGINS: 'https://brand.example.com',
}

const ORG_SET = '11111111-1111-4111-8111-111111111111'
const ORG_UNSET = '22222222-2222-4222-8222-222222222222'
const ORG_DISALLOWED = '33333333-3333-4333-8333-333333333333'
const ORG_CACHED = '44444444-4444-4444-8444-444444444444'
const ORG_INVALIDATE = '55555555-5555-4555-8555-555555555555'
const ORG_MISSING = '66666666-6666-4666-8666-666666666666'
const ORG_NO_CACHE = '77777777-7777-4777-8777-777777777777'

function createEm(): EntityManager {
  const em = { fork: jest.fn() }
  em.fork.mockReturnValue(em)
  return em as unknown as EntityManager
}

function createMemoryCache(): OrganizationAppUrlCache & { store: Map<string, { value: unknown; tags: string[] }> } {
  const store = new Map<string, { value: unknown; tags: string[] }>()
  return {
    store,
    get: jest.fn(async (key: string) => store.get(key)?.value ?? null),
    set: jest.fn(async (key: string, value: unknown, options?: { ttl?: number; tags?: string[] }) => {
      store.set(key, { value, tags: options?.tags ?? [] })
    }),
    deleteByTags: jest.fn(async (tags: string[]) => {
      let removed = 0
      for (const [key, entry] of store.entries()) {
        if (entry.tags.some((tag) => tags.includes(tag))) {
          store.delete(key)
          removed += 1
        }
      }
      return removed
    }),
  }
}

function organizationWith(appUrl: string | null) {
  return { appUrl } as unknown as Awaited<ReturnType<typeof findOneWithDecryption>>
}

describe('createOrganizationAppUrlResolver', () => {
  beforeEach(() => {
    findOneMock.mockReset()
    mockWarn.mockReset()
  })

  it('returns the stored app URL when it is allowed and caches it with ttl and tag', async () => {
    findOneMock.mockResolvedValue(organizationWith('https://brand.example.com'))
    const cache = createMemoryCache()
    const resolver = createOrganizationAppUrlResolver({ em: createEm(), cache, env: ENV })

    await expect(resolver.resolveOwn(ORG_SET)).resolves.toBe('https://brand.example.com')
    await expect(resolver.resolve(ORG_SET)).resolves.toBe('https://brand.example.com')
    expect(cache.set).toHaveBeenCalledWith(
      organizationAppUrlCacheKey(ORG_SET),
      { appUrl: 'https://brand.example.com' },
      { ttl: ORGANIZATION_APP_URL_CACHE_TTL_MS, tags: [organizationAppUrlCacheTag(ORG_SET)] },
    )
    expect(findOneMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { id: ORG_SET, deletedAt: null },
      undefined,
      { tenantId: null, organizationId: ORG_SET },
    )
  })

  it('falls back to APP_URL when no app URL is stored', async () => {
    findOneMock.mockResolvedValue(organizationWith(null))
    const resolver = createOrganizationAppUrlResolver({ em: createEm(), cache: createMemoryCache(), env: ENV })

    await expect(resolver.resolveOwn(ORG_UNSET)).resolves.toBeNull()
    await expect(resolver.resolve(ORG_UNSET)).resolves.toBe('https://default.example.com')
  })

  it('falls back to APP_URL and warns exactly once for a stored but disallowed value', async () => {
    findOneMock.mockResolvedValue(organizationWith('https://rogue.example.com'))
    const resolver = createOrganizationAppUrlResolver({ em: createEm(), cache: createMemoryCache(), env: ENV })

    await expect(resolver.resolveOwn(ORG_DISALLOWED)).resolves.toBeNull()
    await expect(resolver.resolve(ORG_DISALLOWED)).resolves.toBe('https://default.example.com')
    await expect(resolver.resolve(ORG_DISALLOWED)).resolves.toBe('https://default.example.com')
    expect(mockWarn).toHaveBeenCalledTimes(1)
  })

  it('serves a cache hit without a second database read', async () => {
    findOneMock.mockResolvedValue(organizationWith('https://brand.example.com'))
    const resolver = createOrganizationAppUrlResolver({ em: createEm(), cache: createMemoryCache(), env: ENV })

    await resolver.resolveOwn(ORG_CACHED)
    await resolver.resolveOwn(ORG_CACHED)
    expect(findOneMock).toHaveBeenCalledTimes(1)
  })

  it('rereads the database after invalidate', async () => {
    findOneMock.mockResolvedValueOnce(organizationWith('https://brand.example.com'))
    findOneMock.mockResolvedValueOnce(organizationWith(null))
    const cache = createMemoryCache()
    const resolver = createOrganizationAppUrlResolver({ em: createEm(), cache, env: ENV })

    await expect(resolver.resolveOwn(ORG_INVALIDATE)).resolves.toBe('https://brand.example.com')
    await resolver.invalidate(ORG_INVALIDATE)
    expect(cache.deleteByTags).toHaveBeenCalledWith([organizationAppUrlCacheTag(ORG_INVALIDATE)])
    await expect(resolver.resolveOwn(ORG_INVALIDATE)).resolves.toBeNull()
    expect(findOneMock).toHaveBeenCalledTimes(2)
  })

  it('returns the default for a non-UUID, missing id or missing organization', async () => {
    findOneMock.mockResolvedValue(null)
    const resolver = createOrganizationAppUrlResolver({ em: createEm(), cache: createMemoryCache(), env: ENV })

    await expect(resolver.resolve('not-a-uuid')).resolves.toBe('https://default.example.com')
    await expect(resolver.resolve(null)).resolves.toBe('https://default.example.com')
    await expect(resolver.resolve(undefined)).resolves.toBe('https://default.example.com')
    expect(findOneMock).not.toHaveBeenCalled()
    await expect(resolver.resolve(ORG_MISSING)).resolves.toBe('https://default.example.com')
    expect(findOneMock).toHaveBeenCalledTimes(1)
  })

  it('works without a cache and tolerates failing cache calls', async () => {
    findOneMock.mockResolvedValue(organizationWith('https://brand.example.com'))
    const resolver = createOrganizationAppUrlResolver({ em: createEm(), cache: null, env: ENV })

    await expect(resolver.resolveOwn(ORG_NO_CACHE)).resolves.toBe('https://brand.example.com')
    await expect(resolver.resolveOwn(ORG_NO_CACHE)).resolves.toBe('https://brand.example.com')
    await expect(resolver.invalidate(ORG_NO_CACHE)).resolves.toBeUndefined()
    expect(findOneMock).toHaveBeenCalledTimes(2)

    const failingCache: OrganizationAppUrlCache = {
      get: jest.fn().mockRejectedValue(new Error('down')),
      set: jest.fn().mockRejectedValue(new Error('down')),
      deleteByTags: jest.fn().mockRejectedValue(new Error('down')),
    }
    const failingResolver = createOrganizationAppUrlResolver({ em: createEm(), cache: failingCache, env: ENV })
    await expect(failingResolver.resolveOwn(ORG_NO_CACHE)).resolves.toBe('https://brand.example.com')
    await expect(failingResolver.invalidate(ORG_NO_CACHE)).resolves.toBeUndefined()
  })
})

describe('canManageOrganizationAppUrl', () => {
  const auth = { sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-1' }

  function createContainer(rbacService: { loadAcl: jest.Mock; userHasAllFeatures: jest.Mock }) {
    return {
      resolve: <T = unknown>(name: string): T => {
        if (name === 'rbacService') return rbacService as unknown as T
        throw new Error(`[internal] unexpected resolve ${name}`)
      },
    }
  }

  it('allows a system actor without consulting rbac', async () => {
    const rbacService = { loadAcl: jest.fn(), userHasAllFeatures: jest.fn() }
    await expect(
      canManageOrganizationAppUrl({ container: createContainer(rbacService), auth: null, systemActor: true }),
    ).resolves.toBe(true)
    expect(rbacService.loadAcl).not.toHaveBeenCalled()
    expect(rbacService.userHasAllFeatures).not.toHaveBeenCalled()
  })

  it('allows a superadmin', async () => {
    const rbacService = {
      loadAcl: jest.fn().mockResolvedValue({ isSuperAdmin: true }),
      userHasAllFeatures: jest.fn().mockResolvedValue(false),
    }
    await expect(canManageOrganizationAppUrl({ container: createContainer(rbacService), auth })).resolves.toBe(true)
    expect(rbacService.userHasAllFeatures).not.toHaveBeenCalled()
  })

  it.each([true, false])('returns the rbac feature check result (%s)', async (granted) => {
    const rbacService = {
      loadAcl: jest.fn().mockResolvedValue({ isSuperAdmin: false }),
      userHasAllFeatures: jest.fn().mockResolvedValue(granted),
    }
    await expect(canManageOrganizationAppUrl({ container: createContainer(rbacService), auth })).resolves.toBe(granted)
    expect(rbacService.userHasAllFeatures).toHaveBeenCalledWith('user-1', [ORGANIZATION_MANAGE_APP_URL_FEATURE], {
      tenantId: 'tenant-1',
      organizationId: 'org-1',
    })
  })

  it('returns false when the rbac check throws', async () => {
    const rbacService = {
      loadAcl: jest.fn().mockResolvedValue({ isSuperAdmin: false }),
      userHasAllFeatures: jest.fn().mockRejectedValue(new Error('rbac down')),
    }
    await expect(canManageOrganizationAppUrl({ container: createContainer(rbacService), auth })).resolves.toBe(false)
  })
})

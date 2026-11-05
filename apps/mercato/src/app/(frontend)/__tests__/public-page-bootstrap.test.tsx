import React from 'react'

jest.mock('@/.mercato/generated/frontend-routes.generated', () => ({
  frontendRoutes: [],
}), { virtual: true })

jest.mock('@/.mercato/generated/frontend-middleware.generated', () => ({
  frontendMiddlewareEntries: [],
}), { virtual: true })

jest.mock('@/bootstrap', () => ({
  bootstrap: jest.fn(),
  isBootstrapped: jest.fn(() => true),
}))

const mockFindRouteManifestMatch = jest.fn()
jest.mock('@open-mercato/shared/modules/registry', () => ({
  findRouteManifestMatch: (...args: unknown[]) => mockFindRouteManifestMatch(...args),
  getFrontendRouteManifests: jest.fn(() => []),
  registerFrontendRouteManifests: jest.fn(),
}))

const redirect = jest.fn((href?: string) => {
  throw new Error('REDIRECT ' + href)
})
const notFound = jest.fn(() => {
  throw new Error('NOT_FOUND')
})
jest.mock('next/navigation', () => ({
  redirect: (href?: string) => redirect(href),
  notFound: () => notFound(),
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromCookies: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({
    t: (_key: string, fallback: string) => fallback,
    translate: (_key: string, fallback: string) => fallback,
  }),
}))

jest.mock('@open-mercato/ui/backend/detail', () => ({
  AccessDeniedMessage: (props: { label: string }) => <div data-testid="access-denied">{props.label}</div>,
}))

jest.mock('next/link', () => (props: { href: string; children: React.ReactNode }) => (
  <a href={props.href}>{props.children}</a>
))

jest.mock('@open-mercato/core/modules/directory/data/entities', () => ({
  Organization: class Organization {},
}))

jest.mock('@/lib/metadata', () => ({
  resolveLocalizedTitleMetadata: jest.fn(async () => ({})),
}))

const mockRbac = {
  userHasAllFeatures: jest.fn(async () => true),
}

const mockCreateRequestContainer = jest.fn(async () => ({
  resolve: (key: string) => (key === 'rbacService' ? mockRbac : null),
}))
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: (...args: unknown[]) => mockCreateRequestContainer(...(args as [])),
}))

import { bootstrap } from '@/bootstrap'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import SiteCatchAll from '../[...slug]/page'

const mockBootstrap = bootstrap as jest.Mock
const mockGetAuthFromCookies = getAuthFromCookies as jest.Mock

const routeLoad = jest.fn()

function matchFor(route: Record<string, unknown>) {
  mockFindRouteManifestMatch.mockReturnValue({
    route: { title: 'Page', load: routeLoad, ...route },
    params: {},
  })
}

function renderPage(slug: string[]) {
  return SiteCatchAll({ params: Promise.resolve({ slug }) })
}

describe('frontend catch-all server bootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    routeLoad.mockImplementation(async () => () => <div data-testid="page" />)
    mockCreateRequestContainer.mockImplementation(async () => ({
      resolve: (key: string) => (key === 'rbacService' ? mockRbac : null),
    }))
    mockRbac.userHasAllFeatures.mockResolvedValue(true)
  })

  it('bootstraps once before loading a public route without touching auth', async () => {
    matchFor({ requireAuth: false })

    await renderPage(['offer', 'abc'])

    expect(mockBootstrap).toHaveBeenCalledTimes(1)
    expect(routeLoad).toHaveBeenCalledTimes(1)
    expect(mockBootstrap.mock.invocationCallOrder[0]).toBeLessThan(routeLoad.mock.invocationCallOrder[0])
    expect(mockGetAuthFromCookies).not.toHaveBeenCalled()
  })

  it('renders a public route in a fresh process where the container requires bootstrap', async () => {
    matchFor({ requireAuth: false })
    routeLoad.mockImplementation(async () => async () => {
      await mockCreateRequestContainer()
      return <div data-testid="page" />
    })
    mockCreateRequestContainer.mockImplementation(async () => {
      if (mockBootstrap.mock.calls.length === 0) throw new Error('[internal] container requested before bootstrap')
      return { resolve: () => null }
    })

    const Component = (await renderPage(['offer', 'abc'])) as React.ReactElement<unknown, () => Promise<unknown>>

    await expect(Component.type({})).resolves.toBeDefined()
  })

  it('returns notFound without bootstrapping when no route matches', async () => {
    mockFindRouteManifestMatch.mockReturnValue(null)

    await expect(renderPage(['missing'])).rejects.toThrow('NOT_FOUND')

    expect(mockBootstrap).not.toHaveBeenCalled()
  })

  it('bootstraps exactly once and still checks rbac for a staff route with required features', async () => {
    matchFor({ requireAuth: true, requireFeatures: ['customers.view'] })
    mockGetAuthFromCookies.mockResolvedValue({ sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-1', roles: [] })

    await renderPage(['backend', 'x'])

    expect(mockBootstrap).toHaveBeenCalledTimes(1)
    expect(mockRbac.userHasAllFeatures).toHaveBeenCalledWith(
      'user-1',
      ['customers.view'],
      { tenantId: 'tenant-1', organizationId: 'org-1' },
    )
    expect(routeLoad).toHaveBeenCalledTimes(1)
  })
})

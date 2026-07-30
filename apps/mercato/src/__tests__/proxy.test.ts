// First unit test for apps/mercato/src/proxy.ts (task 2.3). It is the
// regression baseline for the routing-branch change task 3.3 will make.
//
// Includes the `x-force-host` gate test promised (and never written) at
// .ai/specs/implemented/2026-04-08-portal-custom-domain-routing.md:1627 —
// the override MUST be ignored unless `NODE_ENV === 'test'`, even when
// `x-force-host-secret` matches `FORCE_HOST_SECRET`.

import { NextRequest } from 'next/server'

const isPlatformHost = jest.fn<boolean, [string]>()
const ensureWarmUp = jest.fn<Promise<unknown>, []>()
const resolve = jest.fn<Promise<unknown>, [string]>()

jest.mock('../lib/customDomainResolver', () => ({
  isPlatformHost: (hostname: string) => isPlatformHost(hostname),
  ensureWarmUp: () => ensureWarmUp(),
  getSharedCustomDomainRouter: () => ({ resolve: (hostname: string) => resolve(hostname) }),
}))

import { proxy } from '../proxy'

function makeRequest(url: string, headers: Record<string, string>): NextRequest {
  return new NextRequest(new URL(url), { headers })
}

describe('proxy', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    jest.clearAllMocks()
    ensureWarmUp.mockResolvedValue(undefined)
    process.env = { ...ORIGINAL_ENV }
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('passes platform hosts through, sets x-next-url, and never consults the custom-domain router', async () => {
    isPlatformHost.mockReturnValue(true)
    const req = makeRequest('https://app.openmercato.com/dashboard/settings', {
      host: 'app.openmercato.com',
    })

    const res = await proxy(req)

    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
    expect(res.headers.get('x-middleware-request-x-next-url')).toBe('/dashboard/settings')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('passes through when the host resolves to unmapped (null resolution)', async () => {
    isPlatformHost.mockReturnValue(false)
    resolve.mockResolvedValue(null)
    const req = makeRequest('https://mystery.example.com/some/page', {
      host: 'mystery.example.com',
    })

    const res = await proxy(req)

    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(res.headers.get('x-middleware-request-x-next-url')).toBe('/some/page')
    expect(resolve).toHaveBeenCalledWith('mystery.example.com')
  })

  it('passes through when the host resolves but has a null orgSlug', async () => {
    isPlatformHost.mockReturnValue(false)
    resolve.mockResolvedValue({
      hostname: 'inactive.example.com',
      tenantId: 't1',
      organizationId: 'o1',
      orgSlug: null,
      status: 'active',
    })
    const req = makeRequest('https://inactive.example.com/some/page', {
      host: 'inactive.example.com',
    })

    const res = await proxy(req)

    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(res.headers.get('x-middleware-request-x-next-url')).toBe('/some/page')
  })

  it('returns 503 with retry-after when resolution errors', async () => {
    isPlatformHost.mockReturnValue(false)
    resolve.mockRejectedValue(new Error('upstream fetch failed'))
    const req = makeRequest('https://shop.acme.com/', { host: 'shop.acme.com' })

    const res = await proxy(req)

    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('5')
  })

  it.each([
    ['/', '/acme/portal'],
    ['/acme/portal/orders', '/acme/portal/orders'],
    ['/orders/123', '/acme/portal/orders/123'],
  ])('rewrites %s to %s and sets x-custom-domain on both request and response', async (path, expected) => {
    isPlatformHost.mockReturnValue(false)
    resolve.mockResolvedValue({
      hostname: 'shop.acme.com',
      tenantId: 't1',
      organizationId: 'o1',
      orgSlug: 'acme',
      status: 'active',
    })
    const req = makeRequest(`https://shop.acme.com${path}`, { host: 'shop.acme.com' })

    const res = await proxy(req)

    const rewriteDestination = res.headers.get('x-middleware-rewrite')
    expect(rewriteDestination).not.toBeNull()
    expect(new URL(rewriteDestination!).pathname).toBe(expected)
    expect(res.headers.get('x-middleware-request-x-next-url')).toBe(expected)
    // Set on the outgoing request (relayed via x-middleware-request-*, see :82)...
    expect(res.headers.get('x-middleware-request-x-custom-domain')).toBe('1')
    // ...and directly on the response itself (see :86).
    expect(res.headers.get('x-custom-domain')).toBe('1')
  })

  it('ignores x-force-host outside NODE_ENV=test, even with a matching x-force-host-secret', async () => {
    process.env.NODE_ENV = 'production'
    process.env.FORCE_HOST_SECRET = 'top-secret'
    isPlatformHost.mockImplementation((hostname: string) => hostname === 'app.openmercato.com')

    const req = makeRequest('https://app.openmercato.com/dashboard', {
      host: 'app.openmercato.com',
      'x-force-host': 'shop.acme.com',
      'x-force-host-secret': 'top-secret',
    })

    const res = await proxy(req)

    // If x-force-host had won, isPlatformHost would have been called with
    // 'shop.acme.com' (which our mock treats as a non-platform host) and the
    // custom-domain router would have been consulted instead.
    expect(isPlatformHost).toHaveBeenCalledWith('app.openmercato.com')
    expect(resolve).not.toHaveBeenCalled()
    expect(res.headers.get('x-middleware-next')).toBe('1')
  })
})

// ---------------------------------------------------------------------------
// backend-target routing (task 3.3, #4271)
// ---------------------------------------------------------------------------

describe('proxy backend-target hosts', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    jest.clearAllMocks()
    ensureWarmUp.mockResolvedValue(undefined)
    isPlatformHost.mockReturnValue(false)
    process.env = { ...ORIGINAL_ENV }
    process.env.BACKEND_CUSTOM_DOMAINS_ENABLED = '1'
    process.env.TRUSTED_PROXY_CIDRS = '10.0.0.0/8'
    delete process.env.OM_ALLOW_FORCED_HOST
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  function backendMapping() {
    return {
      hostname: 'crm.acme.com',
      tenantId: 't1',
      organizationId: 'o1',
      orgSlug: 'acme',
      status: 'active' as const,
      target: 'backend' as const,
    }
  }

  it('serves /backend unrewritten on a backend host', async () => {
    resolve.mockResolvedValue(backendMapping())
    const res = await proxy(makeRequest('https://crm.acme.com/backend/customers', { host: 'crm.acme.com' }))

    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
    expect(res.headers.get('x-middleware-request-x-next-url')).toBe('/backend/customers')
    expect(res.headers.get('x-custom-domain')).toBe('1')
  })

  it('does not prefix the portal path on a backend host root request', async () => {
    resolve.mockResolvedValue(backendMapping())
    const res = await proxy(makeRequest('https://crm.acme.com/', { host: 'crm.acme.com' }))

    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
    expect(res.headers.get('x-middleware-request-x-next-url')).toBe('/')
  })

  it('fails closed to a 404 passthrough when the feature flag is off', async () => {
    // Disabling the flag must stop already-registered backend hosts from
    // routing, otherwise the kill switch does not actually kill anything.
    delete process.env.BACKEND_CUSTOM_DOMAINS_ENABLED
    resolve.mockResolvedValue(backendMapping())
    const res = await proxy(makeRequest('https://crm.acme.com/backend/customers', { host: 'crm.acme.com' }))

    expect(res.headers.get('x-middleware-next')).toBe('1')
    expect(res.headers.get('x-custom-domain')).toBeNull()
  })

  it('fails closed when enabled without a trusted-proxy assertion', async () => {
    delete process.env.TRUSTED_PROXY_CIDRS
    resolve.mockResolvedValue(backendMapping())
    const res = await proxy(makeRequest('https://crm.acme.com/backend', { host: 'crm.acme.com' }))

    expect(res.headers.get('x-custom-domain')).toBeNull()
  })

  it('treats a mapping with no target as portal, preserving pre-#4271 cache entries', async () => {
    resolve.mockResolvedValue({
      hostname: 'shop.acme.com',
      tenantId: 't1',
      organizationId: 'o1',
      orgSlug: 'acme',
      status: 'active' as const,
    })
    const res = await proxy(makeRequest('https://shop.acme.com/orders', { host: 'shop.acme.com' }))

    const rewrite = res.headers.get('x-middleware-rewrite')
    expect(rewrite).not.toBeNull()
    expect(new URL(rewrite as string).pathname).toBe('/acme/portal/orders')
  })

  it('404s an admin route requested on a portal host', async () => {
    resolve.mockResolvedValue({
      hostname: 'shop.acme.com',
      tenantId: 't1',
      organizationId: 'o1',
      orgSlug: 'acme',
      status: 'active' as const,
      target: 'portal' as const,
    })
    const res = await proxy(makeRequest('https://shop.acme.com/backend/customers', { host: 'shop.acme.com' }))

    expect(res.status).toBe(404)
    expect(res.headers.get('x-middleware-rewrite')).toBeNull()
  })
})

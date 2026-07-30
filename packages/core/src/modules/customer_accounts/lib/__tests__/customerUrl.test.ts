/** @jest-environment node */

/**
 * Coverage for urlForCustomerOrg, promised (and never written) by
 * .ai/specs/implemented/2026-04-08-portal-custom-domain-routing.md:254 and :1917.
 */

import { urlForCustomerOrg } from '../customerUrl'

type ContainerStub = { resolve: (name: string) => unknown }

function makeContainer(options: {
  domainMappingService?: { resolveActiveByOrg: (orgId: string) => Promise<{ hostname: string } | null> } | 'throw'
  orgService?: { findById: (orgId: string) => Promise<{ id: string; slug: string | null } | null> } | 'throw'
}): ContainerStub {
  return {
    resolve(name: string) {
      if (name === 'domainMappingService') {
        if (options.domainMappingService === 'throw') throw new Error('domainMappingService not registered')
        if (options.domainMappingService === undefined) throw new Error('domainMappingService not registered')
        return options.domainMappingService
      }
      if (name === 'orgService') {
        if (options.orgService === 'throw') throw new Error('orgService not registered')
        if (options.orgService === undefined) return undefined
        return options.orgService
      }
      throw new Error(`unexpected resolve(${name})`)
    },
  }
}

describe('urlForCustomerOrg', () => {
  const originalBaseUrl = process.env.PLATFORM_PORTAL_BASE_URL
  const originalNodeEnv = process.env.NODE_ENV

  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env.PLATFORM_PORTAL_BASE_URL
    else process.env.PLATFORM_PORTAL_BASE_URL = originalBaseUrl
    process.env.NODE_ENV = originalNodeEnv
  })

  it('returns the active-mapping hostname URL when a custom domain is active', async () => {
    const container = makeContainer({
      domainMappingService: {
        resolveActiveByOrg: async () => ({ hostname: 'shop.acme.com' }),
      },
    })
    const url = await urlForCustomerOrg('org-1', '/orders', { container: container as never })
    expect(url).toBe('https://shop.acme.com/orders')
  })

  it('falls back to platform base + org slug when there is no active mapping', async () => {
    process.env.PLATFORM_PORTAL_BASE_URL = 'https://app.openmercato.com'
    const container = makeContainer({
      domainMappingService: { resolveActiveByOrg: async () => null },
      orgService: { findById: async () => ({ id: 'org-1', slug: 'acme' }) },
    })
    const url = await urlForCustomerOrg('org-1', '/orders', { container: container as never })
    expect(url).toBe('https://app.openmercato.com/acme/portal/orders')
  })

  it('falls back to the bare platform base + path when there is neither an active mapping nor a slug', async () => {
    process.env.PLATFORM_PORTAL_BASE_URL = 'https://app.openmercato.com'
    const container = makeContainer({
      domainMappingService: { resolveActiveByOrg: async () => null },
      orgService: { findById: async () => ({ id: 'org-1', slug: null }) },
    })
    const url = await urlForCustomerOrg('org-1', '/orders', { container: container as never })
    expect(url).toBe('https://app.openmercato.com/orders')
  })

  it('throws in production when PLATFORM_PORTAL_BASE_URL is unset', async () => {
    delete process.env.PLATFORM_PORTAL_BASE_URL
    process.env.NODE_ENV = 'production'
    const container = makeContainer({
      domainMappingService: { resolveActiveByOrg: async () => null },
      orgService: { findById: async () => null },
    })
    await expect(urlForCustomerOrg('org-1', '/orders', { container: container as never })).rejects.toThrow(
      /PLATFORM_PORTAL_BASE_URL is required in production/,
    )
  })

  it('falls through to the platform URL when domainMappingService is not registered (fresh installs / tests)', async () => {
    process.env.PLATFORM_PORTAL_BASE_URL = 'https://app.openmercato.com'
    const container = makeContainer({
      orgService: { findById: async () => ({ id: 'org-1', slug: 'acme' }) },
    })
    const url = await urlForCustomerOrg('org-1', '/orders', { container: container as never })
    expect(url).toBe('https://app.openmercato.com/acme/portal/orders')
  })

  it('also swallows an orgService resolution failure and falls through to the bare platform URL', async () => {
    process.env.PLATFORM_PORTAL_BASE_URL = 'https://app.openmercato.com'
    const container = makeContainer({
      domainMappingService: { resolveActiveByOrg: async () => null },
      orgService: 'throw',
    })
    const url = await urlForCustomerOrg('org-1', '/orders', { container: container as never })
    expect(url).toBe('https://app.openmercato.com/orders')
  })

  it('normalizes a path without a leading slash', async () => {
    process.env.PLATFORM_PORTAL_BASE_URL = 'https://app.openmercato.com'
    const container = makeContainer({
      domainMappingService: { resolveActiveByOrg: async () => null },
      orgService: { findById: async () => ({ id: 'org-1', slug: null }) },
    })
    const url = await urlForCustomerOrg('org-1', 'orders', { container: container as never })
    expect(url).toBe('https://app.openmercato.com/orders')
  })
})

/** @jest-environment node */
import { urlForOrgBackend } from '@open-mercato/core/modules/customer_accounts/lib/backendUrl'

const ORG = 'org-1'

function container(resolveActiveByOrg: unknown) {
  return {
    hasRegistration: () => true,
    resolve: () => ({ resolveActiveByOrg }),
  } as never
}

describe('urlForOrgBackend', () => {
  const ORIGINAL = { ...process.env }
  beforeEach(() => {
    process.env = { ...ORIGINAL, APP_URL: 'https://app.example.com' }
    process.env.BACKEND_CUSTOM_DOMAINS_ENABLED = '1'
    process.env.TRUSTED_PROXY_CIDRS = '10.0.0.0/8'
  })
  afterEach(() => { process.env = ORIGINAL })

  it('uses the organization backend domain when one is active', async () => {
    const url = await urlForOrgBackend(ORG, '/backend/orders/1', {
      container: container(async () => ({ hostname: 'crm.acme.com' })),
    })
    expect(url).toBe('https://crm.acme.com/backend/orders/1')
  })

  it('asks for the backend target, not the storefront one', async () => {
    // Without the filter an admin invite would resolve to the org's shop domain.
    const spy = jest.fn(async () => ({ hostname: 'crm.acme.com' }))
    await urlForOrgBackend(ORG, '/backend', { container: container(spy) })
    expect(spy).toHaveBeenCalledWith(ORG, 'backend')
  })

  it('falls back to the platform host when the org has no backend domain', async () => {
    const url = await urlForOrgBackend(ORG, '/backend', { container: container(async () => null) })
    expect(url).toBe('https://app.example.com/backend')
  })

  it('falls back to the platform host for an unknown organization', async () => {
    const url = await urlForOrgBackend(null, '/backend')
    expect(url).toBe('https://app.example.com/backend')
  })

  it('falls back rather than throwing when resolution fails', async () => {
    // A platform link beats a broken link.
    const url = await urlForOrgBackend(ORG, '/backend', {
      container: container(async () => { throw new Error('db down') }),
    })
    expect(url).toBe('https://app.example.com/backend')
  })

  it('does not consult the resolver when the feature is off', async () => {
    delete process.env.BACKEND_CUSTOM_DOMAINS_ENABLED
    const spy = jest.fn(async () => ({ hostname: 'crm.acme.com' }))
    const url = await urlForOrgBackend(ORG, '/backend', { container: container(spy) })
    expect(url).toBe('https://app.example.com/backend')
    expect(spy).not.toHaveBeenCalled()
  })

  it('normalizes a path without a leading slash', async () => {
    const url = await urlForOrgBackend(null, 'backend/x')
    expect(url).toBe('https://app.example.com/backend/x')
  })
})

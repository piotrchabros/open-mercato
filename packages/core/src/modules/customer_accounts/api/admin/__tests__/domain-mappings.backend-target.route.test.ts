/** @jest-environment node */

/**
 * Backend-target domain registration gating (#4271, task 3.7).
 *
 * Registering a backend domain decides which organization an operator acts on,
 * so it sits behind TWO independent gates: a deployment-level feature flag and
 * an ACL feature distinct from the portal-domain one.
 */

const mockGetAuth = jest.fn()
const mockUserHasAllFeatures = jest.fn()
const mockRegister = jest.fn()
const mockValidateGuard = jest.fn()
const mockRunGuardAfterSuccess = jest.fn()

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: (req: Request) => mockGetAuth(req),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (key: string) => {
      if (key === 'rbacService') return { userHasAllFeatures: mockUserHasAllFeatures }
      if (key === 'domainMappingService') {
        return {
          register: mockRegister,
          findByOrganization: jest.fn(async () => []),
          findById: jest.fn(async () => null),
          remove: jest.fn(async () => undefined),
        }
      }
      if (key === 'em') return {}
      throw new Error(`unexpected DI key ${key}`)
    },
  }),
}))

jest.mock('@open-mercato/shared/lib/crud/mutation-guard', () => ({
  validateCrudMutationGuard: (...args: unknown[]) => mockValidateGuard(...args),
  runCrudMutationGuardAfterSuccess: (...args: unknown[]) => mockRunGuardAfterSuccess(...args),
}))

import { POST } from '@open-mercato/core/modules/customer_accounts/api/admin/domain-mappings'

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '33333333-3333-4333-8333-333333333333'

function request(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/customer_accounts/admin/domain-mappings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST domain-mappings with target=backend', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...ORIGINAL_ENV }
    mockGetAuth.mockResolvedValue({ sub: 'user-1', tenantId: TENANT, orgId: ORG })
    mockValidateGuard.mockResolvedValue(null)
    mockRunGuardAfterSuccess.mockResolvedValue(undefined)
    mockRegister.mockResolvedValue({
      id: 'dm-1',
      hostname: 'crm.acme.com',
      status: 'pending',
      target: 'backend',
      organizationId: ORG,
      tenantId: TENANT,
      createdAt: new Date(),
      updatedAt: null,
    })
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  function enableFeatureFlag() {
    process.env.BACKEND_CUSTOM_DOMAINS_ENABLED = '1'
    process.env.TRUSTED_PROXY_CIDRS = '10.0.0.0/8'
  }

  it('rejects with 400 when the deployment flag is off, even for a privileged user', async () => {
    mockUserHasAllFeatures.mockResolvedValue(true)
    const res = await POST(request({ hostname: 'crm.acme.com', organizationId: ORG, target: 'backend' }))

    expect(res.status).toBe(400)
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it('rejects with 400 when the flag is on but no trusted proxy is declared', async () => {
    process.env.BACKEND_CUSTOM_DOMAINS_ENABLED = '1'
    mockUserHasAllFeatures.mockResolvedValue(true)
    const res = await POST(request({ hostname: 'crm.acme.com', organizationId: ORG, target: 'backend' }))

    expect(res.status).toBe(400)
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it('rejects with 403 when the caller lacks the backend-domain feature', async () => {
    enableFeatureFlag()
    // Holds domain.manage (first call) but not domain.manage_backend (second).
    mockUserHasAllFeatures.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const res = await POST(request({ hostname: 'crm.acme.com', organizationId: ORG, target: 'backend' }))

    expect(res.status).toBe(403)
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it('registers a backend mapping when both gates pass', async () => {
    enableFeatureFlag()
    mockUserHasAllFeatures.mockResolvedValue(true)
    const res = await POST(request({ hostname: 'crm.acme.com', organizationId: ORG, target: 'backend' }))

    expect(res.status).toBeLessThan(400)
    expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ target: 'backend' }))
  })

  it('still registers a portal mapping with only the portal feature and no flag', async () => {
    // The pre-#4271 path must be untouched: no flag, no second feature check.
    mockUserHasAllFeatures.mockResolvedValue(true)
    const res = await POST(request({ hostname: 'shop.acme.com', organizationId: ORG }))

    expect(res.status).toBeLessThan(400)
    expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ target: 'portal' }))
    expect(mockUserHasAllFeatures).toHaveBeenCalledTimes(1)
  })
})

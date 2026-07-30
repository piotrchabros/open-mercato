/** @jest-environment node */

/**
 * Coverage for getCustomerAuthForHost (packages/core/.../lib/customerAuthServer.ts:104-123).
 */

const cookieGet = jest.fn()

jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: cookieGet,
  }),
}))

const verifyAudienceJwt = jest.fn()
jest.mock('@open-mercato/shared/lib/auth/jwt', () => ({
  verifyAudienceJwt: (...args: unknown[]) => verifyAudienceJwt(...args),
}))

const validateUserState = jest.fn()
jest.mock('../customerAuth', () => ({
  validateUserState: (...args: unknown[]) => validateUserState(...args),
}))

const tryNormalizeHostname = jest.fn()
jest.mock('../hostname', () => ({
  tryNormalizeHostname: (...args: unknown[]) => tryNormalizeHostname(...args),
}))

const platformDomains = jest.fn(() => ['localhost', 'openmercato.com'])
jest.mock('../platformDomains', () => ({
  platformDomains: () => platformDomains(),
}))

const findActiveSessionById = jest.fn()
const resolveByHostname = jest.fn()
jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (name: string) => {
      if (name === 'customerSessionService') return { findActiveSessionById }
      if (name === 'domainMappingService') return { resolveByHostname }
      throw new Error(`unexpected resolve(${name})`)
    },
  }),
}))

const loggerWarn = jest.fn()
jest.mock('@open-mercato/shared/lib/logger', () => ({
  createLogger: () => ({
    child: () => ({ warn: loggerWarn }),
  }),
}))

import { getCustomerAuthForHost } from '../customerAuthServer'

const HOST_TENANT = '11111111-1111-1111-1111-111111111111'
const OTHER_TENANT = '22222222-2222-2222-2222-222222222222'

const baseJwtPayload = {
  type: 'customer',
  sid: 'sess-1',
  sub: 'user-1',
  tenantId: HOST_TENANT,
  orgId: 'org-1',
  email: 'u@example.com',
  displayName: 'U',
  customerEntityId: null,
  personEntityId: null,
  iat: 1000,
}

describe('getCustomerAuthForHost', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    cookieGet.mockReturnValue({ value: 'jwt-token' })
    findActiveSessionById.mockResolvedValue({ id: 'sess-1' })
    validateUserState.mockResolvedValue({ valid: true, resolvedFeatures: ['portal.view'] })
    verifyAudienceJwt.mockReturnValue(baseJwtPayload)
    platformDomains.mockReturnValue(['localhost', 'openmercato.com'])
  })

  it('reads the plain cookie with no host binding when host is null/undefined', async () => {
    const ctx = await getCustomerAuthForHost(null)
    expect(ctx).not.toBeNull()
    expect(ctx?.tenantId).toBe(HOST_TENANT)
    expect(tryNormalizeHostname).not.toHaveBeenCalled()
    expect(resolveByHostname).not.toHaveBeenCalled()

    const ctxUndefined = await getCustomerAuthForHost(undefined)
    expect(ctxUndefined).not.toBeNull()
  })

  it('reads the plain cookie (no tenant binding) when the host is unparseable', async () => {
    tryNormalizeHostname.mockReturnValue(null)
    const ctx = await getCustomerAuthForHost('not a host')
    expect(ctx).not.toBeNull()
    expect(ctx?.tenantId).toBe(HOST_TENANT)
    expect(resolveByHostname).not.toHaveBeenCalled()
  })

  it('reads the plain cookie (no tenant binding) when the host is a platform domain', async () => {
    tryNormalizeHostname.mockReturnValue('openmercato.com')
    platformDomains.mockReturnValue(['localhost', 'openmercato.com'])
    const ctx = await getCustomerAuthForHost('openmercato.com')
    expect(ctx).not.toBeNull()
    expect(resolveByHostname).not.toHaveBeenCalled()
  })

  it('resolves the host to a tenant and binds getCustomerAuthFromCookies with expectedTenantId on an active mapping', async () => {
    tryNormalizeHostname.mockReturnValue('shop.acme.com')
    resolveByHostname.mockResolvedValue({ tenantId: HOST_TENANT, status: 'active' })
    verifyAudienceJwt.mockReturnValue({ ...baseJwtPayload, tenantId: HOST_TENANT })

    const ctx = await getCustomerAuthForHost('shop.acme.com')
    expect(resolveByHostname).toHaveBeenCalledWith('shop.acme.com')
    expect(ctx).not.toBeNull()
    expect(ctx?.tenantId).toBe(HOST_TENANT)
  })

  it('returns null (fully unauthenticated) when the resolved mapping status is not active', async () => {
    tryNormalizeHostname.mockReturnValue('shop.acme.com')
    resolveByHostname.mockResolvedValue({ tenantId: HOST_TENANT, status: 'pending' })

    const ctx = await getCustomerAuthForHost('shop.acme.com')
    expect(ctx).toBeNull()
    // getCustomerAuthFromCookies must not even be attempted for a non-active mapping.
    expect(verifyAudienceJwt).not.toHaveBeenCalled()
  })

  it('rejects a JWT whose tenant differs from the host-resolved expectedTenantId (cross-host replay defense) by returning null, not throwing', async () => {
    tryNormalizeHostname.mockReturnValue('shop.acme.com')
    resolveByHostname.mockResolvedValue({ tenantId: HOST_TENANT, status: 'active' })
    verifyAudienceJwt.mockReturnValue({ ...baseJwtPayload, tenantId: OTHER_TENANT })

    await expect(getCustomerAuthForHost('shop.acme.com')).resolves.toBeNull()
  })

  it('fails OPEN to the unbound plain-cookie read when the resolver throws (deliberately pinned for now)', async () => {
    // Deliberately pinned current behavior: a resolver failure degrades the
    // cross-host replay defense to an unbound cookie read instead of failing
    // closed. .ai/specs/2026-07-30-organization-backend-custom-domains.md
    // (S4, risk R5) records that the backend equivalent must fail CLOSED
    // instead — do not change this test to assert fail-closed without also
    // changing the production behavior per that spec.
    tryNormalizeHostname.mockReturnValue('shop.acme.com')
    resolveByHostname.mockRejectedValue(new Error('domain mapping service unavailable'))

    const ctx = await getCustomerAuthForHost('shop.acme.com')
    expect(ctx).not.toBeNull()
    expect(ctx?.tenantId).toBe(HOST_TENANT)
    expect(loggerWarn).toHaveBeenCalledWith(
      'Domain resolve failed; falling back to platform cookie',
      expect.objectContaining({ err: expect.any(Error) }),
    )
  })
})

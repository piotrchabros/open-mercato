import { createConnectPrincipalKindReader } from '../principal-classification'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222'
const USER_A = '33333333-3333-4333-8333-333333333333'
const USER_B = '44444444-4444-4444-8444-444444444444'
const USER_C = '55555555-5555-4555-8555-555555555555'

function createHarness(options?: {
  rows?: Array<{ userId: string; kind: string }>
  activeIds?: readonly string[]
  missingAuth?: boolean
}) {
  const listClassifications = jest.fn(async () => options?.rows ?? [
    { userId: USER_A, kind: 'human' },
    { userId: USER_B, kind: 'system_bot' },
    { userId: USER_C, kind: 'integration' },
  ])
  const principalExists = jest.fn(async ({ id }: { id: string }) =>
    (options?.activeIds ?? [USER_A, USER_B, USER_C]).includes(id),
  )
  const reader = createConnectPrincipalKindReader({
    listClassifications,
    resolveAuthPrincipalService: () => options?.missingAuth ? null : { principalExists },
  })
  return { reader, listClassifications, principalExists }
}

describe('connectPrincipalKindReader', () => {
  it('returns valid active classifications in normalized input order', async () => {
    const harness = createHarness()

    await expect(harness.reader.resolve({
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      userIds: [USER_C.toUpperCase(), USER_A, USER_C, 'not-a-uuid', USER_B],
    })).resolves.toEqual([
      { userId: USER_C, kind: 'integration' },
      { userId: USER_A, kind: 'human' },
      { userId: USER_B, kind: 'system_bot' },
    ])
    expect(harness.listClassifications).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      userIds: [USER_C, USER_A, USER_B],
    })
  })

  it('normalizes stored UUIDs and ignores malformed runtime input', async () => {
    const harness = createHarness({
      rows: [
        { userId: USER_A.toUpperCase(), kind: 'human' },
        { userId: 'invalid', kind: 'human' },
      ],
    })

    await expect(harness.reader.resolve({
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      userIds: [USER_A, 42] as unknown as string[],
    })).resolves.toEqual([{ userId: USER_A, kind: 'human' }])
  })

  it('does not query dependencies for an empty normalized input', async () => {
    const harness = createHarness()

    await expect(harness.reader.resolve({
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      userIds: ['', 'invalid', '00000000-0000-0000-0000-000000000000'],
    })).resolves.toEqual([])
    expect(harness.listClassifications).not.toHaveBeenCalled()
    expect(harness.principalExists).not.toHaveBeenCalled()
  })

  it('rejects more than 100 unique valid identifiers', async () => {
    const harness = createHarness()
    const userIds = Array.from({ length: 101 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(12, '0')
      return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`
    })

    await expect(harness.reader.resolve({
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      userIds,
    })).rejects.toThrow('[internal] connect_principal_kind_limit_exceeded')
  })

  it('checks at most 10 Auth principals concurrently', async () => {
    const userIds = Array.from({ length: 25 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(12, '0')
      return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`
    })
    let activeChecks = 0
    let maximumChecks = 0
    const reader = createConnectPrincipalKindReader({
      listClassifications: async () => userIds.map((userId) => ({ userId, kind: 'human' })),
      resolveAuthPrincipalService: () => ({
        principalExists: async () => {
          activeChecks += 1
          maximumChecks = Math.max(maximumChecks, activeChecks)
          await Promise.resolve()
          activeChecks -= 1
          return true
        },
      }),
    })

    await expect(reader.resolve({
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      userIds,
    })).resolves.toHaveLength(25)
    expect(maximumChecks).toBe(10)
  })

  it('omits malformed, duplicate, inactive, and absent classifications', async () => {
    const harness = createHarness({
      rows: [
        { userId: USER_A, kind: 'human' },
        { userId: USER_A, kind: 'integration' },
        { userId: USER_B, kind: 'future_kind' },
        { userId: USER_C, kind: 'integration' },
      ],
      activeIds: [USER_A],
    })

    await expect(harness.reader.resolve({
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      userIds: [USER_A, USER_B, USER_C],
    })).resolves.toEqual([{ userId: USER_A, kind: 'human' }])
  })

  it('fails closed when classification storage or Auth is unavailable', async () => {
    const missingAuth = createHarness({ missingAuth: true })
    await expect(missingAuth.reader.resolve({
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      userIds: [USER_A],
    })).resolves.toEqual([])

    const reader = createConnectPrincipalKindReader({
      listClassifications: async () => {
        throw new Error('storage unavailable')
      },
      resolveAuthPrincipalService: () => ({ principalExists: async () => true }),
    })
    await expect(reader.resolve({
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      userIds: [USER_A],
    })).resolves.toEqual([])
  })

  it('fails closed per user when the Auth facade rejects', async () => {
    const reader = createConnectPrincipalKindReader({
      listClassifications: async () => [
        { userId: USER_A, kind: 'human' },
        { userId: USER_B, kind: 'human' },
      ],
      resolveAuthPrincipalService: () => ({
        principalExists: async ({ id }) => {
          if (id === USER_B) throw new Error('auth unavailable')
          return true
        },
      }),
    })

    await expect(reader.resolve({
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      userIds: [USER_A, USER_B],
    })).resolves.toEqual([{ userId: USER_A, kind: 'human' }])
  })
})

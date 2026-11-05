jest.mock('#generated/entities.ids.generated', () => ({
  E: {
    auth: { user: 'auth:user', role: 'auth:role' },
    directory: { organization: 'directory:organization' },
  },
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: async () => ({
    translate: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

jest.mock('@open-mercato/shared/lib/email/send', () => ({
  sendEmail: jest.fn(async () => undefined),
}))

jest.mock('@open-mercato/core/modules/auth/emails/InviteUserEmail', () => ({
  __esModule: true,
  default: jest.fn(() => '<email />'),
}))

const mockFindOneWithDecryption = jest.fn()
jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn((...args: unknown[]) => mockFindOneWithDecryption(...args)),
  findWithDecryption: jest.fn(async () => []),
}))

import '@open-mercato/core/modules/auth/commands/users'
import { commandRegistry } from '@open-mercato/shared/lib/commands/registry'
import { sendEmail } from '@open-mercato/shared/lib/email/send'
import type { CommandHandler, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { DataEngine } from '@open-mercato/shared/lib/data/engine'
import InviteUserEmail from '@open-mercato/core/modules/auth/emails/InviteUserEmail'
import type { User } from '../../data/entities'

const mockSendEmail = sendEmail as jest.MockedFunction<typeof sendEmail>

const orgId = 'e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0'
const tenantId = 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0'

type CreateUserResult = { user: User; warning?: 'invite_email_failed' }

function buildTestContext(resolver?: unknown) {
  const createdUser = {
    id: 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0',
    email: 'invited@example.com',
    emailHash: 'hash',
    passwordHash: null,
    isConfirmed: true,
    organizationId: orgId,
    tenantId,
    name: null,
  } as unknown as User

  const em: any = {
    findOne: jest.fn(async () => null),
    find: jest.fn(async () => []),
    create: jest.fn((_entity: unknown, data: unknown) => data),
    flush: jest.fn(async () => undefined),
    remove: jest.fn(function remove(this: any) { return this }),
    persist: jest.fn(function persist(this: any) { return this }),
    nativeDelete: jest.fn(async () => 0),
    fork: jest.fn(() => em),
  }

  const dataEngine = {
    createOrmEntity: jest.fn(async () => createdUser) as any,
    setCustomFields: jest.fn(async () => undefined) as DataEngine['setCustomFields'],
    emitOrmEntityEvent: (async () => undefined) as DataEngine['emitOrmEntityEvent'],
    markOrmEntityChange: jest.fn() as any,
    flushOrmEntityChanges: (async () => undefined) as DataEngine['flushOrmEntityChanges'],
  }

  const container = {
    resolve: (token: string) => {
      switch (token) {
        case 'dataEngine': return dataEngine
        case 'em': return em
        case 'rbacService': return {
          invalidateUserCache: jest.fn(async () => {}),
          loadAcl: jest.fn(async () => ({ isSuperAdmin: false, features: [], organizations: null })),
        }
        case 'cache': return { deleteByTags: jest.fn(async () => {}) }
        case 'notificationService': return { create: jest.fn(async () => ({})) }
        case 'organizationAppUrlResolver':
          if (!resolver) throw new Error('Unexpected dependency: organizationAppUrlResolver')
          return resolver
        default: throw new Error(`Unexpected dependency: ${token}`)
      }
    },
  }

  const ctx: CommandRuntimeContext = {
    container: container as any,
    auth: { sub: 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0', tenantId, orgId } as any,
    organizationScope: null,
    selectedOrganizationId: null,
    organizationIds: null,
    request: undefined as any,
  }

  // First call: organization lookup returns the org; second call: duplicate email check returns null
  mockFindOneWithDecryption
    .mockResolvedValueOnce({ id: orgId, tenant: { id: tenantId } })
    .mockResolvedValueOnce(null)

  return { em, dataEngine, ctx }
}

const inviteProps = () => (InviteUserEmail as unknown as jest.Mock).mock.calls[0][0] as { inviteUrl: string }

describe('auth.users.create — invite link base address', () => {
  const handler = commandRegistry.get<Record<string, unknown>, CreateUserResult>('auth.users.create') as CommandHandler<Record<string, unknown>, CreateUserResult>
  const input = { email: 'invited@example.com', sendInviteEmail: true, organizationId: orgId }

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.APP_URL = 'https://default.example.com'
  })

  it('uses the organization address when the resolver returns one', async () => {
    const resolveOwn = jest.fn(async () => 'https://crm.acme.example')
    const { ctx } = buildTestContext({ resolveOwn })

    await handler.execute(input, ctx)

    expect(resolveOwn).toHaveBeenCalledWith(orgId)
    expect(inviteProps().inviteUrl).toMatch(/^https:\/\/crm\.acme\.example\/reset\/.+/)
  })

  it('falls back to the default base URL when the resolver returns null', async () => {
    const { ctx } = buildTestContext({ resolveOwn: jest.fn(async () => null) })

    await handler.execute(input, ctx)

    expect(inviteProps().inviteUrl).toMatch(/^https:\/\/default\.example\.com\/reset\/.+/)
  })

  it('falls back to the default base URL when no resolver is registered', async () => {
    const { ctx } = buildTestContext()

    await handler.execute(input, ctx)

    expect(inviteProps().inviteUrl).toMatch(/^https:\/\/default\.example\.com\/reset\/.+/)
  })
})

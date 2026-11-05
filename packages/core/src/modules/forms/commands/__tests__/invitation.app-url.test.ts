import 'reflect-metadata'

const registered: Record<string, { execute: (input: unknown, ctx: unknown) => Promise<unknown> }> = {}

jest.mock('@open-mercato/shared/lib/commands', () => ({
  registerCommand: (handler: { id: string; execute: (input: unknown, ctx: unknown) => Promise<unknown> }) => {
    registered[handler.id] = handler
  },
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))

jest.mock('../shared', () => ({
  emitForms: jest.fn().mockResolvedValue(undefined),
  ensureOrganizationScope: jest.fn(),
  ensureTenantScope: jest.fn(),
  extractUndoPayload: jest.fn(),
  invalidateFormsCacheTags: jest.fn().mockResolvedValue(undefined),
  resolveActorUserId: jest.fn().mockReturnValue(null),
  resolveEntityManager: jest.fn(),
}))

jest.mock('../distribution', () => ({
  DISTRIBUTION_CACHE_TAGS: { distribution: (id: string) => `distribution:${id}` },
}))

jest.mock('../../subscribers/invitation-email', () => ({
  enqueueInvitationEmail: jest.fn().mockResolvedValue(false),
}))

jest.mock('../../services/distribution-token', () => ({
  generateRawInvitationToken: jest.fn().mockReturnValue('raw-token'),
  getInvitationTokenTtlSeconds: jest.fn().mockReturnValue(3600),
  hashInvitationToken: jest.fn().mockReturnValue('hashed'),
}))

import { enqueueInvitationEmail } from '../../subscribers/invitation-email'
import { resolveEntityManager } from '../shared'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import '../invitation'

const tenantId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const distributionId = '33333333-3333-4333-8333-333333333333'

function buildContext(resolveOwn?: jest.Mock) {
  const em = {
    fork: () => em,
    findOne: jest.fn().mockResolvedValue({ id: distributionId, mode: 'personal' }),
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ id: 'inv-1', sendCount: 0, ...data })),
    persist: jest.fn(),
    flush: jest.fn().mockResolvedValue(undefined),
  }
  ;(resolveEntityManager as jest.Mock).mockReturnValue(em)
  ;(findOneWithDecryption as jest.Mock).mockResolvedValue({ id: distributionId, mode: 'personal' })
  const container = {
    resolve: (name: string) => {
      if (name === 'organizationAppUrlResolver' && resolveOwn) return { resolveOwn }
      throw new Error(`unexpected resolve ${name}`)
    },
  }
  return { container, auth: null }
}

async function runCreate(ctx: unknown) {
  await registered['forms.invitation.create'].execute(
    {
      tenantId,
      organizationId,
      distributionId,
      recipients: [{ email: 'person@example.com' }],
    },
    ctx,
  )
  const call = (enqueueInvitationEmail as jest.Mock).mock.calls[0]
  return call?.[0]?.link as string | null | undefined
}

describe('forms.invitation.create personal link base', () => {
  const originalAppUrl = process.env.APP_URL

  beforeEach(() => {
    ;(enqueueInvitationEmail as jest.Mock).mockClear()
  })

  afterEach(() => {
    if (originalAppUrl === undefined) delete process.env.APP_URL
    else process.env.APP_URL = originalAppUrl
  })

  it('uses the organization address when one is set', async () => {
    process.env.APP_URL = 'https://default.example.com'
    const resolveOwn = jest.fn().mockResolvedValue('https://org.example.com')
    const link = await runCreate(buildContext(resolveOwn))
    expect(resolveOwn).toHaveBeenCalledWith(organizationId)
    expect(link).toBe('https://org.example.com/i/raw-token')
  })

  it('falls back to APP_URL when the organization has no address', async () => {
    process.env.APP_URL = 'https://default.example.com/'
    const link = await runCreate(buildContext(jest.fn().mockResolvedValue(null)))
    expect(link).toBe('https://default.example.com/i/raw-token')
  })

  it('returns no link when APP_URL is unset', async () => {
    delete process.env.APP_URL
    const resolveOwn = jest.fn().mockResolvedValue('https://org.example.com')
    const link = await runCreate(buildContext(resolveOwn))
    expect(link).toBeNull()
  })
})

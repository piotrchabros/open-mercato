/** @jest-environment node */
import { POST as sendQuote } from '@open-mercato/core/modules/sales/api/quotes/send/route'
import { SalesQuote } from '@open-mercato/core/modules/sales/data/entities'
import { Dictionary, DictionaryEntry } from '@open-mercato/core/modules/dictionaries/data/entities'
import { QuoteSentEmail } from '@open-mercato/core/modules/sales/emails/QuoteSentEmail'

const ORG_ID = '11111111-1111-4111-8111-111111111111'
const TENANT_ID = '00000000-0000-4000-8000-000000000000'

const mockResolveOwn = jest.fn()
const mockEm: Record<string, jest.Mock> = {
  fork: jest.fn(),
  findOne: jest.fn(),
  find: jest.fn(),
  persist: jest.fn(),
  flush: jest.fn(),
  transactional: jest.fn().mockImplementation(async (callback: (trx: any) => Promise<unknown>) => callback(mockEm)),
}

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: jest.fn(),
}))

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: jest.fn(async () => ({
    resolve: (token: string) => {
      if (token === 'em') return mockEm
      if (token === 'organizationAppUrlResolver') return { resolveOwn: mockResolveOwn }
      return null
    },
  })),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn().mockResolvedValue({
    translate: (_key: string, fallback?: string) => fallback ?? _key,
  }),
  detectLocale: jest.fn().mockResolvedValue('en'),
}))

jest.mock('@open-mercato/shared/lib/email/send', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@open-mercato/core/modules/sales/emails/QuoteSentEmail', () => ({
  QuoteSentEmail: jest.fn(() => null),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: jest.fn(),
}))

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/sales/quotes/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function readSentQuoteUrl(): string {
  return (QuoteSentEmail as jest.Mock).mock.calls[0][0].url as string
}

describe('quote send app url', () => {
  const originalAppUrl = process.env.APP_URL

  beforeEach(async () => {
    jest.clearAllMocks()
    mockEm.fork.mockReturnValue(mockEm)
    const { getAuthFromRequest } = await import('@open-mercato/shared/lib/auth/server')
    const { resolveOrganizationScopeForRequest } = await import('@open-mercato/core/modules/directory/utils/organizationScope')
    ;(getAuthFromRequest as jest.Mock).mockResolvedValue({
      sub: 'user-1',
      tenantId: TENANT_ID,
      orgId: ORG_ID,
      roles: ['admin'],
    })
    ;(resolveOrganizationScopeForRequest as jest.Mock).mockResolvedValue({
      selectedId: ORG_ID,
      filterIds: [ORG_ID],
      allowedIds: [ORG_ID],
    })
    const quote = {
      id: '22222222-2222-4222-8222-222222222222',
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      quoteNumber: 'SQ-1',
      currencyCode: 'USD',
      grandTotalGrossAmount: '10',
      status: 'draft',
      statusEntryId: null,
      customerSnapshot: { customer: { primaryEmail: 'test@example.com' } },
      metadata: null,
      updatedAt: new Date(),
      validUntil: null,
      sentAt: null,
      acceptanceToken: null,
    }
    mockEm.findOne.mockImplementation(async (cls: unknown, where: { id?: string }) => {
      if (cls === SalesQuote) return where?.id === quote.id ? quote : null
      if (cls === Dictionary) return { id: 'dict-1' }
      if (cls === DictionaryEntry) return { id: 'entry-sent' }
      return null
    })
  })

  afterEach(() => {
    if (originalAppUrl === undefined) delete process.env.APP_URL
    else process.env.APP_URL = originalAppUrl
  })

  test('uses the organization address when one is set', async () => {
    process.env.APP_URL = 'https://default.example.com'
    mockResolveOwn.mockResolvedValue('https://org.example.com/')

    const res = await sendQuote(makeRequest({ quoteId: '22222222-2222-4222-8222-222222222222', validForDays: 14 }))

    expect(res.status).toBe(200)
    expect(mockResolveOwn).toHaveBeenCalledWith(ORG_ID)
    expect(readSentQuoteUrl()).toMatch(/^https:\/\/org\.example\.com\/quote\/[0-9a-f-]{36}$/)
  })

  test('falls back to APP_URL when the organization has no address', async () => {
    process.env.APP_URL = 'https://default.example.com'
    mockResolveOwn.mockResolvedValue(null)

    const res = await sendQuote(makeRequest({ quoteId: '22222222-2222-4222-8222-222222222222', validForDays: 14 }))

    expect(res.status).toBe(200)
    expect(readSentQuoteUrl()).toMatch(/^https:\/\/default\.example\.com\/quote\/[0-9a-f-]{36}$/)
  })
})

import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { findPublicOffer, resolvePublicOfferRoute } from '../lib/public-offer'
import { getOfferGeneratorSettings } from '../lib/settings'

jest.mock('@open-mercato/shared/lib/encryption/find', () => ({
  findOneWithDecryption: jest.fn(),
}))

jest.mock('../lib/settings', () => ({
  getOfferGeneratorSettings: jest.fn(),
}))

const OFFER_ID = '6f1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f60'
const TENANT_ID = '7a1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f61'
const ORG_ID = '8b1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f62'
const TOKEN = 'abcdef123456'
const SEGMENT = `acme-2026-11-${TOKEN}`

type RoutingRow = { id: string; tenantId: string; organizationId: string; accessToken: string; status: string }

function buildEm(routing: RoutingRow | null) {
  const findOne = jest.fn().mockResolvedValue(routing)
  const em = { fork: jest.fn(() => ({ findOne })) }
  return { em: em as unknown as EntityManager, findOne }
}

const routingRow = (overrides: Partial<RoutingRow> = {}): RoutingRow => ({
  id: OFFER_ID,
  tenantId: TENANT_ID,
  organizationId: ORG_ID,
  accessToken: TOKEN,
  status: 'sent',
  ...overrides,
})

const findOneWithDecryptionMock = findOneWithDecryption as jest.MockedFunction<typeof findOneWithDecryption>
const getSettingsMock = getOfferGeneratorSettings as jest.MockedFunction<typeof getOfferGeneratorSettings>

describe('resolvePublicOfferRoute', () => {
  beforeEach(() => jest.clearAllMocks())

  it('rejects malformed segments without querying', async () => {
    const { em, findOne } = buildEm(routingRow())
    expect(await resolvePublicOfferRoute(em, 'nodash')).toBeNull()
    expect(await resolvePublicOfferRoute(em, 'acme-SHORT')).toBeNull()
    expect(findOne).not.toHaveBeenCalled()
  })

  it('looks the slug up globally and returns the route on a matching token', async () => {
    const { em, findOne } = buildEm(routingRow())
    const route = await resolvePublicOfferRoute(em, SEGMENT)
    expect(route).toEqual({ id: OFFER_ID, tenantId: TENANT_ID, organizationId: ORG_ID, status: 'sent' })
    expect(findOne).toHaveBeenCalledWith(
      expect.anything(),
      { slug: 'acme-2026-11', deletedAt: null, html: { $ne: null } },
      expect.objectContaining({ fields: expect.arrayContaining(['accessToken', 'status']) }),
    )
  })

  it('rejects a wrong token, a draft and a missing offer', async () => {
    expect(await resolvePublicOfferRoute(buildEm(routingRow({ accessToken: 'zzzzzz999999' })).em, SEGMENT)).toBeNull()
    expect(await resolvePublicOfferRoute(buildEm(routingRow({ status: 'draft' })).em, SEGMENT)).toBeNull()
    expect(await resolvePublicOfferRoute(buildEm(null).em, SEGMENT)).toBeNull()
  })
})

describe('findPublicOffer', () => {
  beforeEach(() => jest.clearAllMocks())

  it('returns the scoped record with the company name from settings', async () => {
    const { em } = buildEm(routingRow({ status: 'viewed' }))
    findOneWithDecryptionMock.mockResolvedValue({
      id: OFFER_ID,
      title: 'Website offer',
      clientName: 'Acme',
      html: '<!DOCTYPE html><html><body>Offer</body></html>',
      language: 'en',
      status: 'viewed',
    } as never)
    getSettingsMock.mockResolvedValue({ companyName: 'Studio' } as never)

    const record = await findPublicOffer(em, SEGMENT)

    expect(record).toEqual({
      id: OFFER_ID,
      tenantId: TENANT_ID,
      organizationId: ORG_ID,
      status: 'viewed',
      title: 'Website offer',
      clientName: 'Acme',
      html: '<!DOCTYPE html><html><body>Offer</body></html>',
      language: 'en',
      companyName: 'Studio',
    })
    expect(findOneWithDecryptionMock).toHaveBeenCalledWith(
      em,
      expect.anything(),
      { id: OFFER_ID, tenantId: TENANT_ID, organizationId: ORG_ID, deletedAt: null },
      expect.anything(),
      { tenantId: TENANT_ID, organizationId: ORG_ID },
    )
    expect(getSettingsMock).toHaveBeenCalledWith(em, { tenantId: TENANT_ID, organizationId: ORG_ID })
  })

  it('returns null when the scoped read finds no HTML', async () => {
    const { em } = buildEm(routingRow())
    findOneWithDecryptionMock.mockResolvedValue({ id: OFFER_ID, html: null, status: 'sent' } as never)
    expect(await findPublicOffer(em, SEGMENT)).toBeNull()
    expect(getSettingsMock).not.toHaveBeenCalled()
  })

  it('returns null for an invalid route', async () => {
    const { em } = buildEm(routingRow({ status: 'draft' }))
    expect(await findPublicOffer(em, SEGMENT)).toBeNull()
    expect(findOneWithDecryptionMock).not.toHaveBeenCalled()
  })
})

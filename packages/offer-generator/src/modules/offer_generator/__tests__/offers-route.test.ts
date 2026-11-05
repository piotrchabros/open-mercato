import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { buildOfferListFilters, metadata, resolveOfferListFields, toOfferDto } from '../api/offers/route'

jest.mock('@open-mercato/shared/lib/crud/factory', () => ({
  makeCrudRoute: jest.fn(() => ({ GET: jest.fn(), POST: jest.fn(), PUT: jest.fn(), DELETE: jest.fn() })),
}))

jest.mock('@open-mercato/shared/lib/i18n/server', () => ({
  resolveTranslations: jest.fn(async () => ({ translate: (_key: string, fallback: string) => fallback })),
}))

type CapturedCrudConfig = {
  indexer: { entityType: string }
  list: { fields: (query: Record<string, unknown>) => string[] }
  actions: Record<
    'create' | 'update' | 'delete',
    { commandId: string; mapInput: (args: { raw?: unknown; parsed?: unknown; ctx: unknown }) => Promise<unknown> }
  >
}

const crudConfig = (makeCrudRoute as jest.Mock).mock.calls[0][0] as CapturedCrudConfig

const ROW = {
  id: '6f1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f60',
  tenant_id: '7a1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f61',
  organization_id: '8b1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f62',
  owner_user_id: null,
  title: 'Website redesign',
  client_name: 'Acme',
  language: 'en',
  status: 'sent',
  customer_entity_id: '9c1c2b8e-1d4a-4e6b-8a7c-1b2c3d4e5f63',
  customer_kind: 'company',
  deal_id: null,
  slug: 'acme-2026-11',
  access_token: 'abcdef123456',
  html_updated_at: '2026-11-04T10:00:00.000Z',
  value_amount: '1200.50',
  currency_code: 'PLN',
  valid_until: '2026-12-31',
  sent_at: '2026-11-04T11:00:00.000Z',
  viewed_at: null,
  responded_at: null,
  view_count: '3',
  last_viewed_at: null,
  generation_status: 'idle',
  last_generation_run_id: null,
  created_at: '2026-11-01T09:00:00.000Z',
  updated_at: '2026-11-04T11:00:00.000Z',
}

describe('offers CRUD route', () => {
  it('gates reads on view and writes on manage', () => {
    expect(metadata.GET.requireFeatures).toEqual(['offer_generator.view'])
    expect(metadata.POST.requireFeatures).toEqual(['offer_generator.manage'])
    expect(metadata.PUT.requireFeatures).toEqual(['offer_generator.manage'])
    expect(metadata.DELETE.requireFeatures).toEqual(['offer_generator.manage'])
  })

  it('never selects html and only selects prompt and notes for a single offer', () => {
    const listFields = resolveOfferListFields({})
    const detailFields = resolveOfferListFields({ id: ROW.id })
    expect(listFields).not.toContain('html')
    expect(detailFields).not.toContain('html')
    expect(listFields).not.toContain('prompt')
    expect(listFields).not.toContain('notes')
    expect(detailFields).toEqual(expect.arrayContaining(['prompt', 'notes']))
  })

  it('maps list filters to columns', () => {
    expect(
      buildOfferListFilters({
        id: ROW.id,
        status: 'sent',
        customerEntityId: ROW.customer_entity_id,
        dealId: ROW.id,
        search: ' 50%_off ',
      }),
    ).toEqual({
      id: { $eq: ROW.id },
      status: { $eq: 'sent' },
      customer_entity_id: { $eq: ROW.customer_entity_id },
      deal_id: { $eq: ROW.id },
      $or: [{ title: { $ilike: '%50\\%\\_off%' } }, { client_name: { $ilike: '%50\\%\\_off%' } }],
    })
    expect(buildOfferListFilters({ search: '   ' })).toEqual({})
  })

  it('serializes a list row without prompt, notes or html', () => {
    const dto = toOfferDto(ROW)
    expect(dto).toMatchObject({
      id: ROW.id,
      clientName: 'Acme',
      customerKind: 'company',
      valueAmount: '1200.50',
      validUntil: '2026-12-31',
      viewCount: 3,
      hasHtml: true,
      updatedAt: ROW.updated_at,
    })
    expect(dto.publicUrl).toContain('/oferta/acme-2026-11-abcdef123456')
    expect(dto).not.toHaveProperty('prompt')
    expect(dto).not.toHaveProperty('notes')
    expect(dto).not.toHaveProperty('html')
  })

  it('wires command ids and scopes create input from the auth context', async () => {
    expect(crudConfig.indexer.entityType).toBe('offer_generator:offer')
    expect(crudConfig.actions.create.commandId).toBe('offer_generator.offers.create')
    expect(crudConfig.actions.update.commandId).toBe('offer_generator.offers.update')
    expect(crudConfig.actions.delete.commandId).toBe('offer_generator.offers.delete')
    expect(crudConfig.list.fields({ id: ROW.id })).toContain('prompt')

    const ctx = {
      auth: { tenantId: ROW.tenant_id, orgId: ROW.organization_id },
      selectedOrganizationId: ROW.organization_id,
    }
    const created = await crudConfig.actions.create.mapInput({
      raw: { title: 'Website redesign', clientName: 'Acme', language: 'pl' },
      ctx,
    })
    expect(created).toMatchObject({
      tenantId: ROW.tenant_id,
      organizationId: ROW.organization_id,
      title: 'Website redesign',
    })
    await expect(
      crudConfig.actions.delete.mapInput({ parsed: { body: { id: ROW.id } }, ctx }),
    ).resolves.toEqual({ id: ROW.id })
  })

  it('serializes prompt and notes for a detail row', () => {
    const dto = toOfferDto({ ...ROW, prompt: 'Write it', notes: null, html_updated_at: null })
    expect(dto.prompt).toBe('Write it')
    expect(dto.notes).toBeNull()
    expect(dto.hasHtml).toBe(false)
  })
})

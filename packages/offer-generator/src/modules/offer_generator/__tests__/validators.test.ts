import {
  generationStartSchema,
  offerCreateSchema,
  offerHtmlUpdateSchema,
  revisionRestoreSchema,
  trackingBodySchema,
  offerLanguageSchema,
  offerStatusSchema,
  offerUpdateSchema,
  settingsUpsertSchema,
} from '../data/validators'

const TENANT_ID = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
const ORG_ID = '6a2b9c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const OFFER_ID = '1f2e3d4c-5b6a-4978-8a6b-5c4d3e2f1a0b'

const validCreate = {
  tenantId: TENANT_ID,
  organizationId: ORG_ID,
  title: 'Website redesign',
  clientName: 'Acme Sp. z o.o.',
  language: 'pl',
}

describe('offerStatusSchema and offerLanguageSchema', () => {
  it('accepts known values only', () => {
    expect(offerStatusSchema.options).toEqual(['draft', 'sent', 'viewed', 'accepted', 'rejected'])
    expect(offerStatusSchema.safeParse('archived').success).toBe(false)
    expect(offerLanguageSchema.safeParse('en').success).toBe(true)
    expect(offerLanguageSchema.safeParse('de').success).toBe(false)
  })
})

describe('offerCreateSchema', () => {
  it('accepts a minimal payload', () => {
    expect(offerCreateSchema.safeParse(validCreate).success).toBe(true)
  })

  it('accepts a full payload and normalizes the currency code', () => {
    const parsed = offerCreateSchema.parse({
      ...validCreate,
      customerEntityId: OFFER_ID,
      customerKind: 'company',
      dealId: OFFER_ID,
      prompt: 'Landing page plus SEO package',
      valueAmount: 12500.5,
      currencyCode: 'pln',
      validUntil: '2026-12-31',
      notes: 'Call before sending',
      status: 'sent',
    })
    expect(parsed.currencyCode).toBe('PLN')
    expect(parsed.customerKind).toBe('company')
  })

  it('accepts null for the optional nullable fields', () => {
    const result = offerCreateSchema.safeParse({
      ...validCreate,
      customerEntityId: null,
      customerKind: null,
      dealId: null,
      prompt: null,
      valueAmount: null,
      currencyCode: null,
      validUntil: null,
      notes: null,
    })
    expect(result.success).toBe(true)
  })

  it.each([
    ['title too short', { title: 'A' }],
    ['title too long', { title: 'x'.repeat(201) }],
    ['client name too short', { clientName: ' ' }],
    ['unknown language', { language: 'de' }],
    ['unknown customer kind', { customerKind: 'lead' }],
    ['invalid customer id', { customerEntityId: 'nope' }],
    ['prompt too long', { prompt: 'x'.repeat(50001) }],
    ['negative value', { valueAmount: -1 }],
    ['value as string', { valueAmount: '100' }],
    ['currency code of wrong length', { currencyCode: 'PL' }],
    ['malformed valid-until date', { validUntil: '31.12.2026' }],
    ['impossible month', { validUntil: '2026-13-01' }],
    ['unknown status', { status: 'archived' }],
  ])('rejects %s', (_label, override) => {
    expect(offerCreateSchema.safeParse({ ...validCreate, ...override }).success).toBe(false)
  })

  it('requires tenant and organization ids', () => {
    expect(offerCreateSchema.safeParse({ ...validCreate, tenantId: undefined }).success).toBe(false)
    expect(offerCreateSchema.safeParse({ ...validCreate, organizationId: 'nope' }).success).toBe(false)
  })
})

describe('offerUpdateSchema', () => {
  it('requires only the id', () => {
    expect(offerUpdateSchema.safeParse({ id: OFFER_ID }).success).toBe(true)
    expect(offerUpdateSchema.safeParse({ title: 'Website redesign' }).success).toBe(false)
  })

  it('coerces lifecycle timestamps and allows clearing them', () => {
    const parsed = offerUpdateSchema.parse({
      id: OFFER_ID,
      status: 'accepted',
      sentAt: '2026-11-01T10:00:00.000Z',
      respondedAt: null,
    })
    expect(parsed.sentAt).toBeInstanceOf(Date)
    expect(parsed.respondedAt).toBeNull()
  })

  it('strips immutable public-link and html fields', () => {
    const parsed = offerUpdateSchema.parse({
      id: OFFER_ID,
      slug: 'hijacked',
      accessToken: 'abcdefghijkl',
      html: '<html></html>',
    })
    expect(parsed).toEqual({ id: OFFER_ID })
  })

  it('still validates partial fields', () => {
    expect(offerUpdateSchema.safeParse({ id: OFFER_ID, title: 'A' }).success).toBe(false)
    expect(offerUpdateSchema.safeParse({ id: OFFER_ID, sentAt: 'not a date' }).success).toBe(false)
  })
})

describe('settingsUpsertSchema', () => {
  const validSettings = {
    tenantId: TENANT_ID,
    organizationId: ORG_ID,
    companyName: 'Acme',
    templateHtml: '<!doctype html><html><body></body></html>',
    defaultLanguage: 'en',
    defaultCurrency: 'eur',
  }

  it('accepts settings and defaults the alternate models', () => {
    const parsed = settingsUpsertSchema.parse(validSettings)
    expect(parsed.defaultCurrency).toBe('EUR')
    expect(parsed.alternateModels).toEqual([])
  })

  it('rejects an empty template and too many alternate models', () => {
    expect(settingsUpsertSchema.safeParse({ ...validSettings, templateHtml: '' }).success).toBe(false)
    expect(
      settingsUpsertSchema.safeParse({
        ...validSettings,
        alternateModels: Array.from({ length: 21 }, (_, index) => `model-${index}`),
      }).success,
    ).toBe(false)
  })
})

describe('offerHtmlUpdateSchema', () => {
  it('enforces html length bounds', () => {
    expect(offerHtmlUpdateSchema.safeParse({ html: 'x'.repeat(199) }).success).toBe(false)
    expect(offerHtmlUpdateSchema.safeParse({ html: 'x'.repeat(200) }).success).toBe(true)
  })
})

describe('generationStartSchema', () => {
  it('allows generate without a prompt', () => {
    expect(generationStartSchema.safeParse({ kind: 'generate' }).success).toBe(true)
  })

  it('requires feedback for refine', () => {
    expect(generationStartSchema.safeParse({ kind: 'refine' }).success).toBe(false)
    expect(generationStartSchema.safeParse({ kind: 'refine', feedback: 'make it shorter' }).success).toBe(true)
  })

  it('rejects too short prompts and unknown kinds', () => {
    expect(generationStartSchema.safeParse({ kind: 'generate', prompt: 'short' }).success).toBe(false)
    expect(generationStartSchema.safeParse({ kind: 'other' }).success).toBe(false)
  })
})

describe('revisionRestoreSchema', () => {
  it('requires a uuid', () => {
    expect(revisionRestoreSchema.safeParse({ revisionId: OFFER_ID }).success).toBe(true)
    expect(revisionRestoreSchema.safeParse({ revisionId: 'nope' }).success).toBe(false)
  })
})

describe('trackingBodySchema', () => {
  it('discriminates start and beat bodies', () => {
    expect(trackingBodySchema.safeParse({ t: 'start', seg: 'abc', key: OFFER_ID, ref: null }).success).toBe(true)
    expect(trackingBodySchema.safeParse({ t: 'beat', seg: 'abc', key: OFFER_ID, ms: 10, sc: 50 }).success).toBe(true)
    expect(trackingBodySchema.safeParse({ t: 'beat', seg: 'ab', key: OFFER_ID, ms: 10, sc: 50 }).success).toBe(false)
    expect(trackingBodySchema.safeParse({ t: 'beat', seg: 'abc', key: OFFER_ID, ms: Infinity, sc: 50 }).success).toBe(false)
  })
})

import {
  amountMinorSchema,
  costInputCreateSchema,
  costInputListQuerySchema,
  costInputUpdateSchema,
  normalizeProviderReference,
  ProviderReferenceError,
} from '../validators'

const USER_ID = '33333333-3333-4333-8333-333333333333'
const CHANNEL_ID = '44444444-4444-4444-8444-444444444444'

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    periodStart: '2026-03-01T00:00:00.000Z',
    periodEnd: '2026-04-01T00:00:00.000Z',
    costType: 'ai',
    amountMinor: '125000',
    currencyCode: 'EUR',
    source: 'manual',
    ...overrides,
  }
}

function issueMessages(input: unknown, schema = costInputCreateSchema): string[] {
  const parsed = schema.safeParse(input)
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}

describe('amountMinorSchema', () => {
  it.each(['0', '1', '9223372036854775807'])('accepts the canonical value %s', (value) => {
    expect(amountMinorSchema.parse(value)).toBe(value)
  })

  it('accepts the exact bigint maximum and rejects one above it', () => {
    expect(amountMinorSchema.safeParse('9223372036854775807').success).toBe(true)
    expect(amountMinorSchema.safeParse('9223372036854775808').success).toBe(false)
  })

  it.each([
    ['a JSON number', 1250],
    ['a negative value', '-1'],
    ['an explicit plus sign', '+1'],
    ['a decimal', '12.50'],
    ['exponent notation', '1e3'],
    ['surrounding whitespace', ' 125 '],
    ['a leading zero', '0125'],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(amountMinorSchema.safeParse(value).success).toBe(false)
  })

  it('round-trips a value that JavaScript numbers cannot hold', () => {
    const value = '9007199254740993'
    const parsed = amountMinorSchema.parse(value)
    expect(BigInt(parsed).toString()).toBe(value)
    expect(String(Number(value))).not.toBe(value)
  })
})

describe('normalizeProviderReference', () => {
  it('applies NFC, trim, whitespace collapse and locale-independent lowercase', () => {
    expect(normalizeProviderReference('  INV\u00a0 2026\t0042  ')).toBe('inv 2026 0042')
  })

  it('composes decomposed characters so both spellings collide', () => {
    expect(normalizeProviderReference('CAF\u00c9-1')).toBe(normalizeProviderReference('CAFE\u0301-1'))
  })

  it('rejects control characters that are not whitespace', () => {
    expect(() => normalizeProviderReference('inv\u0000-1')).toThrow(ProviderReferenceError)
  })

  it('rejects an empty normalized result and an over-long one', () => {
    expect(() => normalizeProviderReference('   ')).toThrow(ProviderReferenceError)
    expect(() => normalizeProviderReference('x'.repeat(256))).toThrow(ProviderReferenceError)
    expect(normalizeProviderReference('x'.repeat(255))).toHaveLength(255)
  })
})

describe('costInputCreateSchema conditional dimensions', () => {
  it('accepts an agent row carrying only a user', () => {
    expect(costInputCreateSchema.safeParse(baseInput({ costType: 'agent', userId: USER_ID })).success).toBe(true)
  })

  it('accepts a channel row carrying only a channel', () => {
    expect(costInputCreateSchema.safeParse(baseInput({ costType: 'channel', channelId: CHANNEL_ID })).success).toBe(true)
  })

  it('accepts an AI row carrying neither', () => {
    expect(costInputCreateSchema.safeParse(baseInput()).success).toBe(true)
  })

  it.each([
    ['an agent row with no user', { costType: 'agent' }],
    ['an agent row that also carries a channel', { costType: 'agent', userId: USER_ID, channelId: CHANNEL_ID }],
    ['a channel row with no channel', { costType: 'channel' }],
    ['a channel row that also carries a user', { costType: 'channel', channelId: CHANNEL_ID, userId: USER_ID }],
    ['an AI row carrying a user', { costType: 'ai', userId: USER_ID }],
    ['an AI row carrying a channel', { costType: 'ai', channelId: CHANNEL_ID }],
  ])('rejects %s', (_label, overrides) => {
    expect(issueMessages(baseInput(overrides))).toContain('dimension_invalid')
  })
})

describe('costInputCreateSchema provenance', () => {
  it('accepts a provider row with both references and normalizes them', () => {
    const parsed = costInputCreateSchema.parse(baseInput({
      source: 'provider_invoice',
      providerInvoiceRef: '  INV-42 ',
      providerLineRef: 'Line  7',
    }))
    expect(parsed.providerInvoiceRef).toBe('inv-42')
    expect(parsed.providerLineRef).toBe('line 7')
  })

  it.each([
    ['a provider row missing the line reference', { source: 'provider_invoice', providerInvoiceRef: 'inv-42' }],
    ['a provider row missing the invoice reference', { source: 'provider_invoice', providerLineRef: 'line-7' }],
    ['a manual row carrying an invoice reference', { source: 'manual', providerInvoiceRef: 'inv-42' }],
    ['a manual row carrying a line reference', { source: 'manual', providerLineRef: 'line-7' }],
  ])('rejects %s', (_label, overrides) => {
    expect(issueMessages(baseInput(overrides))).toContain('provenance_invalid')
  })
})

describe('costInputCreateSchema periods and currency', () => {
  it('rejects an empty half-open period', () => {
    const sameInstant = { periodStart: '2026-03-01T00:00:00.000Z', periodEnd: '2026-03-01T00:00:00.000Z' }
    expect(issueMessages(baseInput(sameInstant))).toContain('period_invalid')
  })

  it('rejects an inverted period', () => {
    expect(issueMessages(baseInput({
      periodStart: '2026-04-01T00:00:00.000Z',
      periodEnd: '2026-03-01T00:00:00.000Z',
    }))).toContain('period_invalid')
  })

  it('accepts exactly 366 days and rejects one day more', () => {
    const start = '2026-01-01T00:00:00.000Z'
    expect(costInputCreateSchema.safeParse(baseInput({
      periodStart: start,
      periodEnd: '2027-01-02T00:00:00.000Z',
    })).success).toBe(true)
    expect(issueMessages(baseInput({
      periodStart: start,
      periodEnd: '2027-01-03T00:00:00.000Z',
    }))).toContain('period_too_large')
  })

  it('rejects a lowercase or malformed currency', () => {
    expect(issueMessages(baseInput({ currencyCode: 'eur' }))).toContain('currency_invalid')
    expect(issueMessages(baseInput({ currencyCode: 'EURO' }))).toContain('currency_invalid')
  })

  it('rejects unknown keys so a client cannot smuggle scope or actor fields', () => {
    expect(costInputCreateSchema.safeParse(baseInput({ tenantId: USER_ID })).success).toBe(false)
    expect(costInputCreateSchema.safeParse(baseInput({ createdByUserId: USER_ID })).success).toBe(false)
  })

  it('normalizes a blank description to null', () => {
    expect(costInputCreateSchema.parse(baseInput({ description: '   ' })).description).toBeNull()
    expect(issueMessages(baseInput({ description: 'x'.repeat(501) }))).toContain('description_too_long')
  })
})

describe('costInputUpdateSchema', () => {
  it('requires an id on top of the create fields', () => {
    expect(costInputUpdateSchema.safeParse(baseInput()).success).toBe(false)
    expect(costInputUpdateSchema.safeParse({ ...baseInput(), id: USER_ID }).success).toBe(true)
  })
})

describe('costInputListQuerySchema', () => {
  it('defaults page, pageSize and sort', () => {
    const parsed = costInputListQuerySchema.parse({})
    expect(parsed).toMatchObject({ page: 1, pageSize: 50, sortField: 'periodStart', sortDir: 'desc' })
  })

  it('caps pageSize at 100', () => {
    expect(costInputListQuerySchema.safeParse({ pageSize: '100' }).success).toBe(true)
    expect(costInputListQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false)
  })

  it('rejects an unlisted sort field', () => {
    expect(costInputListQuerySchema.safeParse({ sortField: 'description' }).success).toBe(false)
  })

  it('requires the overlap bounds together', () => {
    const messages = (input: unknown) => {
      const parsed = costInputListQuerySchema.safeParse(input)
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
    }
    expect(messages({ periodStart: '2026-03-01T00:00:00.000Z' })).toContain('period_invalid')
    expect(messages({ periodEnd: '2026-03-01T00:00:00.000Z' })).toContain('period_invalid')
    expect(costInputListQuerySchema.safeParse({
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    }).success).toBe(true)
  })

  it('caps the requested overlap span at 366 days', () => {
    const parsed = costInputListQuerySchema.safeParse({
      periodStart: '2026-01-01T00:00:00.000Z',
      periodEnd: '2027-01-03T00:00:00.000Z',
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown query parameters', () => {
    expect(costInputListQuerySchema.safeParse({ search: 'anything' }).success).toBe(false)
  })
})

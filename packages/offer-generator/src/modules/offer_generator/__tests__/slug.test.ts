import {
  buildBaseSlug,
  buildOfferSegment,
  buildPublicOfferUrl,
  ensureUniqueSlug,
  ensureUniqueSlugWith,
  generateAccessToken,
  parseOfferSegment,
  slugifyClientName,
  timingSafeEqualStrings,
} from '../lib/slug'

describe('slug helpers', () => {
  it('slugifies names with diacritics', () => {
    expect(slugifyClientName('Zażółć Gęślą Jaźń Sp. z o.o.')).toBe('zazolc-gesla-jazn-sp-z-o-o')
    expect(slugifyClientName('  --Acme & Co--  ')).toBe('acme-co')
    expect(slugifyClientName('!!!')).toBe('')
  })

  it('builds the base slug with year and month', () => {
    const now = new Date(Date.UTC(2026, 10, 5))
    expect(buildBaseSlug('Łódź Group', now)).toBe('lodz-group-2026-11')
    expect(buildBaseSlug('???', now)).toBe('oferta-2026-11')
  })

  it('generates 12 char lowercase alphanumeric tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateAccessToken()))
    expect(tokens.size).toBe(50)
    tokens.forEach((token) => expect(token).toMatch(/^[a-z0-9]{12}$/))
  })

  it('round-trips offer segments', () => {
    const token = generateAccessToken()
    const segment = buildOfferSegment('acme-2026-11', token)
    expect(parseOfferSegment(segment)).toEqual({ slug: 'acme-2026-11', token })
  })

  it('rejects malformed segments', () => {
    expect(parseOfferSegment('nodash')).toBeNull()
    expect(parseOfferSegment('-abcdefghij12')).toBeNull()
    expect(parseOfferSegment('acme-short')).toBeNull()
    expect(parseOfferSegment('acme-ABCDEFGHIJ12')).toBeNull()
    expect(parseOfferSegment('acme-abcdefghij123')).toBeNull()
  })

  it('compares strings in constant time', () => {
    expect(timingSafeEqualStrings('abc', 'abc')).toBe(true)
    expect(timingSafeEqualStrings('abc', 'abd')).toBe(false)
    expect(timingSafeEqualStrings('abc', 'abcd')).toBe(false)
  })

  it('builds public urls', () => {
    expect(buildPublicOfferUrl('acme-2026-11-abcdefghij12', 'https://crm.example.com/')).toBe(
      'https://crm.example.com/oferta/acme-2026-11-abcdefghij12',
    )
    expect(buildPublicOfferUrl('seg', undefined)).toBe('/oferta/seg')
  })
})

describe('ensureUniqueSlugWith', () => {
  it('returns the base when free', async () => {
    await expect(ensureUniqueSlugWith(async () => [], 'acme-2026-11')).resolves.toBe('acme-2026-11')
  })

  it('appends the first free numeric suffix', async () => {
    const lookup = async () => ['acme-2026-11', 'acme-2026-11-2']
    await expect(ensureUniqueSlugWith(lookup, 'acme-2026-11')).resolves.toBe('acme-2026-11-3')
  })

  it('falls back to a random hex suffix when 2..99 are taken', async () => {
    const taken = ['acme', ...Array.from({ length: 98 }, (_value, index) => `acme-${index + 2}`)]
    const slug = await ensureUniqueSlugWith(async () => taken, 'acme')
    expect(slug).toMatch(/^acme-[0-9a-f]{4}$/)
  })

  it('falls back to a random suffix when the lookup fails', async () => {
    const slug = await ensureUniqueSlugWith(async () => {
      throw new Error('db down')
    }, 'acme')
    expect(slug).toMatch(/^acme-[0-9a-f]{4}$/)
  })
})

describe('ensureUniqueSlug', () => {
  it('queries the offers table through the connection', async () => {
    const execute = jest.fn(async () => [{ slug: 'acme-2026-11' }, { slug: null }])
    const em = { getConnection: () => ({ execute }) }
    await expect(ensureUniqueSlug(em, 'acme-2026-11')).resolves.toBe('acme-2026-11-2')
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('offer_generator_offers'), [
      'acme-2026-11%',
      200,
    ])
  })
})

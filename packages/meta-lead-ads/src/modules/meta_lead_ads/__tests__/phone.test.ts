import { COUNTRY_CALLING_CODES, normalizePhoneToE164 } from '../lib/phone'

describe('normalizePhoneToE164', () => {
  it('strips separators from an international number', () => {
    const result = normalizePhoneToE164('+48 600-100.200')
    expect(result).toEqual({ raw: '+48 600-100.200', e164: '+48600100200', usableForMatching: true })
  })

  it('strips parentheses and slashes', () => {
    expect(normalizePhoneToE164('+1 (415) 555/2671').e164).toBe('+14155552671')
  })

  it('turns a leading 00 into a plus', () => {
    expect(normalizePhoneToE164('0049 30 1234567').e164).toBe('+49301234567')
  })

  it('prefixes national numbers with the default country code and drops the leading zero', () => {
    expect(normalizePhoneToE164('030 1234567', 'DE').e164).toBe('+49301234567')
  })

  it('falls back to PL when no default country is given', () => {
    expect(normalizePhoneToE164('600 100 200').e164).toBe('+48600100200')
    expect(normalizePhoneToE164('600100200', null).e164).toBe('+48600100200')
  })

  it('accepts a lowercase default country', () => {
    expect(normalizePhoneToE164('0301234567', 'de').e164).toBe('+49301234567')
  })

  it('rejects numbers with fewer than 7 digits', () => {
    expect(normalizePhoneToE164('+48 1234')).toEqual({ raw: '+48 1234', e164: null, usableForMatching: false })
    expect(normalizePhoneToE164('12345').usableForMatching).toBe(false)
  })

  it('rejects numbers with more than 15 digits', () => {
    expect(normalizePhoneToE164('+1234567890123456').usableForMatching).toBe(false)
    expect(normalizePhoneToE164('123456789012345').usableForMatching).toBe(false)
  })

  it('returns non-normalizable input as provided and flags it unusable', () => {
    expect(normalizePhoneToE164('call me maybe')).toEqual({
      raw: 'call me maybe',
      e164: null,
      usableForMatching: false,
    })
    expect(normalizePhoneToE164('')).toEqual({ raw: '', e164: null, usableForMatching: false })
  })

  it('flags national numbers with an unknown default country as unusable', () => {
    expect(normalizePhoneToE164('600100200', 'ZZ').usableForMatching).toBe(false)
  })

  it('covers EU, US, CA, UA and GB calling codes', () => {
    for (const country of ['PL', 'DE', 'FR', 'ES', 'IT', 'NL', 'US', 'CA', 'UA', 'GB']) {
      expect(COUNTRY_CALLING_CODES[country]).toMatch(/^\d{1,3}$/)
    }
  })
})

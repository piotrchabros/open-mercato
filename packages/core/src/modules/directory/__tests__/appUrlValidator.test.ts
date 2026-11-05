import { normalizeOrganizationAppUrl, organizationUpdateSchema } from '../data/validators'

const env = {
  NODE_ENV: 'production',
  APP_URL: 'https://app.example.com',
  APP_ALLOWED_ORIGINS: 'https://acme.example.com,https://beta.example.com',
}

describe('normalizeOrganizationAppUrl', () => {
  it('normalizes a trailing slash and upper case', () => {
    expect(normalizeOrganizationAppUrl('  https://ACME.example.com/  ', env)).toEqual({
      ok: true,
      value: 'https://acme.example.com',
    })
  })

  it.each([
    'https://acme.example.com/path',
    'https://acme.example.com/?a=1',
    'https://acme.example.com/#frag',
    'https://user:pass@acme.example.com',
    'not a url',
    'ftp://acme.example.com',
  ])('rejects %s as invalid', (value) => {
    expect(normalizeOrganizationAppUrl(value, env)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects http on a non-loopback host in production', () => {
    const httpEnv = { ...env, APP_ALLOWED_ORIGINS: 'http://acme.example.com' }
    expect(normalizeOrganizationAppUrl('http://acme.example.com', httpEnv)).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })

  it('accepts an equivalent loopback http origin in production', () => {
    const loopbackEnv = { NODE_ENV: 'production', APP_URL: 'http://127.0.0.1:3000' }
    expect(normalizeOrganizationAppUrl('http://localhost:3000', loopbackEnv)).toEqual({
      ok: true,
      value: 'http://localhost:3000',
    })
  })

  it('rejects an origin that is not in the allowed list', () => {
    expect(normalizeOrganizationAppUrl('https://evil.example.org', env)).toEqual({
      ok: false,
      reason: 'notAllowed',
    })
  })

  it('clears on empty string and null', () => {
    expect(normalizeOrganizationAppUrl('', env)).toEqual({ ok: true, value: null })
    expect(normalizeOrganizationAppUrl(null, env)).toEqual({ ok: true, value: null })
  })
})

describe('organizationUpdateSchema appUrl', () => {
  const id = '11111111-1111-4111-8111-111111111111'

  it('accepts a trimmed string, null and absence', () => {
    expect(organizationUpdateSchema.parse({ id, appUrl: ' https://a.example.com ' }).appUrl).toBe('https://a.example.com')
    expect(organizationUpdateSchema.parse({ id, appUrl: null }).appUrl).toBeNull()
    expect(organizationUpdateSchema.parse({ id }).appUrl).toBeUndefined()
  })
})

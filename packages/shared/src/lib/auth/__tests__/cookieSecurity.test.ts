/** @jest-environment node */
import { shouldUseSecureCookies } from '@open-mercato/shared/lib/auth/cookieSecurity'

function req(url: string, headers: Record<string, string> = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return { url, headers: { get: (n: string) => map.get(n.toLowerCase()) ?? null } }
}

describe('shouldUseSecureCookies', () => {
  it('defaults to secure with nothing configured', () => {
    // Safe direction: the failure mode is a rejected cookie over plain http in
    // development, not a session token sent in the clear in production.
    expect(shouldUseSecureCookies({ env: {} as NodeJS.ProcessEnv })).toBe(true)
  })

  it('is NOT derived from NODE_ENV', () => {
    // The fullapp compose stack runs NODE_ENV=development, which is exactly how
    // session cookies ended up without Secure in a production-shaped deploy.
    expect(shouldUseSecureCookies({ env: { NODE_ENV: 'development' } as NodeJS.ProcessEnv })).toBe(true)
  })

  it.each(['0', 'false', 'off'])('honours an explicit COOKIE_SECURE=%p', (value) => {
    expect(shouldUseSecureCookies({ env: { COOKIE_SECURE: value } as NodeJS.ProcessEnv })).toBe(false)
  })

  it('lets an explicit value beat the request scheme', () => {
    expect(
      shouldUseSecureCookies({
        env: { COOKIE_SECURE: 'false' } as NodeJS.ProcessEnv,
        request: req('https://app.example.com/x'),
      }),
    ).toBe(false)
  })

  it('follows x-forwarded-proto ahead of the request URL', () => {
    expect(
      shouldUseSecureCookies({
        env: {} as NodeJS.ProcessEnv,
        request: req('http://internal:3000/x', { 'x-forwarded-proto': 'https' }),
      }),
    ).toBe(true)
    expect(
      shouldUseSecureCookies({
        env: {} as NodeJS.ProcessEnv,
        request: req('https://internal/x', { 'x-forwarded-proto': 'http' }),
      }),
    ).toBe(false)
  })

  it('reads only the first hop of a comma-joined x-forwarded-proto', () => {
    expect(
      shouldUseSecureCookies({
        env: {} as NodeJS.ProcessEnv,
        request: req('http://internal/x', { 'x-forwarded-proto': 'https, http' }),
      }),
    ).toBe(true)
  })

  it('falls back to the request URL scheme', () => {
    expect(shouldUseSecureCookies({ env: {} as NodeJS.ProcessEnv, request: req('http://localhost:3000/x') })).toBe(false)
    expect(shouldUseSecureCookies({ env: {} as NodeJS.ProcessEnv, request: req('https://app.example.com/x') })).toBe(true)
  })
})

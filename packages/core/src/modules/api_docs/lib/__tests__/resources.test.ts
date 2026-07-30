import { resolveApiDocsBaseUrl } from '../resources'

describe('resolveApiDocsBaseUrl', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.NEXT_PUBLIC_API_BASE_URL
    delete process.env.NEXT_PUBLIC_APP_URL
    delete process.env.APP_URL
  })

  afterAll(() => {
    process.env = originalEnv
  })

  it('derives the API base URL from APP_URL by appending /api', () => {
    process.env.APP_URL = 'http://localhost:3000'

    expect(resolveApiDocsBaseUrl()).toBe('http://localhost:3000/api')
  })

  it('preserves an explicit API base URL override', () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'http://localhost:3000/api'
    process.env.APP_URL = 'http://localhost:3000'

    expect(resolveApiDocsBaseUrl()).toBe('http://localhost:3000/api')
  })

  it('appends /api to a nested public app URL', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.com/admin'

    expect(resolveApiDocsBaseUrl()).toBe('https://example.com/admin/api')
  })

  it('does not duplicate /api when the app URL already includes it', () => {
    process.env.APP_URL = 'https://example.com/api'

    expect(resolveApiDocsBaseUrl()).toBe('https://example.com/api')
  })
})

describe('resolveApiDocsBaseUrl without an configured app URL (#4271)', () => {
  const ORIGINAL = { ...process.env }
  afterEach(() => { process.env = { ...ORIGINAL } })

  it('falls back to a relative base rather than a platform-host absolute URL', () => {
    // An absolute URL built from APP_URL points at the platform host, so docs
    // served on an organization's own domain would offer a "try it" base
    // pointing elsewhere. Relative is correct on every host by construction.
    delete process.env.NEXT_PUBLIC_API_BASE_URL
    delete process.env.NEXT_PUBLIC_APP_URL
    delete process.env.APP_URL
    expect(resolveApiDocsBaseUrl()).toBe('/api')
  })

  it('still honours an explicit configured base', () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL
    process.env.APP_URL = 'https://app.example.com'
    expect(resolveApiDocsBaseUrl()).toBe('https://app.example.com/api')
  })
})

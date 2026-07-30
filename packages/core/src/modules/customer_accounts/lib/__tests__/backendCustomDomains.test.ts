/** @jest-environment node */
import {
  BackendCustomDomainsMisconfigured,
  assertBackendCustomDomainsConfig,
  backendCustomDomainsUsable,
  isBackendCustomDomainsEnabled,
} from '@open-mercato/core/modules/customer_accounts/lib/backendCustomDomains'

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv
}

describe('isBackendCustomDomainsEnabled', () => {
  it('defaults to off when unset', () => {
    expect(isBackendCustomDomainsEnabled(env({}))).toBe(false)
  })

  it.each(['1', 'true', 'yes', 'on', 'enabled'])('is on for %p', (value) => {
    expect(isBackendCustomDomainsEnabled(env({ BACKEND_CUSTOM_DOMAINS_ENABLED: value }))).toBe(true)
  })

  it.each(['0', 'false', 'no', 'off', 'disabled'])('is off for %p', (value) => {
    expect(isBackendCustomDomainsEnabled(env({ BACKEND_CUSTOM_DOMAINS_ENABLED: value }))).toBe(false)
  })

  it('is off for an unparseable value rather than truthy-by-presence', () => {
    // A bare `if (process.env.X)` would read 'maybe' as on. Opting into
    // host-derived org scope must be deliberate, so anything unrecognised
    // falls back to the safe default.
    expect(isBackendCustomDomainsEnabled(env({ BACKEND_CUSTOM_DOMAINS_ENABLED: 'maybe' }))).toBe(false)
  })
})

describe('assertBackendCustomDomainsConfig', () => {
  it('is a no-op when the feature is off, whatever else is set', () => {
    expect(() =>
      assertBackendCustomDomainsConfig(env({ OM_ALLOW_FORCED_HOST: '1' })),
    ).not.toThrow()
  })

  it('throws when enabled without a trusted-proxy assertion', () => {
    expect(() => assertBackendCustomDomainsConfig(env({ BACKEND_CUSTOM_DOMAINS_ENABLED: '1' }))).toThrow(
      BackendCustomDomainsMisconfigured,
    )
  })

  it('treats a blank TRUSTED_PROXY_CIDRS as absent', () => {
    expect(() =>
      assertBackendCustomDomainsConfig(
        env({ BACKEND_CUSTOM_DOMAINS_ENABLED: '1', TRUSTED_PROXY_CIDRS: '   ' }),
      ),
    ).toThrow(BackendCustomDomainsMisconfigured)
  })

  it('throws when enabled together with the forced-host override', () => {
    expect(() =>
      assertBackendCustomDomainsConfig(
        env({
          BACKEND_CUSTOM_DOMAINS_ENABLED: '1',
          TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
          OM_ALLOW_FORCED_HOST: '1',
        }),
      ),
    ).toThrow(/never be enabled together/)
  })

  it('passes when enabled and properly configured', () => {
    expect(() =>
      assertBackendCustomDomainsConfig(
        env({ BACKEND_CUSTOM_DOMAINS_ENABLED: '1', TRUSTED_PROXY_CIDRS: '10.0.0.0/8' }),
      ),
    ).not.toThrow()
  })
})

describe('backendCustomDomainsUsable', () => {
  it('is false when off', () => {
    expect(backendCustomDomainsUsable(env({}))).toBe(false)
  })

  it('is false when enabled but misconfigured, without throwing', () => {
    expect(backendCustomDomainsUsable(env({ BACKEND_CUSTOM_DOMAINS_ENABLED: '1' }))).toBe(false)
  })

  it('is true only when enabled and properly configured', () => {
    expect(
      backendCustomDomainsUsable(
        env({ BACKEND_CUSTOM_DOMAINS_ENABLED: '1', TRUSTED_PROXY_CIDRS: '10.0.0.0/8' }),
      ),
    ).toBe(true)
  })
})

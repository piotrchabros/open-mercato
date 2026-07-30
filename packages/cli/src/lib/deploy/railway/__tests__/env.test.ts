import {
  computeRailwayVariables,
  derivePlatformDomain,
  generateProtectedSecrets,
  parseEnvFile,
} from '../env'

describe('Railway environment variables', () => {
  it('parses common dotenv syntax', () => {
    expect(parseEnvFile(`
# comment
PLAIN=value
export QUOTED="hello world"
SINGLE='x'
`)).toEqual({
      PLAIN: 'value',
      QUOTED: 'hello world',
      SINGLE: 'x',
    })
  })

  it('generates missing protected secrets and preserves existing ones', () => {
    const secrets = generateProtectedSecrets({ AUTH_SECRET: 'existing' })
    expect(secrets.AUTH_SECRET).toBe('existing')
    expect(secrets.JWT_SECRET).toHaveLength(128)
    expect(secrets.TENANT_DATA_ENCRYPTION_FALLBACK_KEY.length).toBeGreaterThan(30)
  })

  it('computes app and worker settings without leaking Railway tokens', () => {
    const variables = computeRailwayVariables({
      env: {
        RAILWAY_API_TOKEN: 'never-upload',
        CUSTOM_SETTING: 'enabled',
      },
      role: 'app',
      workerEnabled: true,
      appUrl: 'https://example.up.railway.app',
      protectedSecrets: {
        AUTH_SECRET: 'auth',
        JWT_SECRET: 'jwt',
        TENANT_DATA_ENCRYPTION_FALLBACK_KEY: 'encryption',
      },
    })
    expect(variables).toMatchObject({
      DATABASE_URL: '${{Postgres.DATABASE_URL}}',
      REDIS_URL: '${{Redis.REDIS_URL}}',
      CACHE_STRATEGY: 'redis',
      QUEUE_STRATEGY: 'async',
      AUTO_SPAWN_WORKERS: 'false',
      PORT: '3000',
      APP_URL: 'https://example.up.railway.app',
      CUSTOM_SETTING: 'enabled',
    })
    expect(variables.RAILWAY_API_TOKEN).toBeUndefined()
  })

  it('injects PLATFORM_DOMAINS from the provisioned domain hostname', () => {
    const variables = computeRailwayVariables({
      env: {},
      role: 'app',
      workerEnabled: false,
      appUrl: 'https://mercato-production.up.railway.app',
      protectedSecrets: {
        AUTH_SECRET: 'auth',
        JWT_SECRET: 'jwt',
        TENANT_DATA_ENCRYPTION_FALLBACK_KEY: 'encryption',
      },
    })
    expect(variables.PLATFORM_DOMAINS).toBe('mercato-production.up.railway.app')
  })

  it('preserves an operator-supplied PLATFORM_DOMAINS value', () => {
    const variables = computeRailwayVariables({
      env: { PLATFORM_DOMAINS: 'custom.example.com,localhost' },
      role: 'app',
      workerEnabled: false,
      appUrl: 'https://mercato-production.up.railway.app',
      protectedSecrets: {
        AUTH_SECRET: 'auth',
        JWT_SECRET: 'jwt',
        TENANT_DATA_ENCRYPTION_FALLBACK_KEY: 'encryption',
      },
    })
    expect(variables.PLATFORM_DOMAINS).toBe('custom.example.com,localhost')
  })

  it('derives a lowercase, scheme-free hostname from a domain URL', () => {
    expect(derivePlatformDomain('https://Mercato-Prod.up.railway.app')).toBe(
      'mercato-prod.up.railway.app',
    )
    expect(derivePlatformDomain('https://example.com:3000/path')).toBe('example.com')
  })
})

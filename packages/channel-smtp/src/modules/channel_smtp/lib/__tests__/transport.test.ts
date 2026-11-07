import { buildTransportOptions, credentialsToConnection } from '../transport'

describe('credentialsToConnection', () => {
  it('carries the relay coordinates through unchanged, coercing the port to a number', () => {
    expect(credentialsToConnection({
      host: 'smtp.example.com',
      port: '587',
      tls: 'starttls',
      user: 'mailer',
      password: 'secret',
      fromAddress: 'no-reply@example.com',
    } as never)).toEqual({
      host: 'smtp.example.com',
      port: 587,
      tls: 'starttls',
      user: 'mailer',
      password: 'secret',
    })
  })
})

const pinned = { host: '203.0.113.10', servername: 'relay.example.com' }

describe('buildTransportOptions', () => {
  it('omits auth when no username is set', () => {
    const options = buildTransportOptions(
      { host: 'relay.example.com', port: 25, tls: 'starttls' },
      pinned,
      1000,
    )
    expect(options).not.toHaveProperty('auth')
    expect(options.requireTLS).toBe(true)
    expect(options.secure).toBe(false)
  })

  it('passes auth when a username is set', () => {
    const options = buildTransportOptions(
      { host: 'relay.example.com', port: 587, tls: 'starttls', user: 'mailer', password: 'secret' },
      pinned,
      1000,
    )
    expect(options.auth).toEqual({ user: 'mailer', pass: 'secret' })
  })

  it('carries absent credentials through credentialsToConnection', () => {
    const connection = credentialsToConnection({
      host: 'relay.example.com',
      port: 25,
      tls: 'starttls',
      fromAddress: 'no-reply@example.com',
    })
    expect(connection.user).toBeUndefined()
    expect(connection.password).toBeUndefined()
  })
})

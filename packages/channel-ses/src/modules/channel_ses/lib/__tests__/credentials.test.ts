import { sesCredentialsSchema } from '../credentials'

const base = { region: 'eu-west-2', fromAddress: 'from@example.com' }

describe('sesCredentialsSchema replyToAddress', () => {
  it('accepts credentials without replyToAddress', () => {
    const result = sesCredentialsSchema.safeParse(base)
    expect(result.success).toBe(true)
  })

  it('treats an empty replyToAddress as undefined', () => {
    const result = sesCredentialsSchema.safeParse({ ...base, replyToAddress: '' })
    expect(result.success).toBe(true)
    expect(result.success && result.data.replyToAddress).toBeUndefined()
  })

  it('accepts a valid replyToAddress', () => {
    const result = sesCredentialsSchema.safeParse({ ...base, replyToAddress: 'contact@example.com' })
    expect(result.success).toBe(true)
    expect(result.success && result.data.replyToAddress).toBe('contact@example.com')
  })

  it('rejects a malformed replyToAddress', () => {
    const result = sesCredentialsSchema.safeParse({ ...base, replyToAddress: 'not-an-email' })
    expect(result.success).toBe(false)
  })
})

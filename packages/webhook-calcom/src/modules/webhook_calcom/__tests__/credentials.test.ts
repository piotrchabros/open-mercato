import { calcomCredentialsSchema, resolveCalcomCredentials } from '../lib/credentials'
import { CALCOM_INTEGRATION_ID } from '../integration'

const scope = { tenantId: 't1', organizationId: 'o1' }

describe('calcom credentials', () => {
  it('defaults the unmatched attendee policy', () => {
    const parsed = calcomCredentialsSchema.parse({ webhookSecret: 's', instanceUrl: 'https://cal.example.com' })
    expect(parsed.unmatchedAttendeePolicy).toBe('create_person')
  })

  it('falls back to create_person for an unknown policy', () => {
    const parsed = calcomCredentialsSchema.parse({ webhookSecret: 's', instanceUrl: 'https://cal.example.com', unmatchedAttendeePolicy: 'bogus' })
    expect(parsed.unmatchedAttendeePolicy).toBe('create_person')
  })

  it('resolves stored credentials for the calcom integration id', async () => {
    const resolve = jest.fn().mockResolvedValue({ webhookSecret: 's', instanceUrl: 'https://cal.example.com', unmatchedAttendeePolicy: 'skip' })
    const result = await resolveCalcomCredentials({ resolve }, scope)
    expect(resolve).toHaveBeenCalledWith(CALCOM_INTEGRATION_ID, scope)
    expect(result?.unmatchedAttendeePolicy).toBe('skip')
  })

  it('returns null when missing or invalid', async () => {
    expect(await resolveCalcomCredentials({ resolve: async () => null }, scope)).toBeNull()
    expect(await resolveCalcomCredentials({ resolve: async () => ({ webhookSecret: '' }) }, scope)).toBeNull()
  })
})

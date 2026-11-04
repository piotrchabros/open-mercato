process.env.LOOKUP_HASH_PEPPER = 'meta-lead-ads-dedup-test-pepper'

import {
  EMAIL_HASH_CONTEXT,
  PHONE_HASH_CONTEXT,
  buildContactKeys,
  resolveDedupMatch,
  type DedupLookups,
} from '../lib/dedup'
import { hashForLookup } from '@open-mercato/shared/lib/encryption/aes'
import { normalizePhoneToE164 } from '../lib/phone'

type FakeLookupConfig = {
  emailKey?: string | null
  phoneKey?: string | null
  emailAddress?: string | null
  phoneScan?: string | null
}

function createFakeLookups(config: FakeLookupConfig = {}) {
  const calls: string[] = []
  const lookups: DedupLookups = {
    async findByEmailHash() {
      calls.push('findByEmailHash')
      return config.emailKey ?? null
    },
    async findByPhoneHash() {
      calls.push('findByPhoneHash')
      return config.phoneKey ?? null
    },
    async findPeopleByEmails() {
      calls.push('findPeopleByEmails')
      return config.emailAddress ? [config.emailAddress] : []
    },
    async scanRecentPeopleForPhone() {
      calls.push('scanRecentPeopleForPhone')
      return config.phoneScan ?? null
    },
  }
  return { lookups, calls }
}

const fullKeys = () => buildContactKeys(' Jan@Example.com ', normalizePhoneToE164('600 100 200', 'PL'))

describe('buildContactKeys', () => {
  it('normalizes the email and hashes it with the email context', () => {
    const keys = buildContactKeys('  Jan@Example.com ', null)
    expect(keys.email).toBe('jan@example.com')
    expect(keys.emailHash).toBe(hashForLookup('jan@example.com', EMAIL_HASH_CONTEXT))
    expect(keys.phoneE164).toBeNull()
    expect(keys.phoneHash).toBeNull()
  })

  it('hashes a usable phone with the phone context', () => {
    const keys = buildContactKeys(null, normalizePhoneToE164('+48 600 100 200'))
    expect(keys.phoneE164).toBe('+48600100200')
    expect(keys.phoneHash).toBe(hashForLookup('+48600100200', PHONE_HASH_CONTEXT))
    expect(keys.emailHash).toBeNull()
  })

  it('uses distinct contexts so the same value hashes differently as email and phone', () => {
    expect(EMAIL_HASH_CONTEXT).not.toBe(PHONE_HASH_CONTEXT)
    expect(hashForLookup('+48600100200', EMAIL_HASH_CONTEXT)).not.toBe(
      hashForLookup('+48600100200', PHONE_HASH_CONTEXT),
    )
  })

  it('ignores phones that are not usable for matching and blank emails', () => {
    const keys = buildContactKeys('   ', normalizePhoneToE164('abc'))
    expect(keys).toEqual({ email: null, phoneE164: null, emailHash: null, phoneHash: null })
  })
})

describe('resolveDedupMatch', () => {
  it('returns none without calling lookups when there are no keys', async () => {
    const { lookups, calls } = createFakeLookups({ emailKey: 'p-1' })
    const result = await resolveDedupMatch(lookups, buildContactKeys(null, null))
    expect(result).toEqual({ personId: null, matchType: 'none', conflictPersonId: null })
    expect(calls).toEqual([])
  })

  it('queries person keys first, then email addresses, then the phone scan', async () => {
    const { lookups, calls } = createFakeLookups()
    const result = await resolveDedupMatch(lookups, fullKeys())
    expect(calls).toEqual(['findByEmailHash', 'findByPhoneHash', 'findPeopleByEmails', 'scanRecentPeopleForPhone'])
    expect(result).toEqual({ personId: null, matchType: 'none', conflictPersonId: null })
  })

  it('skips fallbacks when person keys match both email and phone', async () => {
    const { lookups, calls } = createFakeLookups({ emailKey: 'p-1', phoneKey: 'p-1' })
    const result = await resolveDedupMatch(lookups, fullKeys())
    expect(calls).toEqual(['findByEmailHash', 'findByPhoneHash'])
    expect(result).toEqual({ personId: 'p-1', matchType: 'email', conflictPersonId: null })
  })

  it('matches by email through the address fallback', async () => {
    const { lookups } = createFakeLookups({ emailAddress: 'p-2' })
    const result = await resolveDedupMatch(lookups, fullKeys())
    expect(result).toEqual({ personId: 'p-2', matchType: 'email', conflictPersonId: null })
  })

  it('matches by phone through the scan when email has no match', async () => {
    const { lookups } = createFakeLookups({ phoneScan: 'p-3' })
    const result = await resolveDedupMatch(lookups, fullKeys())
    expect(result).toEqual({ personId: 'p-3', matchType: 'phone', conflictPersonId: null })
  })

  it('lets email win and reports a phone conflict with a different person', async () => {
    const { lookups } = createFakeLookups({ emailKey: 'p-1', phoneScan: 'p-9' })
    const result = await resolveDedupMatch(lookups, fullKeys())
    expect(result).toEqual({ personId: 'p-1', matchType: 'email', conflictPersonId: 'p-9' })
  })

  it('does not call the email fallback when only a phone is known', async () => {
    const { lookups, calls } = createFakeLookups({ phoneKey: 'p-4' })
    const result = await resolveDedupMatch(lookups, buildContactKeys(null, normalizePhoneToE164('+48600100200')))
    expect(calls).toEqual(['findByPhoneHash'])
    expect(result).toEqual({ personId: 'p-4', matchType: 'phone', conflictPersonId: null })
  })
})

import {
  _resetIdentityHashKeyCache,
  decideLinkState,
  hashHandle,
  maskHandle,
  normalizeHandle,
} from '../identity-resolver'

/**
 * Identity resolution decides whether Connect risks a cross-attach. Below the
 * threshold it must stay unresolved: guessing wrong puts one customer's message
 * on another's record, while an extra Case is merely untidy.
 */

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env.OM_CONNECT_IDENTITY_HASH_SECRET = 'test-identity-secret'
  _resetIdentityHashKeyCache()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  _resetIdentityHashKeyCache()
})

describe('normalizeHandle', () => {
  it('lower-cases and trims an email so one address is one identity', () => {
    expect(normalizeHandle('email', '  Alice@Example.COM ')).toBe('alice@example.com')
  })

  // Plus-addressing and dot-folding are provider-specific and would merge
  // handles a customer may intend to keep separate.
  it('leaves plus-addressing intact', () => {
    expect(normalizeHandle('email', 'alice+billing@example.com')).toBe('alice+billing@example.com')
  })

  it('only trims a non-email handle', () => {
    expect(normalizeHandle('phone', ' +48 500 100 200 ')).toBe('+48 500 100 200')
  })
})

describe('hashHandle', () => {
  it('is stable across spellings of the same address', () => {
    expect(hashHandle('email', 'Alice@Example.com')).toBe(hashHandle('email', 'alice@example.com'))
  })

  it('separates handle types with the same value', () => {
    expect(hashHandle('email', 'alice@example.com')).not.toBe(hashHandle('handle', 'alice@example.com'))
  })

  // Keyed, not a plain digest: a leaked table must not be brute-forceable
  // against a dictionary of known addresses.
  it('changes with the key', () => {
    const before = hashHandle('email', 'alice@example.com')
    process.env.OM_CONNECT_IDENTITY_HASH_SECRET = 'a-different-secret'
    _resetIdentityHashKeyCache()
    expect(hashHandle('email', 'alice@example.com')).not.toBe(before)
  })

  it('never contains the handle', () => {
    expect(hashHandle('email', 'alice@example.com')).not.toContain('alice')
  })
})

describe('maskHandle', () => {
  it('keeps a handle recognizable without making it reconstructable', () => {
    expect(maskHandle('alice@example.com')).toBe('a…e@example.com')
    expect(maskHandle('ab@example.com')).toBe('…@example.com')
    expect(maskHandle('opaque-handle')).toBe('o…e')
  })
})

describe('decideLinkState', () => {
  it('links a candidate at or above the threshold', () => {
    const candidate = { customerKind: 'person' as const, customerId: 'person-1', confidence: 90, matchMethod: 'email' }
    expect(decideLinkState(candidate, 80)).toEqual({ linkState: 'linked', match: candidate })
    expect(decideLinkState({ ...candidate, confidence: 80 }, 80)).toMatchObject({ linkState: 'linked' })
  })

  // Below the threshold the match is DISCARDED, not carried along as a hint:
  // keeping it would invite a later code path to use it anyway.
  it('stays unresolved below the threshold and drops the candidate', () => {
    const candidate = { customerKind: 'person' as const, customerId: 'person-1', confidence: 60, matchMethod: 'email' }
    expect(decideLinkState(candidate, 80)).toEqual({ linkState: 'unresolved', match: null })
  })

  it('stays unresolved with no candidate at all', () => {
    expect(decideLinkState(null, 80)).toEqual({ linkState: 'unresolved', match: null })
  })
})

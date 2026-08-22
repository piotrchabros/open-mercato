import {
  _resetThreadReaderCursorKeyCache,
  decodeThreadReaderCursor,
  encodeThreadReaderCursor,
  hashAllowlist,
  type ThreadReaderCursorPayload,
} from '../thread-reader-cursor'

/**
 * A cursor is a claim about what the holder was authorized to read, so it must
 * be unforgeable. These tests pin that editing any bound dimension — position,
 * allowlist, scope — invalidates it.
 */

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env.OM_THREAD_READER_CURSOR_SECRET = 'test-cursor-secret'
  _resetThreadReaderCursorKeyCache()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  _resetThreadReaderCursorKeyCache()
})

function payload(overrides: Partial<ThreadReaderCursorPayload> = {}): ThreadReaderCursorPayload {
  return {
    tenantId: 'tenant-1',
    organizationId: 'org-1',
    channelId: 'channel-1',
    authorizationEpoch: 'epoch-1',
    allowlistHash: hashAllowlist(['conv-a', 'conv-b']),
    pageSize: 50,
    afterCreatedAt: '2026-08-22T10:00:00.000Z',
    afterId: 'link-1',
    ...overrides,
  }
}

describe('hashAllowlist', () => {
  // Order and duplicates are not part of the caller's intent, so they must not
  // invalidate a cursor mid-page.
  it('is insensitive to order and duplicates', () => {
    expect(hashAllowlist(['b', 'a'])).toBe(hashAllowlist(['a', 'b', 'a']))
  })

  it('changes when the set changes', () => {
    expect(hashAllowlist(['a', 'b'])).not.toBe(hashAllowlist(['a', 'b', 'c']))
  })
})

describe('thread reader cursor', () => {
  it('round-trips a payload', () => {
    const original = payload()
    expect(decodeThreadReaderCursor(encodeThreadReaderCursor(original))).toEqual(original)
  })

  it('rejects a cursor whose body was edited', () => {
    const cursor = encodeThreadReaderCursor(payload())
    const [body, signature] = cursor.split('.')
    const tamperedBody = Buffer.from(
      JSON.stringify(payload({ allowlistHash: hashAllowlist(['conv-a', 'conv-b', 'conv-secret']) })),
      'utf8',
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '')
    expect(decodeThreadReaderCursor(`${tamperedBody}.${signature}`)).toBeNull()
    // The untouched cursor still verifies, so the rejection is the signature
    // check and not an unrelated parse failure.
    expect(decodeThreadReaderCursor(cursor)).not.toBeNull()
    void body
  })

  it('rejects a cursor signed with a different key', () => {
    const cursor = encodeThreadReaderCursor(payload())
    process.env.OM_THREAD_READER_CURSOR_SECRET = 'a-different-secret'
    _resetThreadReaderCursorKeyCache()
    expect(decodeThreadReaderCursor(cursor)).toBeNull()
  })

  it.each([
    ['not-a-cursor'],
    ['only-one-part'],
    ['a.b.c'],
    ['!!!.???'],
    [''],
  ])('rejects the malformed cursor %p', (value) => {
    expect(decodeThreadReaderCursor(value)).toBeNull()
  })
})

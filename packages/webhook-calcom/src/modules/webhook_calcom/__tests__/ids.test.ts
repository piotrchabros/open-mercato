import { calcomInteractionId, uuidV5 } from '../lib/ids'

const UUID_V5_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('uuidV5', () => {
  it('matches the RFC 4122 DNS namespace known vector', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
  })
})

describe('calcomInteractionId', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111'
  const organizationId = '22222222-2222-4222-8222-222222222222'

  it('is deterministic and a valid v5 uuid', () => {
    const first = calcomInteractionId(tenantId, organizationId, 'bk-uid-1')
    expect(first).toBe(calcomInteractionId(tenantId, organizationId, 'bk-uid-1'))
    expect(first).toMatch(UUID_V5_PATTERN)
  })

  it('differs per tenant, organization and uid', () => {
    const base = calcomInteractionId(tenantId, organizationId, 'bk-uid-1')
    expect(calcomInteractionId(organizationId, organizationId, 'bk-uid-1')).not.toBe(base)
    expect(calcomInteractionId(tenantId, tenantId, 'bk-uid-1')).not.toBe(base)
    expect(calcomInteractionId(tenantId, organizationId, 'bk-uid-2')).not.toBe(base)
  })
})

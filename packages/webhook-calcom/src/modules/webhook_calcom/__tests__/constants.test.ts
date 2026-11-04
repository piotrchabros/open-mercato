import { calcomLockKey } from '../lib/constants'

describe('calcom constants', () => {
  it('scopes the lock key by tenant and organization', () => {
    expect(calcomLockKey({ tenantId: 't1', organizationId: 'o1' })).toBe('calcom:sync:t1:o1')
    expect(calcomLockKey({ tenantId: 't1', organizationId: 'o2' })).not.toBe(calcomLockKey({ tenantId: 't1', organizationId: 'o1' }))
  })
})

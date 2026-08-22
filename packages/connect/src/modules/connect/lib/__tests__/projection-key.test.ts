import { CONNECT_PROJECTION_NAMESPACE, buildProjectionKey, buildSagaId } from '../projection-key'

/**
 * Both keys are DETERMINISTIC functions of durable state. That is the whole
 * point: a retry after a lost acknowledgement must recompute the identical key
 * so the peer recognises it as the same work rather than creating a second
 * projection or a second saga.
 */

describe('buildProjectionKey', () => {
  it('depends only on the case and the projection version', () => {
    const first = buildProjectionKey('case-1', 1)
    const second = buildProjectionKey('case-1', 1)
    expect(first).toBe(second)
  })

  it('changes when the projection version advances', () => {
    // Relinking to another customer must produce a NEW key, so the retracted
    // projection is not revived by the replacement.
    expect(buildProjectionKey('case-1', 1)).not.toBe(buildProjectionKey('case-1', 2))
  })

  it('separates cases', () => {
    expect(buildProjectionKey('case-1', 1)).not.toBe(buildProjectionKey('case-2', 1))
  })
})

describe('buildSagaId', () => {
  it('is stable for one identity association', () => {
    expect(buildSagaId('identity-1', 3)).toBe(buildSagaId('identity-1', 3))
  })

  it('changes with the association epoch', () => {
    // A later unlink must never reuse an earlier saga id, or the source would
    // treat a fresh retraction as an already-decided one.
    expect(buildSagaId('identity-1', 3)).not.toBe(buildSagaId('identity-1', 4))
  })
})

describe('CONNECT_PROJECTION_NAMESPACE', () => {
  it('is the frozen source namespace', () => {
    // Published to the peer contract; changing it would orphan every existing
    // saga and projection at the source.
    expect(CONNECT_PROJECTION_NAMESPACE).toBe('connect')
  })
})

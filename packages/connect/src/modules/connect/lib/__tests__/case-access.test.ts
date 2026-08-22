import { computeCaseAccessEpoch, evaluateCaseAccess } from '../case-access'

/**
 * The access matrix is what stands between an agent and another agent's
 * customer conversation. The one rule the earlier design got wrong is pinned
 * first: a handler must see UNASSIGNED Cases, or their Inbox is empty forever.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const ME = '55555555-5555-4555-8555-555555555555'
const OTHER = '66666666-6666-4666-8666-666666666666'

function subject(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    organizationId: ORG,
    assigneeUserId: null,
    status: 'new' as const,
    ...overrides,
  } as never
}

function actor(features: string[], userId = ME) {
  return { userId, tenantId: TENANT, organizationId: ORG, features }
}

const HANDLER = ['connect.inbox.handle']
const MANAGER = ['connect.inbox.handle', 'connect.cases.view.all', 'connect.cases.assign', 'connect.cases.manage']

describe('evaluateCaseAccess — the empty-inbox rule', () => {
  it('lets a handler see and claim an unassigned case', () => {
    const access = evaluateCaseAccess(subject(), actor(HANDLER))
    expect(access).toMatchObject({ canRead: true, canClaim: true })
  })

  it('lets a handler act on their own case', () => {
    const access = evaluateCaseAccess(subject({ assigneeUserId: ME }), actor(HANDLER))
    expect(access).toMatchObject({ canRead: true, canAct: true, canClaim: false })
  })

  // Not merely read-only — invisible. Telling an agent a case exists but
  // belongs to someone else is itself information about the queue.
  it('hides another handler\'s case entirely', () => {
    const access = evaluateCaseAccess(subject({ assigneeUserId: OTHER }), actor(HANDLER))
    expect(access.canRead).toBe(false)
    expect(access.canAct).toBe(false)
  })
})

describe('evaluateCaseAccess — scope', () => {
  it.each([
    ['another tenant', { tenantId: '99999999-9999-4999-8999-999999999999' }],
    ['a sibling organization', { organizationId: '33333333-3333-4333-8333-333333333333' }],
  ])('denies %s even to a manager', (_label, overrides) => {
    expect(evaluateCaseAccess(subject(overrides), actor(MANAGER)).canRead).toBe(false)
  })

  it('denies a caller with no Connect feature at all', () => {
    expect(evaluateCaseAccess(subject(), actor([])).canRead).toBe(false)
  })

  it('honours a wildcard grant', () => {
    expect(evaluateCaseAccess(subject({ assigneeUserId: OTHER }), actor(['connect.*'])).canRead).toBe(true)
  })
})

describe('evaluateCaseAccess — supervisory grants', () => {
  it('lets a manager read and act on another agent\'s case', () => {
    const access = evaluateCaseAccess(subject({ assigneeUserId: OTHER }), actor(MANAGER))
    expect(access).toMatchObject({ canRead: true, canAct: true, canAssign: true, canClose: true })
  })

  // Closing is terminal — a later inbound opens a successor — so it is gated
  // separately from resolving.
  it('does not let a plain handler close', () => {
    expect(evaluateCaseAccess(subject({ assigneeUserId: ME }), actor(HANDLER)).canClose).toBe(false)
  })

  it('lets a view-all manager read without granting assignment', () => {
    const access = evaluateCaseAccess(
      subject({ assigneeUserId: OTHER }),
      actor(['connect.inbox.handle', 'connect.cases.view.all']),
    )
    expect(access).toMatchObject({ canRead: true, canAssign: false, canClose: false })
    // Reading someone else's case does not imply acting on it.
    expect(access.canAct).toBe(false)
  })
})

describe('computeCaseAccessEpoch', () => {
  const base = { id: 'case-1', assigneeUserId: ME, updatedAt: new Date('2026-08-22T10:00:00.000Z') }

  it('is stable for an unchanged case', () => {
    expect(computeCaseAccessEpoch(base)).toBe(computeCaseAccessEpoch({ ...base }))
  })

  // The point of the epoch: a cursor minted before a transfer must not resume
  // after it, or the previous owner keeps paging through a conversation they
  // can no longer see.
  it('changes when the case is transferred', () => {
    expect(computeCaseAccessEpoch({ ...base, assigneeUserId: OTHER })).not.toBe(computeCaseAccessEpoch(base))
  })

  it('changes when the case is modified', () => {
    expect(
      computeCaseAccessEpoch({ ...base, updatedAt: new Date('2026-08-22T11:00:00.000Z') }),
    ).not.toBe(computeCaseAccessEpoch(base))
  })

  it('distinguishes unassigned from assigned', () => {
    expect(computeCaseAccessEpoch({ ...base, assigneeUserId: null })).not.toBe(computeCaseAccessEpoch(base))
  })
})

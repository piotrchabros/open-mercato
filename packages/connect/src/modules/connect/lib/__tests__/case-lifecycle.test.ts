import {
  evaluateAttach,
  statusAfterInbound,
  validateAttachWindows,
  validateTransition,
  type AttachCandidate,
} from '../case-lifecycle'

/**
 * The attach rule decides where a customer's message lands. Attaching wrongly
 * puts one customer's mail on another's Case — a disclosure — while opening an
 * extra Case is merely untidy, so every test below pins that the rule stays
 * biased toward opening.
 */

const WINDOWS = { attachWindowHours: 72, reopenWindowDays: 7, autoCloseAfterDays: 14 }
const NOW = new Date('2026-08-22T12:00:00.000Z')

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000)
}
function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)
}
function candidate(overrides: Partial<AttachCandidate> = {}): AttachCandidate {
  return { id: 'case-1', status: 'in_progress', lastInboundAt: hoursAgo(1), resolvedAt: null, ...overrides }
}

describe('validateTransition', () => {
  it.each([
    ['new', 'in_progress'],
    ['in_progress', 'waiting_customer'],
    ['waiting_customer', 'in_progress'],
    ['resolved', 'in_progress'],
    ['waiting_customer', 'closed'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(validateTransition(from, to)).toEqual({ ok: true, from, to })
  })

  // `closed` is terminal so that the state means something in reporting, and so
  // a months-old Case cannot silently reopen.
  it.each(['new', 'in_progress', 'waiting_customer', 'resolved'] as const)(
    'refuses to leave closed for %s',
    (to) => {
      expect(validateTransition('closed', to)).toEqual({ ok: false, reason: 'terminal' })
    },
  )

  it('refuses an illegal jump', () => {
    expect(validateTransition('resolved', 'waiting_customer')).toEqual({
      ok: false,
      reason: 'illegal_transition',
    })
  })

  // Recording an audit row for a change that did not happen would pollute the
  // resolution-time metrics that read those rows.
  it('treats a same-state transition as a no-op, not a legal transition', () => {
    expect(validateTransition('in_progress', 'in_progress')).toEqual({ ok: false, reason: 'no_op' })
  })

  it('rejects an unknown status', () => {
    expect(validateTransition('nonsense' as never, 'new')).toEqual({ ok: false, reason: 'unknown_status' })
  })
})

describe('statusAfterInbound', () => {
  it('moves waiting_customer to in_progress when the customer answers', () => {
    expect(statusAfterInbound('waiting_customer')).toBe('in_progress')
  })

  it('reopens a resolved Case', () => {
    expect(statusAfterInbound('resolved')).toBe('in_progress')
  })

  // An inbound must not drag a new Case into in_progress before an agent has
  // touched it — that would make the "new" queue silently empty itself.
  it.each(['new', 'in_progress', 'closed'] as const)('leaves %s alone', (status) => {
    expect(statusAfterInbound(status)).toBe(status)
  })
})

describe('validateAttachWindows', () => {
  it('accepts a sane configuration', () => {
    expect(validateAttachWindows(WINDOWS)).toEqual({ ok: true })
  })

  // A reopen window longer than auto-close is unreachable: the Case closes
  // while it is still meant to be reopenable.
  it('refuses a reopen window longer than the auto-close window', () => {
    expect(validateAttachWindows({ ...WINDOWS, reopenWindowDays: 30 })).toEqual({
      ok: false,
      field: 'reopenWindowDays',
    })
  })

  it.each([
    ['attachWindowHours', { ...WINDOWS, attachWindowHours: -1 }],
    ['reopenWindowDays', { ...WINDOWS, reopenWindowDays: 1.5 }],
    ['autoCloseAfterDays', { ...WINDOWS, autoCloseAfterDays: -3 }],
  ])('rejects a malformed %s', (field, windows) => {
    expect(validateAttachWindows(windows)).toEqual({ ok: false, field })
  })
})

describe('evaluateAttach', () => {
  // The single most consequential rule: an unresolved identity must never
  // cross-attach, because we do not know whose conversation it is.
  it('always opens for an unresolved identity, even with a live candidate', () => {
    expect(
      evaluateAttach({
        identityLinked: false,
        boundCase: candidate(),
        legacyCandidates: [candidate({ id: 'case-2' })],
        windows: WINDOWS,
        now: NOW,
      }),
    ).toEqual({ decision: 'open', reason: 'identity_unresolved' })
  })

  it('attaches a linked identity to its bound Case', () => {
    expect(
      evaluateAttach({
        identityLinked: true,
        boundCase: candidate({ status: 'waiting_customer' }),
        legacyCandidates: [],
        windows: WINDOWS,
        now: NOW,
      }),
    ).toEqual({ decision: 'attach', caseId: 'case-1', nextStatus: 'in_progress' })
  })

  it('prefers the bound Case over a legacy candidate', () => {
    const decision = evaluateAttach({
      identityLinked: true,
      boundCase: candidate({ id: 'bound' }),
      legacyCandidates: [candidate({ id: 'legacy' })],
      windows: WINDOWS,
      now: NOW,
    })
    expect(decision).toMatchObject({ decision: 'attach', caseId: 'bound' })
  })

  it('opens when there is no candidate at all', () => {
    expect(
      evaluateAttach({ identityLinked: true, boundCase: null, legacyCandidates: [], windows: WINDOWS, now: NOW }),
    ).toEqual({ decision: 'open', reason: 'no_candidate' })
  })

  // A closed Case is terminal; the successor chain is how history stays
  // append-only.
  it('opens a successor rather than reviving a closed Case', () => {
    expect(
      evaluateAttach({
        identityLinked: true,
        boundCase: candidate({ status: 'closed' }),
        legacyCandidates: [],
        windows: WINDOWS,
        now: NOW,
      }),
    ).toEqual({ decision: 'open', reason: 'candidate_closed' })
  })

  // A Case nobody has touched for weeks is not the conversation this message
  // belongs to, even if it is technically still open.
  it('opens when the attach window has expired', () => {
    expect(
      evaluateAttach({
        identityLinked: true,
        boundCase: candidate({ lastInboundAt: hoursAgo(100) }),
        legacyCandidates: [],
        windows: WINDOWS,
        now: NOW,
      }),
    ).toEqual({ decision: 'open', reason: 'attach_window_expired' })
  })

  it('attaches at the exact edge of the attach window', () => {
    expect(
      evaluateAttach({
        identityLinked: true,
        boundCase: candidate({ lastInboundAt: hoursAgo(72) }),
        legacyCandidates: [],
        windows: WINDOWS,
        now: NOW,
      }),
    ).toMatchObject({ decision: 'attach' })
  })

  it('reopens a resolved Case inside the reopen window', () => {
    expect(
      evaluateAttach({
        identityLinked: true,
        boundCase: candidate({ status: 'resolved', resolvedAt: daysAgo(3), lastInboundAt: daysAgo(3) }),
        legacyCandidates: [],
        windows: WINDOWS,
        now: NOW,
      }),
    ).toEqual({ decision: 'attach', caseId: 'case-1', nextStatus: 'in_progress' })
  })

  // Outside the reopen window the customer is almost certainly raising a new
  // matter that happens to share a thread.
  it('opens when the reopen window has expired', () => {
    expect(
      evaluateAttach({
        identityLinked: true,
        boundCase: candidate({ status: 'resolved', resolvedAt: daysAgo(30), lastInboundAt: daysAgo(30) }),
        legacyCandidates: [],
        windows: WINDOWS,
        now: NOW,
      }),
    ).toEqual({ decision: 'open', reason: 'reopen_window_expired' })
  })

  it('falls through an ineligible bound Case to an eligible legacy candidate', () => {
    const decision = evaluateAttach({
      identityLinked: true,
      boundCase: candidate({ id: 'stale', lastInboundAt: hoursAgo(200) }),
      legacyCandidates: [candidate({ id: 'fresh', lastInboundAt: hoursAgo(2) })],
      windows: WINDOWS,
      now: NOW,
    })
    expect(decision).toMatchObject({ decision: 'attach', caseId: 'fresh' })
  })

  it('attaches a Case that has never received inbound', () => {
    expect(
      evaluateAttach({
        identityLinked: true,
        boundCase: candidate({ status: 'new', lastInboundAt: null }),
        legacyCandidates: [],
        windows: WINDOWS,
        now: NOW,
      }),
    ).toMatchObject({ decision: 'attach', nextStatus: 'new' })
  })
})

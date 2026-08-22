import type { ConnectCaseStatus } from '../data/entities'

/**
 * Case lifecycle and the inbound attach rule.
 *
 * Kept as pure functions with no database access so the rules that decide where
 * a customer's message lands can be exhaustively tested, and so ingest and the
 * later Inbox commands provably share one implementation rather than drifting
 * into two.
 */

export const CONNECT_CASE_STATUSES: readonly ConnectCaseStatus[] = [
  'new',
  'in_progress',
  'waiting_customer',
  'resolved',
  'closed',
]

/**
 * Legal transitions.
 *
 * `closed` is terminal and has no outgoing edges. A customer who writes again
 * after a Case closed gets a SUCCESSOR Case carrying `previousCaseId`, not a
 * revived one — reviving would make "closed" meaningless for reporting and
 * would let a months-old Case silently reopen.
 */
const LEGAL_TRANSITIONS: Readonly<Record<ConnectCaseStatus, readonly ConnectCaseStatus[]>> = {
  new: ['in_progress', 'waiting_customer', 'resolved', 'closed'],
  in_progress: ['waiting_customer', 'resolved', 'closed'],
  waiting_customer: ['in_progress', 'resolved', 'closed'],
  resolved: ['in_progress', 'closed'],
  closed: [],
}

export type TransitionResult =
  | { ok: true; from: ConnectCaseStatus; to: ConnectCaseStatus }
  | { ok: false; reason: 'unknown_status' | 'terminal' | 'illegal_transition' | 'no_op' }

/**
 * Validate a lifecycle transition.
 *
 * A same-state transition is `no_op` rather than legal: recording an audit row
 * for a change that did not happen would pollute the resolution-time metrics
 * that read those rows.
 */
export function validateTransition(
  from: ConnectCaseStatus,
  to: ConnectCaseStatus,
): TransitionResult {
  if (!CONNECT_CASE_STATUSES.includes(from) || !CONNECT_CASE_STATUSES.includes(to)) {
    return { ok: false, reason: 'unknown_status' }
  }
  if (from === to) return { ok: false, reason: 'no_op' }
  if (from === 'closed') return { ok: false, reason: 'terminal' }
  if (!LEGAL_TRANSITIONS[from].includes(to)) return { ok: false, reason: 'illegal_transition' }
  return { ok: true, from, to }
}

/**
 * The status an inbound message moves an attached Case to.
 *
 * `waiting_customer` → `in_progress` because the customer just answered.
 * `resolved` → `in_progress` reopens, but only within the reopen window (the
 * caller checks that separately — see {@link evaluateAttach}). Everything else
 * stays where it is; an inbound must not, for example, drag a `new` Case into
 * `in_progress` before an agent has touched it.
 */
export function statusAfterInbound(current: ConnectCaseStatus): ConnectCaseStatus {
  if (current === 'waiting_customer') return 'in_progress'
  if (current === 'resolved') return 'in_progress'
  return current
}

export type AttachWindows = {
  attachWindowHours: number
  reopenWindowDays: number
  autoCloseAfterDays: number
}

export type AttachCandidate = {
  id: string
  status: ConnectCaseStatus
  lastInboundAt: Date | null
  resolvedAt: Date | null
}

export type AttachDecision =
  | { decision: 'attach'; caseId: string; nextStatus: ConnectCaseStatus }
  | { decision: 'open'; reason: AttachRejection }

export type AttachRejection =
  | 'identity_unresolved'
  | 'no_candidate'
  | 'candidate_closed'
  | 'attach_window_expired'
  | 'reopen_window_expired'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * Validate the window configuration.
 *
 * `reopenWindowDays > autoCloseAfterDays` is nonsensical: a Case would auto-close
 * while it was still meant to be reopenable, so a customer's reply would open a
 * successor even though the operator intended it to reopen the original.
 */
export function validateAttachWindows(windows: AttachWindows): { ok: true } | { ok: false; field: string } {
  if (!Number.isInteger(windows.attachWindowHours) || windows.attachWindowHours < 0) {
    return { ok: false, field: 'attachWindowHours' }
  }
  if (!Number.isInteger(windows.reopenWindowDays) || windows.reopenWindowDays < 0) {
    return { ok: false, field: 'reopenWindowDays' }
  }
  if (!Number.isInteger(windows.autoCloseAfterDays) || windows.autoCloseAfterDays < 0) {
    return { ok: false, field: 'autoCloseAfterDays' }
  }
  if (windows.reopenWindowDays > windows.autoCloseAfterDays) {
    return { ok: false, field: 'reopenWindowDays' }
  }
  return { ok: true }
}

/**
 * Decide whether an inbound attaches to an existing Case or opens a new one.
 *
 * The single most consequential rule in Connect: attaching wrongly puts one
 * customer's message on another's Case. It is therefore conservative — every
 * uncertainty opens a new Case, which is recoverable, rather than attaching,
 * which is a disclosure.
 *
 * Candidates must already be scoped to one tenant + organization + customer by
 * the caller and ordered `lastInboundAt DESC, id ASC`; this function only
 * applies the eligibility rules.
 */
export function evaluateAttach(input: {
  identityLinked: boolean
  boundCase: AttachCandidate | null
  legacyCandidates: readonly AttachCandidate[]
  windows: AttachWindows
  now: Date
}): AttachDecision {
  // An unresolved identity never cross-attaches. We do not know who this is, so
  // any attach would be a guess about whose conversation it belongs to.
  if (!input.identityLinked) return { decision: 'open', reason: 'identity_unresolved' }

  const ordered = input.boundCase
    ? [input.boundCase, ...input.legacyCandidates.filter((c) => c.id !== input.boundCase!.id)]
    : [...input.legacyCandidates]

  if (ordered.length === 0) return { decision: 'open', reason: 'no_candidate' }

  let lastRejection: AttachRejection = 'no_candidate'
  for (const candidate of ordered) {
    const eligibility = evaluateCandidate(candidate, input.windows, input.now)
    if (eligibility.eligible) {
      return {
        decision: 'attach',
        caseId: candidate.id,
        nextStatus: statusAfterInbound(candidate.status),
      }
    }
    lastRejection = eligibility.reason
  }
  return { decision: 'open', reason: lastRejection }
}

function evaluateCandidate(
  candidate: AttachCandidate,
  windows: AttachWindows,
  now: Date,
): { eligible: true } | { eligible: false; reason: AttachRejection } {
  if (candidate.status === 'closed') return { eligible: false, reason: 'candidate_closed' }

  if (candidate.status === 'resolved') {
    // A resolved Case may only be reopened inside the reopen window. Outside it
    // the customer is almost certainly raising a new matter that happens to
    // share a thread.
    const resolvedAt = candidate.resolvedAt
    if (!resolvedAt) return { eligible: false, reason: 'reopen_window_expired' }
    const age = now.getTime() - resolvedAt.getTime()
    if (age > windows.reopenWindowDays * DAY_MS) {
      return { eligible: false, reason: 'reopen_window_expired' }
    }
    return { eligible: true }
  }

  // An open Case absorbs new inbound only while it is still recent. A Case
  // nobody has touched for weeks is not the conversation this message belongs
  // to, even if it is technically still open.
  const reference = candidate.lastInboundAt
  if (!reference) return { eligible: true }
  const age = now.getTime() - reference.getTime()
  if (age > windows.attachWindowHours * HOUR_MS) {
    return { eligible: false, reason: 'attach_window_expired' }
  }
  return { eligible: true }
}

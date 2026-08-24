import type { SlaResolutionState, SlaResponseState } from '../data/entities'
import { addBusinessSeconds, measureBusinessSeconds, type BusinessCalendar } from './business-time'

export type PolicyMatchCandidate = {
  policyId: string
  policyVersionId: string
  calendarVersionId: string
  channelId: string | null
  priority: number
  effectiveFrom: Date
  isActive: boolean
  responseTargetMinutes: number
  resolutionTargetMinutes: number
}

export type ClockState = {
  id: string
  caseId: string
  generation: number
  sourceEventId: string
  policyVersionId: string
  calendarVersionId: string
  startedAt: Date
  responseDueAt: Date
  resolutionDueAt: Date
  responseState: SlaResponseState
  resolutionState: SlaResolutionState
  respondedAt: Date | null
  resolvedAt: Date | null
  resolutionPausedSeconds: number
  waitStartedAt: Date | null
  parentClockId: string | null
  supersededByClockId: string | null
  nextDueAt: Date | null
  internalVersion: number
}

export type ClockSourceEvent =
  | { type: 'response'; sourceEventId: string; occurredAt: Date; evidence: 'human' | 'human_accepted_ai' | 'unknown' }
  | { type: 'resolved'; sourceEventId: string; occurredAt: Date }
  | { type: 'wait_started'; sourceEventId: string; occurredAt: Date }
  | { type: 'wait_ended'; sourceEventId: string; occurredAt: Date; waitStartedAt: Date }

export type ClockTransition = {
  clock: ClockState
  applied: boolean
  event: 'responded' | 'resolved' | 'response_breached' | 'resolution_breached' | 'merged' | 'superseded' | null
}

export function matchPolicy(candidates: readonly PolicyMatchCandidate[], channelId: string, startedAt: Date): PolicyMatchCandidate | null {
  const eligible = candidates.filter((candidate) => candidate.isActive && candidate.effectiveFrom <= startedAt && (candidate.channelId === channelId || candidate.channelId === null))
  eligible.sort((left, right) => {
    const channelOrder = Number(right.channelId === channelId) - Number(left.channelId === channelId)
    return channelOrder || left.priority - right.priority || left.policyId.localeCompare(right.policyId)
  })
  return eligible[0] ?? null
}

export function createClock(input: {
  id: string
  caseId: string
  generation: number
  sourceEventId: string
  startedAt: Date
  policy: PolicyMatchCandidate
  calendar: BusinessCalendar
  responseState?: 'open' | 'unknown'
}): ClockState {
  const responseDueAt = addBusinessSeconds(input.startedAt, input.policy.responseTargetMinutes * 60, input.calendar)
  const resolutionDueAt = addBusinessSeconds(input.startedAt, input.policy.resolutionTargetMinutes * 60, input.calendar)
  return {
    id: input.id,
    caseId: input.caseId,
    generation: input.generation,
    sourceEventId: input.sourceEventId,
    policyVersionId: input.policy.policyVersionId,
    calendarVersionId: input.policy.calendarVersionId,
    startedAt: new Date(input.startedAt),
    responseDueAt,
    resolutionDueAt,
    responseState: input.responseState ?? 'open',
    resolutionState: 'open',
    respondedAt: null,
    resolvedAt: null,
    resolutionPausedSeconds: 0,
    waitStartedAt: null,
    parentClockId: null,
    supersededByClockId: null,
    nextDueAt: earlier(responseDueAt, resolutionDueAt),
    internalVersion: 1,
  }
}

export function applyClockSourceEvent(clock: ClockState, source: ClockSourceEvent, receivedSourceEventIds: ReadonlySet<string>, calendar: BusinessCalendar, resolutionTargetMinutes: number): ClockTransition {
  if (receivedSourceEventIds.has(source.sourceEventId)) return unchanged(clock)
  const next = copyClock(clock)
  if (source.type === 'response') {
    if (source.evidence === 'unknown') {
      if (next.responseState === 'unknown' || next.respondedAt) return consumed(clock)
      next.responseState = 'unknown'
      refreshNextDue(next)
      return changed(next, null)
    }
    if (next.responseState === 'unknown' || next.respondedAt) return consumed(clock)
    next.respondedAt = new Date(source.occurredAt)
    if (next.responseState === 'open') next.responseState = source.occurredAt <= next.responseDueAt ? 'met' : 'breached'
    refreshNextDue(next)
    return changed(next, 'responded')
  }
  if (source.type === 'resolved') {
    if (next.resolutionState !== 'open' && next.resolutionState !== 'breached') return consumed(clock)
    if (!next.resolvedAt) next.resolvedAt = new Date(source.occurredAt)
    if (next.resolutionState === 'open') next.resolutionState = source.occurredAt <= next.resolutionDueAt ? 'met' : 'breached'
    next.waitStartedAt = null
    refreshNextDue(next)
    return changed(next, 'resolved')
  }
  if (source.type === 'wait_started') {
    if (next.resolutionState !== 'open' || next.waitStartedAt) return consumed(clock)
    next.waitStartedAt = new Date(source.occurredAt)
    return changed(next, null)
  }
  if (next.resolutionState !== 'open' || !next.waitStartedAt || next.waitStartedAt.getTime() !== source.waitStartedAt.getTime()) return consumed(clock)
  const endedAt = source.occurredAt < source.waitStartedAt ? source.waitStartedAt : source.occurredAt
  next.resolutionPausedSeconds += measureBusinessSeconds(source.waitStartedAt, endedAt, calendar)
  next.waitStartedAt = null
  next.resolutionDueAt = addBusinessSeconds(next.startedAt, resolutionTargetMinutes * 60 + next.resolutionPausedSeconds, calendar)
  refreshNextDue(next)
  return changed(next, null)
}

export function evaluateDue(clock: ClockState, now: Date): ClockTransition[] {
  const transitions: ClockTransition[] = []
  let next = copyClock(clock)
  if (next.responseState === 'open' && now >= next.responseDueAt) {
    next.responseState = 'breached'
    refreshNextDue(next)
    transitions.push(changed(next, 'response_breached'))
  }
  if (next.resolutionState === 'open' && !next.waitStartedAt && now >= next.resolutionDueAt) {
    next = copyClock(next)
    next.resolutionState = 'breached'
    refreshNextDue(next)
    transitions.push(changed(next, 'resolution_breached'))
  }
  return transitions
}

export function mergeClock(clock: ClockState): ClockTransition {
  if (clock.resolutionState !== 'open') return unchanged(clock)
  const next = copyClock(clock)
  next.resolutionState = 'merged'
  next.waitStartedAt = null
  refreshNextDue(next)
  return changed(next, 'merged')
}

export function splitClock(parent: ClockState, input: { id: string; caseId: string; sourceEventId: string }): ClockState {
  return {
    ...copyClock(parent),
    id: input.id,
    caseId: input.caseId,
    sourceEventId: input.sourceEventId,
    parentClockId: parent.id,
    supersededByClockId: null,
    internalVersion: 1,
  }
}

export function supersedeClock(clock: ClockState, replacementClockId: string): ClockTransition {
  if (clock.resolutionState === 'superseded') return unchanged(clock)
  const next = copyClock(clock)
  next.resolutionState = 'superseded'
  next.supersededByClockId = replacementClockId
  next.waitStartedAt = null
  refreshNextDue(next)
  return changed(next, 'superseded')
}

function refreshNextDue(clock: ClockState): void {
  const due: Date[] = []
  if (clock.responseState === 'open') due.push(clock.responseDueAt)
  if (clock.resolutionState === 'open' && !clock.waitStartedAt) due.push(clock.resolutionDueAt)
  clock.nextDueAt = due.length ? due.reduce(earlier) : null
}

function earlier(left: Date, right: Date): Date {
  return new Date(Math.min(left.getTime(), right.getTime()))
}

function copyClock(clock: ClockState): ClockState {
  return { ...clock, startedAt: new Date(clock.startedAt), responseDueAt: new Date(clock.responseDueAt), resolutionDueAt: new Date(clock.resolutionDueAt), respondedAt: clock.respondedAt ? new Date(clock.respondedAt) : null, resolvedAt: clock.resolvedAt ? new Date(clock.resolvedAt) : null, waitStartedAt: clock.waitStartedAt ? new Date(clock.waitStartedAt) : null, nextDueAt: clock.nextDueAt ? new Date(clock.nextDueAt) : null }
}

function changed(clock: ClockState, event: ClockTransition['event']): ClockTransition {
  clock.internalVersion += 1
  return { clock, applied: true, event }
}

function unchanged(clock: ClockState): ClockTransition {
  return { clock, applied: false, event: null }
}

function consumed(clock: ClockState): ClockTransition {
  return { clock, applied: true, event: null }
}

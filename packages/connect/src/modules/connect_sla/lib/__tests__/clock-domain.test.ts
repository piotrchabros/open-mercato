import { applyClockSourceEvent, createClock, evaluateDue, matchPolicy, mergeClock, splitClock, supersedeClock, type ClockState, type PolicyMatchCandidate } from '../clock-domain'
import type { BusinessCalendar } from '../business-time'

const calendar: BusinessCalendar = { timezone: 'UTC', windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startSecond: 9 * 3600, endSecond: 17 * 3600 })) }
const policy = (overrides: Partial<PolicyMatchCandidate> = {}): PolicyMatchCandidate => ({
  policyId: 'policy-b', policyVersionId: 'version-1', calendarVersionId: 'calendar-1', channelId: null,
  priority: 10, effectiveFrom: new Date('2026-01-01T00:00:00Z'), isActive: true,
  responseTargetMinutes: 60, resolutionTargetMinutes: 240, ...overrides,
})
const clock = (overrides: Partial<ClockState> = {}) => createClock({
  id: 'clock-1', caseId: 'case-1', generation: 2, sourceEventId: 'start-1',
  startedAt: new Date('2026-08-24T09:00:00Z'), policy: policy(), calendar, ...overrides,
})

describe('clock domain', () => {
  test('matches exact channel before wildcard, then priority and policy UUID', () => {
    const candidates = [
      policy({ policyId: 'policy-a', channelId: null, priority: 0 }),
      policy({ policyId: 'policy-c', channelId: 'channel-1', priority: 2 }),
      policy({ policyId: 'policy-b', channelId: 'channel-1', priority: 2 }),
      policy({ policyId: 'policy-z', channelId: 'channel-1', priority: 1, effectiveFrom: new Date('2027-01-01') }),
      policy({ policyId: 'policy-disabled', channelId: 'channel-1', priority: 0, isActive: false }),
    ]
    expect(matchPolicy(candidates, 'channel-1', new Date('2026-08-24'))?.policyId).toBe('policy-b')
    expect(matchPolicy(candidates, 'channel-2', new Date('2026-08-24'))?.policyId).toBe('policy-a')
    expect(matchPolicy([], 'channel-1', new Date())).toBeNull()
  })

  test('creates immutable due snapshots and supports an observable unknown response state', () => {
    const created = clock()
    expect(created.responseDueAt.toISOString()).toBe('2026-08-24T10:00:00.000Z')
    expect(created.resolutionDueAt.toISOString()).toBe('2026-08-24T13:00:00.000Z')
    expect(clock({ responseState: 'unknown' }).responseState).toBe('unknown')
  })

  test('counts only confirmed human evidence and consumes duplicate and unknown facts idempotently', () => {
    const original = clock()
    const unknown = applyClockSourceEvent(original, { type: 'response', sourceEventId: 'delivery-1', occurredAt: new Date('2026-08-24T09:30:00Z'), evidence: 'unknown' }, new Set(), calendar, 240)
    expect(unknown).toMatchObject({ applied: true, event: null })
    expect(unknown.clock.respondedAt).toBeNull()
    expect(unknown.clock.responseState).toBe('unknown')
    expect(unknown.clock.nextDueAt).toEqual(unknown.clock.resolutionDueAt)
    expect(evaluateDue(unknown.clock, new Date('2026-08-24T14:00:00Z')).map((transition) => transition.event)).toEqual(['resolution_breached'])
    expect(applyClockSourceEvent(original, { type: 'response', sourceEventId: 'delivery-1', occurredAt: new Date(), evidence: 'human' }, new Set(['delivery-1']), calendar, 240).applied).toBe(false)
    const response = applyClockSourceEvent(original, { type: 'response', sourceEventId: 'delivery-2', occurredAt: new Date('2026-08-24T09:30:00Z'), evidence: 'human_accepted_ai' }, new Set(), calendar, 240)
    expect(response.clock).toMatchObject({ responseState: 'met', respondedAt: new Date('2026-08-24T09:30:00Z') })
    expect(original.responseState).toBe('open')
  })

  test('keeps response and resolution state independent and breaches remain breached after late facts', () => {
    let current = clock()
    const due = evaluateDue(current, new Date('2026-08-24T14:00:00Z'))
    expect(due.map((transition) => transition.event)).toEqual(['response_breached', 'resolution_breached'])
    current = due[1].clock
    current = applyClockSourceEvent(current, { type: 'response', sourceEventId: 'late-response', occurredAt: new Date('2026-08-24T14:01:00Z'), evidence: 'human' }, new Set(), calendar, 240).clock
    current = applyClockSourceEvent(current, { type: 'resolved', sourceEventId: 'late-resolution', occurredAt: new Date('2026-08-24T14:02:00Z') }, new Set(), calendar, 240).clock
    expect(current).toMatchObject({ responseState: 'breached', resolutionState: 'breached' })
    expect(current.respondedAt).toEqual(new Date('2026-08-24T14:01:00Z'))
    expect(current.resolvedAt).toEqual(new Date('2026-08-24T14:02:00Z'))
  })

  test('pauses only resolution by business seconds and recomputes from the immutable start', () => {
    let current = clock()
    current = applyClockSourceEvent(current, { type: 'wait_started', sourceEventId: 'wait-1', occurredAt: new Date('2026-08-24T12:00:00Z') }, new Set(), calendar, 240).clock
    expect(current.nextDueAt).toEqual(current.responseDueAt)
    current = applyClockSourceEvent(current, { type: 'wait_ended', sourceEventId: 'wait-2', waitStartedAt: new Date('2026-08-24T12:00:00Z'), occurredAt: new Date('2026-08-25T10:00:00Z') }, new Set(), calendar, 240).clock
    expect(current.resolutionPausedSeconds).toBe(6 * 3600)
    expect(current.resolutionDueAt.toISOString()).toBe('2026-08-25T11:00:00.000Z')
    expect(current.responseDueAt.toISOString()).toBe('2026-08-24T10:00:00.000Z')
  })

  test('merge changes only an open resolution while preserving response history', () => {
    const responded = applyClockSourceEvent(clock(), { type: 'response', sourceEventId: 'response', occurredAt: new Date('2026-08-24T09:30:00Z'), evidence: 'human' }, new Set(), calendar, 240).clock
    const merged = mergeClock(responded)
    expect(merged.clock).toMatchObject({ responseState: 'met', resolutionState: 'merged', respondedAt: new Date('2026-08-24T09:30:00Z') })
    expect(mergeClock({ ...responded, resolutionState: 'breached' }).applied).toBe(false)
  })

  test('split copies the same generation and historical snapshot while future pause state diverges', () => {
    const parent = clock()
    const child = splitClock(parent, { id: 'clock-child', caseId: 'case-child', sourceEventId: 'split-1' })
    expect(child).toMatchObject({ generation: parent.generation, parentClockId: parent.id, policyVersionId: parent.policyVersionId, responseDueAt: parent.responseDueAt })
    const pausedChild = applyClockSourceEvent(child, { type: 'wait_started', sourceEventId: 'child-wait', occurredAt: new Date('2026-08-24T10:00:00Z') }, new Set(), calendar, 240).clock
    expect(pausedChild.waitStartedAt).not.toBeNull()
    expect(parent.waitStartedAt).toBeNull()
  })

  test('supersedes without rewriting the prior clock and records replacement lineage', () => {
    const original = clock()
    const result = supersedeClock(original, 'clock-2')
    expect(result.clock).toMatchObject({ resolutionState: 'superseded', supersededByClockId: 'clock-2', nextDueAt: original.responseDueAt })
    expect(original.resolutionState).toBe('open')
    expect(supersedeClock(result.clock, 'clock-3').applied).toBe(false)
  })
})

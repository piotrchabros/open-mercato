import { CONNECT_SLA_DEADLINE_BATCH_SIZE, CONNECT_SLA_QUEUES, createConnectSlaSourceConsumer, createDeadlineSweepService, createGenerationConsumer, createRebuildService, createReparentConsumer, deadlineSweepPayloadSchema, rebuildPayloadSchema, type ClockPersistence, type ClockTransaction } from '../async'
import { createClock, type ClockState, type PolicyMatchCandidate } from '../clock-domain'
import type { BusinessCalendar } from '../business-time'

const calendar: BusinessCalendar = { timezone: 'UTC', windows: [{ weekday: 1, startSecond: 0, endSecond: 86_400 }] }
const policy: PolicyMatchCandidate = { policyId: 'p', policyVersionId: 'pv', calendarVersionId: 'cv', channelId: null, priority: 1, effectiveFrom: new Date(0), isActive: true, responseTargetMinutes: 60, resolutionTargetMinutes: 120 }
const initial = (): ClockState => createClock({ id: 'clock', caseId: 'case', generation: 1, sourceEventId: 'start', startedAt: new Date('2026-08-24T00:00:00Z'), policy, calendar })

function harness(clock = initial()) {
  const receipts = new Set<string>()
  const staged: string[] = []
  let stored = clock
  const transaction: ClockTransaction = {
    hasReceipt: async (_scope, id) => receipts.has(id),
    addReceipt: async (_scope, id) => { receipts.add(id) },
    findClock: async () => stored,
    saveClock: async (_scope, value, expected) => { if (stored.internalVersion !== expected) return false; stored = value; return true },
    stageEvent: async (_scope, event) => { staged.push(event.id) },
  }
  const persistence: ClockPersistence = { transaction: async (work) => work(transaction), processDue: async (_scope, _now, _limit, work) => work(stored, transaction) }
  return { persistence, transaction, receipts, staged, get clock() { return stored } }
}

describe('connect SLA asynchronous services', () => {
  test('keeps receipt, conditional mutation, and staged event in one transaction', async () => {
    const state = harness()
    const service = createConnectSlaSourceConsumer(state.persistence, async () => ({ calendar, resolutionTargetMinutes: 120 }))
    const source = { type: 'response' as const, sourceEventId: 'delivery', occurredAt: new Date('2026-08-24T00:30:00Z'), evidence: 'human' as const }
    await expect(service.apply({ tenantId: 'tenant', organizationId: 'org' }, 'case', 1, source)).resolves.toBe('applied')
    expect(state.receipts).toContain('delivery')
    expect(state.clock.responseState).toBe('met')
    expect(state.staged).toEqual(['connect_sla.clock.responded'])
    await expect(service.apply({ tenantId: 'tenant', organizationId: 'org' }, 'case', 1, source)).resolves.toBe('duplicate')
    expect(state.staged).toHaveLength(1)
  })

  test('deadline sweep bounds claims and conditionally emits transitions once', async () => {
    const state = harness()
    const transactionSpy = jest.spyOn(state.persistence, 'transaction')
    let claimedLimit = 0
    state.persistence.processDue = async (_scope, _now, limit, work) => { claimedLimit = limit; return work(state.clock, state.transaction) }
    const service = createDeadlineSweepService(state.persistence)
    await expect(service.sweep({ tenantId: 'tenant', organizationId: 'org' }, new Date('2026-08-24T03:00:00Z'))).resolves.toBe(2)
    expect(claimedLimit).toBe(CONNECT_SLA_DEADLINE_BATCH_SIZE)
    expect(state.staged).toEqual(['connect_sla.clock.response_breached', 'connect_sla.clock.resolution_breached'])
    expect(transactionSpy).not.toHaveBeenCalled()
    await expect(service.sweep({ tenantId: 'tenant', organizationId: 'org' }, new Date('2026-08-24T03:00:00Z'))).resolves.toBe(0)
  })

  test('rebuild is a healthy no-op when optional Connect reader is missing', async () => {
    const sink = { applyGeneration: jest.fn(), applyWait: jest.fn(), applyDelivery: jest.fn(), saveCursor: jest.fn() }
    const service = createRebuildService(null, sink)
    expect(service.healthy).toBe(false)
    await expect(service.rebuild({ tenantId: 'tenant', organizationId: 'org' }, 'run', 100)).resolves.toBe('dependency_unavailable')
    expect(sink.saveCursor).not.toHaveBeenCalled()
  })

  test('captures one watermark and drains all streams with cursor checkpoints', async () => {
    const watermark = { occurredAt: '2026-08-24T00:00:00.000Z', id: '00000000-0000-0000-0000-000000000001' }
    const page = { items: [], nextCursor: null, highWatermark: watermark }
    const reader = { captureHighWatermark: jest.fn(async () => watermark), listGenerations: jest.fn(async () => page), listWaitIntervals: jest.fn(async () => page), listConfirmedDeliveries: jest.fn(async () => page), canReadCase: jest.fn() }
    const sink = { applyGeneration: jest.fn(), applyWait: jest.fn(), applyDelivery: jest.fn(), saveCursor: jest.fn(async () => undefined) }
    await expect(createRebuildService(reader, sink).rebuild({ tenantId: 'tenant', organizationId: 'org' }, 'run', 50)).resolves.toBe('completed')
    expect(reader.captureHighWatermark).toHaveBeenCalledTimes(1)
    expect(reader.listGenerations).toHaveBeenCalledWith({ tenantId: 'tenant', organizationId: 'org' }, expect.objectContaining({ through: watermark, limit: 50 }))
    expect(sink.saveCursor).toHaveBeenCalledTimes(3)
  })

  test('pins queue names and bounded payloads', () => {
    expect(CONNECT_SLA_QUEUES).toEqual({ deadlineSweep: 'connect_sla.deadline_sweep', rebuild: 'connect_sla.rebuild', eventOutbox: 'connect_sla.event_outbox.publish' })
    expect(() => rebuildPayloadSchema.parse({ tenantId: crypto.randomUUID(), organizationId: crypto.randomUUID(), runId: crypto.randomUUID(), pageSize: 101 })).toThrow()
    expect(deadlineSweepPayloadSchema.parse({ tenantId: crypto.randomUUID(), organizationId: crypto.randomUUID() })).toBeTruthy()
  })

  test('keeps generation and reparent persistence behind narrow services', async () => {
    const createWithReceipt = jest.fn(async () => 'created' as const)
    const generation = createGenerationConsumer({ createWithReceipt }, async () => ({ scope: { tenantId: 'tenant', organizationId: 'org' }, sourceEventId: 'start', clock: initial() }))
    await expect(generation.apply({})).resolves.toBe('created')
    expect(createWithReceipt).toHaveBeenCalledTimes(1)
    const persistence = { split: jest.fn(async () => 'applied' as const), merge: jest.fn(async () => 'applied' as const), undo: jest.fn(async () => 'manual_review' as const) }
    const reparent = createReparentConsumer(persistence)
    await reparent.apply('split', {})
    await reparent.apply('merged', {})
    await expect(reparent.apply('reparenting_undone', {})).resolves.toBe('manual_review')
    expect(persistence.split).toHaveBeenCalledTimes(1)
    expect(persistence.merge).toHaveBeenCalledTimes(1)
  })
})

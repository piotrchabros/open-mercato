import { createLeasedRebuildWorker, createRebuildRunCoordinator, type RebuildRunState, type RebuildRunStore } from '../rebuild-runs'

const scope = { tenantId: 'tenant', organizationId: 'org' }
const watermark = { occurredAt: '2026-08-24T00:00:00.000Z', id: 'watermark' }

function storeHarness() {
  let run: RebuildRunState | null = null
  const store: RebuildRunStore = {
    findByCommand: async (_scope, key) => run?.commandKey === key ? run : null,
    findActive: async (_scope, now) => run && ['pending', 'running'].includes(run.status) && (!run.leaseExpiresAt || run.leaseExpiresAt > now) ? run : null,
    create: async (value) => { if (run) return false; run = value; return true },
    find: async () => run,
    claim: async (_scope, _id, owner, now, expiresAt) => { if (!run || run.status === 'cancelled' || (run.leaseOwner !== owner && run.leaseExpiresAt && run.leaseExpiresAt > now)) return null; run = { ...run, status: 'running', leaseOwner: owner, leaseExpiresAt: expiresAt, internalVersion: run.internalVersion + 1 }; return run },
    checkpoint: async (_scope, _id, owner, version, stream, cursor, count, expiresAt) => { if (!run || run.status !== 'running' || run.leaseOwner !== owner || run.internalVersion !== version) return null; run = { ...run, cursors: { ...run.cursors, [stream]: cursor }, processedCount: run.processedCount + count, leaseExpiresAt: expiresAt, internalVersion: version + 1 }; return run },
    finish: async (_scope, _id, owner, version, status, errors) => { if (!run || run.leaseOwner !== owner || run.internalVersion !== version) return false; run = { ...run, status, errorCount: run.errorCount + errors, leaseOwner: null, leaseExpiresAt: null, internalVersion: version + 1 }; return true },
  }
  return { store, get run() { return run }, set run(value) { run = value } }
}

const reader = { captureHighWatermark: jest.fn(async () => watermark), listGenerations: jest.fn(), listWaitIntervals: jest.fn(), listConfirmedDeliveries: jest.fn(), canReadCase: jest.fn() }

describe('rebuild run lifecycle', () => {
  beforeEach(() => jest.clearAllMocks())

  test('captures watermark on creation, replays the same key, and rejects active overlap', async () => {
    const state = storeHarness()
    const coordinator = createRebuildRunCoordinator(state.store, reader, () => 'run-1')
    const first = await coordinator.request(scope, { commandKey: 'key-1', reason: 'reason', progressJobId: 'progress' })
    expect(first).toMatchObject({ outcome: 'created', run: { watermark, internalVersion: 1 } })
    expect(await coordinator.request(scope, { commandKey: 'key-1', reason: 'changed', progressJobId: null })).toMatchObject({ outcome: 'replay', run: { id: 'run-1' } })
    expect(await coordinator.request(scope, { commandKey: 'key-2', reason: 'reason', progressJobId: null })).toMatchObject({ outcome: 'overlap' })
    expect(reader.captureHighWatermark).toHaveBeenCalledTimes(1)
  })

  test('reclaims an expired lease and resumes each stream from persisted cursors', async () => {
    const state = storeHarness()
    const coordinator = createRebuildRunCoordinator(state.store, reader, () => 'run-1')
    await coordinator.request(scope, { commandKey: 'key', reason: 'reason', progressJobId: null })
    const cursor = { occurredAt: '2026-08-23T00:00:00.000Z', id: 'cursor' }
    state.run = { ...state.run!, status: 'running', leaseOwner: 'dead-worker', leaseExpiresAt: new Date('2026-08-24T00:00:00Z'), cursors: { generation: cursor, wait: null, delivery: null } }
    const empty = { items: [], nextCursor: null, highWatermark: watermark }
    reader.listGenerations.mockResolvedValue(empty); reader.listWaitIntervals.mockResolvedValue(empty); reader.listConfirmedDeliveries.mockResolvedValue(empty)
    const sink = { applyGeneration: jest.fn(), applyWait: jest.fn(), applyDelivery: jest.fn(), saveCursor: jest.fn() }
    await expect(createLeasedRebuildWorker(state.store, reader, sink).run(scope, 'run-1', 'new-worker', 50, new Date('2026-08-24T01:00:00Z'))).resolves.toBe('completed')
    expect(reader.listGenerations).toHaveBeenCalledWith(scope, expect.objectContaining({ after: cursor, through: watermark }))
    expect(state.run).toMatchObject({ status: 'completed', processedCount: 0, leaseOwner: null })
  })

  test('preserves applied facts and cursors when cancellation wins a checkpoint race', async () => {
    const state = storeHarness()
    await createRebuildRunCoordinator(state.store, reader, () => 'run-1').request(scope, { commandKey: 'key', reason: 'reason', progressJobId: null })
    const item = { id: 'fact' }
    reader.listGenerations.mockResolvedValue({ items: [item], nextCursor: { occurredAt: watermark.occurredAt, id: 'next' }, highWatermark: watermark })
    const sink = { applyGeneration: jest.fn(async () => { state.run = { ...state.run!, status: 'cancelled' } }), applyWait: jest.fn(), applyDelivery: jest.fn(), saveCursor: jest.fn() }
    await expect(createLeasedRebuildWorker(state.store, reader, sink).run(scope, 'run-1', 'worker', 50)).resolves.toBe('cancelled')
    expect(sink.applyGeneration).toHaveBeenCalledWith(scope, item)
    expect(state.run?.status).toBe('cancelled')
  })
})

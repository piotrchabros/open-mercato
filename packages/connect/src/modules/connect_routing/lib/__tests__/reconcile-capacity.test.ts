import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CONNECT_ROUTING_FOREGROUND_ASSIGNEE_THRESHOLD,
  CONNECT_ROUTING_FOUNDATION_VERSION,
  CONNECT_ROUTING_UPSERT_BATCH_SIZE,
  createConnectRoutingCapacityService,
} from '../reconcile-capacity'

const SCOPE = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}

type PresenceRow = { userId: string; status: string; currentCaseCount: number }

type Checkpoint = {
  state: string
  foundationVersion: string | null
  generation: number
  lastAttemptAt: Date
  completedAt: Date | null
  lastErrorCode: string | null
}

/**
 * A small in-memory stand-in for the two routing tables.
 *
 * It dispatches on the distinctive fragment of each statement the service
 * issues, which keeps the assertions about observable projection state —
 * created/updated/zeroed rows, preserved status, advancing generation — rather
 * than about SQL strings that any refactor would churn.
 */
function createDatabaseStub(options: { failOn?: (sql: string) => Error | null } = {}) {
  const presences = new Map<string, PresenceRow>()
  let checkpoint: Checkpoint | null = null
  const statements: string[] = []

  const execute = async (sql: string, params: unknown[] = []): Promise<unknown> => {
    statements.push(sql)
    const failure = options.failOn?.(sql)
    if (failure) throw failure

    if (sql.includes('set local lock_timeout') || sql.includes('pg_advisory_xact_lock')) return []

    if (sql.includes('insert into "connect_routing_capacity_checkpoints"') && sql.includes(`'pending'`)) {
      checkpoint = checkpoint
        ? { ...checkpoint, state: 'pending', lastAttemptAt: new Date(), lastErrorCode: null }
        : {
            state: 'pending',
            foundationVersion: null,
            generation: 0,
            lastAttemptAt: new Date(),
            completedAt: null,
            lastErrorCode: null,
          }
      return []
    }

    if (sql.includes('insert into "connect_routing_capacity_checkpoints"') && sql.includes(`'completed'`)) {
      const generation = (checkpoint?.generation ?? 0) + 1
      checkpoint = {
        state: 'completed',
        foundationVersion: String(params[2]),
        generation,
        lastAttemptAt: checkpoint?.lastAttemptAt ?? new Date(),
        completedAt: new Date(),
        lastErrorCode: null,
      }
      return [{ generation: String(generation) }]
    }

    if (sql.includes('update "connect_routing_capacity_checkpoints"')) {
      if (checkpoint) {
        checkpoint = { ...checkpoint, state: String(params[0]), lastErrorCode: String(params[1]) }
      }
      return []
    }

    if (sql.includes('select "state", "foundation_version"')) {
      return checkpoint ? [{ ...checkpoint }] : []
    }

    if (sql.includes('select "user_id" as "userId"')) {
      return [...presences.values()]
        .sort((left, right) => left.userId.localeCompare(right.userId))
        .map((row) => ({ userId: row.userId, currentCaseCount: row.currentCaseCount }))
    }

    if (sql.includes('insert into "connect_agent_presences"')) {
      for (let index = 0; index < params.length; index += 4) {
        const userId = String(params[index + 2])
        const currentCaseCount = Number(params[index + 3])
        const existing = presences.get(userId)
        // Mirrors `on conflict ... do update set current_case_count`: the
        // conflict branch must leave `status` alone.
        presences.set(userId, {
          userId,
          status: existing?.status ?? 'offline',
          currentCaseCount,
        })
      }
      return []
    }

    if (sql.includes('update "connect_agent_presences"')) {
      for (const userId of params.slice(2).map(String)) {
        const existing = presences.get(userId)
        if (existing) presences.set(userId, { ...existing, currentCaseCount: 0 })
      }
      return []
    }

    throw new Error(`[internal] unexpected statement: ${sql}`)
  }

  const em = {
    execute,
    fork: () => em,
    transactional: async <T>(callback: (tem: EntityManager) => Promise<T>) => callback(em as unknown as EntityManager),
  }

  return {
    em: em as unknown as EntityManager,
    presences,
    statements,
    readCheckpoint: () => checkpoint,
    seedPresence: (row: PresenceRow) => presences.set(row.userId, row),
  }
}

function createContainerStub(reader: unknown) {
  return {
    resolve: <T>(name: string): T => {
      if (name !== 'connectCurrentCaseCountReader') throw new Error(`[internal] unknown registration ${name}`)
      if (!reader) throw new Error('[internal] connectCurrentCaseCountReader is not registered')
      return reader as T
    },
    hasRegistration: (name: string) =>
      name === 'connectCurrentCaseCountReader' ? reader !== null : false,
  }
}

function createReaderStub(counts: Array<{ assigneeUserId: string; currentCaseCount: number }>) {
  return { listByAssignee: async () => counts }
}

describe('connect routing capacity reconciliation', () => {
  it('creates a presence row per assignee and advances the checkpoint', async () => {
    const db = createDatabaseStub()
    const service = createConnectRoutingCapacityService({
      em: db.em,
      container: createContainerStub(
        createReaderStub([
          { assigneeUserId: 'agent-a', currentCaseCount: 3 },
          { assigneeUserId: 'agent-b', currentCaseCount: 1 },
        ]),
      ),
    })

    await expect(service.reconcile(SCOPE)).resolves.toEqual({
      outcome: 'reconciled',
      examined: 2,
      created: 2,
      updated: 0,
      zeroed: 0,
      generation: 1,
    })
    expect([...db.presences.values()]).toEqual([
      { userId: 'agent-a', status: 'offline', currentCaseCount: 3 },
      { userId: 'agent-b', status: 'offline', currentCaseCount: 1 },
    ])
    expect(db.readCheckpoint()).toMatchObject({
      state: 'completed',
      foundationVersion: CONNECT_ROUTING_FOUNDATION_VERSION,
      generation: 1,
      lastErrorCode: null,
    })
  })

  it('is idempotent: a second run changes no row but still advances the checkpoint', async () => {
    const db = createDatabaseStub()
    const service = createConnectRoutingCapacityService({
      em: db.em,
      container: createContainerStub(createReaderStub([{ assigneeUserId: 'agent-a', currentCaseCount: 3 }])),
    })

    await service.reconcile(SCOPE)
    await expect(service.reconcile(SCOPE)).resolves.toEqual({
      outcome: 'reconciled',
      examined: 1,
      created: 0,
      updated: 0,
      zeroed: 0,
      generation: 2,
    })
    expect(db.presences.get('agent-a')).toEqual({ userId: 'agent-a', status: 'offline', currentCaseCount: 3 })
  })

  it('writes absolute counts and zeroes agents that no longer hold work', async () => {
    const db = createDatabaseStub()
    db.seedPresence({ userId: 'agent-a', status: 'available', currentCaseCount: 9 })
    db.seedPresence({ userId: 'agent-gone', status: 'busy', currentCaseCount: 4 })
    db.seedPresence({ userId: 'agent-already-zero', status: 'away', currentCaseCount: 0 })
    const service = createConnectRoutingCapacityService({
      em: db.em,
      container: createContainerStub(
        createReaderStub([
          { assigneeUserId: 'agent-a', currentCaseCount: 2 },
          { assigneeUserId: 'agent-new', currentCaseCount: 5 },
        ]),
      ),
    })

    await expect(service.reconcile(SCOPE)).resolves.toMatchObject({
      outcome: 'reconciled',
      created: 1,
      updated: 1,
      zeroed: 1,
    })
    // Absolute recomputation, and every operator/live-state field survives it.
    expect(db.presences.get('agent-a')).toEqual({ userId: 'agent-a', status: 'available', currentCaseCount: 2 })
    expect(db.presences.get('agent-gone')).toEqual({ userId: 'agent-gone', status: 'busy', currentCaseCount: 0 })
    expect(db.presences.get('agent-new')).toEqual({ userId: 'agent-new', status: 'offline', currentCaseCount: 5 })
    // Already zero, so it is not rewritten and must not be counted as zeroed.
    expect(db.presences.get('agent-already-zero')).toEqual({
      userId: 'agent-already-zero',
      status: 'away',
      currentCaseCount: 0,
    })
  })

  it('advances a completed checkpoint for an organization with no assigned Cases', async () => {
    const db = createDatabaseStub()
    const service = createConnectRoutingCapacityService({
      em: db.em,
      container: createContainerStub(createReaderStub([])),
    })

    await expect(service.reconcile(SCOPE)).resolves.toMatchObject({
      outcome: 'reconciled',
      examined: 0,
      generation: 1,
    })
    await expect(service.isCapacityReconciled(SCOPE)).resolves.toBe(true)
  })

  it('degrades explicitly when Connect is absent, without writing zero rows', async () => {
    const db = createDatabaseStub()
    db.seedPresence({ userId: 'agent-a', status: 'offline', currentCaseCount: 4 })
    const service = createConnectRoutingCapacityService({
      em: db.em,
      container: createContainerStub(null),
    })

    await expect(service.reconcile(SCOPE)).resolves.toEqual({
      outcome: 'dependency_unavailable',
      errorCode: 'connect_reader_unavailable',
    })
    // A missing reader is not "this organization has no assigned Cases".
    expect(db.presences.get('agent-a')).toEqual({ userId: 'agent-a', status: 'offline', currentCaseCount: 4 })
    expect(db.readCheckpoint()).toMatchObject({
      state: 'dependency_unavailable',
      lastErrorCode: 'connect_reader_unavailable',
      completedAt: null,
    })
    await expect(service.isCapacityReconciled(SCOPE)).resolves.toBe(false)
  })

  it('preserves the last completed generation when a later attempt fails', async () => {
    let failNext = false
    const db = createDatabaseStub({
      failOn: (sql) => (failNext && sql.includes('pg_advisory_xact_lock') ? lockTimeoutError() : null),
    })
    const service = createConnectRoutingCapacityService({
      em: db.em,
      container: createContainerStub(createReaderStub([{ assigneeUserId: 'agent-a', currentCaseCount: 2 }])),
    })

    await service.reconcile(SCOPE)
    failNext = true
    await expect(service.reconcile(SCOPE)).rejects.toThrow('lock timeout')

    expect(db.readCheckpoint()).toMatchObject({
      state: 'failed',
      lastErrorCode: 'scope_lock_timeout',
      // The evidence of the last good run survives the failure; only `state`
      // and the error code change, so an operator can see both facts.
      generation: 1,
      foundationVersion: CONNECT_ROUTING_FOUNDATION_VERSION,
    })
    await expect(service.isCapacityReconciled(SCOPE)).resolves.toBe(false)
  })

  it('records a retryable failure when the reader itself throws', async () => {
    const db = createDatabaseStub()
    const service = createConnectRoutingCapacityService({
      em: db.em,
      container: createContainerStub({
        listByAssignee: async () => {
          throw new Error('[internal] case_count_out_of_range')
        },
      }),
    })

    await expect(service.reconcile(SCOPE)).rejects.toThrow('case_count_out_of_range')
    expect(db.readCheckpoint()).toMatchObject({ state: 'failed', lastErrorCode: 'connect_reader_failed' })
    expect(db.presences.size).toBe(0)
  })

  it('defers to the worker only above the foreground assignee threshold', async () => {
    const counts = Array.from({ length: CONNECT_ROUTING_FOREGROUND_ASSIGNEE_THRESHOLD + 1 }, (_unused, index) => ({
      assigneeUserId: `agent-${index}`,
      currentCaseCount: 1,
    }))
    const db = createDatabaseStub()
    const service = createConnectRoutingCapacityService({
      em: db.em,
      container: createContainerStub(createReaderStub(counts)),
    })

    const defer = jest.fn(async () => true)
    await expect(service.reconcile({ ...SCOPE, defer })).resolves.toEqual({
      outcome: 'deferred',
      examined: counts.length,
    })
    expect(defer).toHaveBeenCalledWith({ ...SCOPE, examined: counts.length })
    expect(db.presences.size).toBe(0)

    const small = createDatabaseStub()
    const inlineService = createConnectRoutingCapacityService({
      em: small.em,
      container: createContainerStub(createReaderStub(counts.slice(0, CONNECT_ROUTING_FOREGROUND_ASSIGNEE_THRESHOLD))),
    })
    const unusedDefer = jest.fn(async () => true)
    await expect(inlineService.reconcile({ ...SCOPE, defer: unusedDefer })).resolves.toMatchObject({
      outcome: 'reconciled',
    })
    expect(unusedDefer).not.toHaveBeenCalled()
  })

  it('reconciles synchronously in bounded statements when the queue is unavailable', async () => {
    const counts = Array.from({ length: CONNECT_ROUTING_UPSERT_BATCH_SIZE + 25 }, (_unused, index) => ({
      assigneeUserId: `agent-${index}`,
      currentCaseCount: 1,
    }))
    const db = createDatabaseStub()
    const service = createConnectRoutingCapacityService({
      em: db.em,
      container: createContainerStub(createReaderStub(counts)),
    })

    // Abandoning the backfill because a queue is missing would leave exactly the
    // zeroed capacity this module exists to prevent.
    await expect(service.reconcile({ ...SCOPE, defer: async () => false })).resolves.toMatchObject({
      outcome: 'reconciled',
      created: counts.length,
      generation: 1,
    })
    expect(db.presences.size).toBe(counts.length)
    const upserts = db.statements.filter((sql) => sql.includes('insert into "connect_agent_presences"'))
    expect(upserts).toHaveLength(2)
    expect(upserts[0].split('(?, ?, ?, ').length - 1).toBe(CONNECT_ROUTING_UPSERT_BATCH_SIZE)
  })

  it('fails the activation gate closed for every non-completed checkpoint', async () => {
    const db = createDatabaseStub()
    const service = createConnectRoutingCapacityService({
      em: db.em,
      container: createContainerStub(createReaderStub([])),
    })

    // Nothing recorded at all must never read as "reconciled and empty".
    await expect(service.readCheckpoint(SCOPE)).resolves.toBeNull()
    await expect(service.isCapacityReconciled(SCOPE)).resolves.toBe(false)

    await service.reconcile(SCOPE)
    await expect(service.isCapacityReconciled(SCOPE)).resolves.toBe(true)

    const stale = db.readCheckpoint()
    if (stale) stale.foundationVersion = '2020-01-01-v0'
    await expect(service.isCapacityReconciled(SCOPE)).resolves.toBe(false)
  })
})

function lockTimeoutError(): Error {
  const error = new Error('[internal] canceling statement due to lock timeout') as Error & { code?: string }
  error.code = '55P03'
  return error
}

import {
  ConnectContactIdentity,
  ConnectIdentityLinkAudit,
  ConnectManualMatchTask,
  ConnectPendingProjection,
  ConnectPendingRetraction,
  ConnectRetractionSaga,
} from '../../data/entities'
import { unlinkIdentity } from '../unlink-identity'

/**
 * A wrong link puts another customer's conversations on someone's timeline, so
 * "unlink" has to mean "take it back", not "stop showing it here". These tests
 * pin the ordering that makes that true: fence, hide at the source all-or-none,
 * only then clear locally — and on any failure, abort with the fence released.
 */

const ACTOR = {
  userId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  features: ['connect.customer_match.unlink'],
}
const IDENTITY_ID = '44444444-4444-4444-8444-444444444444'
const CUSTOMER_ID = '55555555-5555-4555-8555-555555555555'

type IdentityRow = {
  id: string
  customerKind: 'person' | 'company' | null
  customerId: string | null
  linkState: string
  confidence: number | null
  matchMethod: string | null
  associationEpoch: number
  unlinkPendingSagaId: string | null
  unlinkPendingEpoch: number | null
  updatedAt: Date
}

function createIdentity(overrides: Partial<IdentityRow> = {}): IdentityRow {
  return {
    id: IDENTITY_ID,
    customerKind: 'person',
    customerId: CUSTOMER_ID,
    linkState: 'linked',
    confidence: 100,
    matchMethod: 'manual',
    associationEpoch: 2,
    unlinkPendingSagaId: null,
    unlinkPendingEpoch: null,
    updatedAt: new Date('2026-08-22T10:00:00.000Z'),
    ...overrides,
  }
}

type Options = {
  identity: IdentityRow | null
  projections?: Array<{ projectionKey: string; caseId: string }>
  begin?: () => Promise<{ status: string }>
  commit?: () => Promise<{ status: string }>
  abort?: () => Promise<{ status: string }>
}

function createContainer(options: Options) {
  const created: Array<{ entity: unknown; data: Record<string, unknown> }> = []
  const sagas: Array<Record<string, unknown>> = []
  const calls: string[] = []
  const em = {
    transactional: async <T,>(work: (tem: unknown) => Promise<T>) => work(em),
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === ConnectContactIdentity) return options.identity
      if (entity === ConnectRetractionSaga) return sagas[sagas.length - 1] ?? null
      if (entity === ConnectManualMatchTask) return null
      return null
    }),
    find: jest.fn(async (entity: unknown) =>
      entity === ConnectPendingProjection
        ? (options.projections ?? []).map((row) => ({ ...row, status: 'projected' }))
        : [],
    ),
    create: jest.fn((entity: unknown, data: Record<string, unknown>) => {
      const row = { id: 'created', ...data }
      created.push({ entity, data })
      if (entity === ConnectRetractionSaga) sagas.push(row)
      return row
    }),
    persist: jest.fn(),
    flush: jest.fn(async () => {}),
    execute: jest.fn(async () => []),
    fork: () => em,
  }
  const lifecycle = {
    beginRetractionSaga: jest.fn(async () => {
      calls.push('begin')
      return options.begin ? options.begin() : { status: 'begun' }
    }),
    commitRetractionSaga: jest.fn(async () => {
      calls.push('commit')
      return options.commit ? options.commit() : { status: 'committed' }
    }),
    abortRetractionSaga: jest.fn(async () => {
      calls.push('abort')
      return options.abort ? options.abort() : { status: 'aborted' }
    }),
  }
  const container = {
    resolve: (name: string) => {
      if (name === 'em') return em
      if (name === 'customersInteractionLifecycle') return lifecycle
      throw new Error(`[internal] unexpected resolve: ${name}`)
    },
  }
  return { container, em, created, sagas, lifecycle, calls }
}

const INPUT = { identityId: IDENTITY_ID, reason: 'wrong person', actor: ACTOR }

describe('unlinkIdentity happy path', () => {
  it('clears the association and stages a finalize job per projection', async () => {
    const identity = createIdentity()
    const { container, created } = createContainer({
      identity,
      projections: [
        { projectionKey: 'case:c1:v1', caseId: 'c1' },
        { projectionKey: 'case:c2:v1', caseId: 'c2' },
      ],
    })
    const result = await unlinkIdentity(container as never, INPUT)
    expect(result).toMatchObject({ status: 'unlinked', retractedCount: 2 })
    expect(identity.customerId).toBeNull()
    expect(identity.linkState).toBe('unresolved')
    expect(created.filter((entry) => entry.entity === ConnectPendingRetraction)).toHaveLength(2)
  })

  it('hides at the source BEFORE clearing anything locally', async () => {
    // Reversing this would leave the wrong customer's timeline visible while
    // Connect already believed the link was gone.
    const identity = createIdentity()
    const clearedWhenBeginRan: Array<string | null> = []
    const { container } = createContainer({
      identity,
      projections: [{ projectionKey: 'case:c1:v1', caseId: 'c1' }],
      begin: async () => {
        clearedWhenBeginRan.push(identity.customerId)
        return { status: 'begun' }
      },
    })
    await unlinkIdentity(container as never, INPUT)
    expect(clearedWhenBeginRan).toEqual([CUSTOMER_ID])
    expect(identity.customerId).toBeNull()
  })

  it('sends the precommitted inventory, sorted and complete', async () => {
    const { container, lifecycle } = createContainer({
      identity: createIdentity(),
      projections: [
        { projectionKey: 'case:c2:v1', caseId: 'c2' },
        { projectionKey: 'case:c1:v1', caseId: 'c1' },
      ],
    })
    await unlinkIdentity(container as never, INPUT)
    expect(lifecycle.beginRetractionSaga).toHaveBeenCalledWith(
      expect.objectContaining({ inventory: ['case:c1:v1', 'case:c2:v1'] }),
    )
  })

  it('records a commit decision and reopens a matching task', async () => {
    const { container, created, sagas } = createContainer({
      identity: createIdentity(),
      projections: [{ projectionKey: 'case:c1:v1', caseId: 'c1' }],
    })
    await unlinkIdentity(container as never, INPUT)
    expect(sagas[0]).toMatchObject({ decision: 'commit', phase: 'finalizing' })
    expect(created.some((entry) => entry.entity === ConnectManualMatchTask)).toBe(true)
    expect(created.some((entry) => entry.entity === ConnectIdentityLinkAudit)).toBe(true)
  })

  it('clears the customer from every case projected under this association', async () => {
    const { container, em } = createContainer({
      identity: createIdentity(),
      projections: [{ projectionKey: 'case:c1:v1', caseId: 'c1' }],
    })
    await unlinkIdentity(container as never, INPUT)
    const update = em.execute.mock.calls.find(([sql]) => String(sql).includes('update "connect_cases"'))
    expect(update).toBeDefined()
    expect(String(update![0])).toContain('"customer_kind" = null')
  })
})

describe('unlinkIdentity guards', () => {
  it('returns not_found for an identity outside the caller scope', async () => {
    const { container, lifecycle } = createContainer({ identity: null })
    expect(await unlinkIdentity(container as never, INPUT)).toEqual({ status: 'not_found' })
    expect(lifecycle.beginRetractionSaga).not.toHaveBeenCalled()
  })

  it('refuses to start a second saga while one is undecided', async () => {
    const identity = createIdentity({ unlinkPendingSagaId: 'unlink:i:e2', unlinkPendingEpoch: 2 })
    const { container, lifecycle } = createContainer({ identity })
    expect(await unlinkIdentity(container as never, INPUT)).toEqual({
      status: 'in_progress',
      sagaId: 'unlink:i:e2',
    })
    expect(lifecycle.beginRetractionSaga).not.toHaveBeenCalled()
  })

  it('reports an unlinked identity rather than hiding an empty inventory', async () => {
    const { container, lifecycle } = createContainer({ identity: createIdentity({ customerId: null }) })
    expect(await unlinkIdentity(container as never, INPUT)).toEqual({
      status: 'not_linked',
      identityId: IDENTITY_ID,
    })
    expect(lifecycle.beginRetractionSaga).not.toHaveBeenCalled()
  })

  it('honours the optimistic version before touching the source', async () => {
    const { container, lifecycle } = createContainer({ identity: createIdentity() })
    const result = await unlinkIdentity(container as never, {
      ...INPUT,
      expectedUpdatedAt: '2026-08-21T10:00:00.000Z',
    })
    expect(result.status).toBe('conflict')
    expect(lifecycle.beginRetractionSaga).not.toHaveBeenCalled()
  })
})

describe('unlinkIdentity failure handling', () => {
  it('aborts and releases the fence when the source rejects the inventory', async () => {
    const identity = createIdentity()
    const { container, sagas, calls } = createContainer({
      identity,
      projections: [{ projectionKey: 'case:c1:v1', caseId: 'c1' }],
      begin: async () => ({ status: 'inventory_conflict' }),
    })
    const result = await unlinkIdentity(container as never, INPUT)
    expect(result.status).toBe('inventory_conflict')
    // Never hide a partial set: the association stays intact and usable.
    expect(identity.customerId).toBe(CUSTOMER_ID)
    expect(identity.unlinkPendingSagaId).toBeNull()
    expect(sagas[0]).toMatchObject({ decision: 'abort', phase: 'aborted' })
    // The decision is recorded and the source is told BEFORE the fence drops.
    expect(calls).toEqual(['begin', 'abort'])
  })

  it('leaves the saga for recovery when the source is unreachable', async () => {
    const identity = createIdentity()
    const { container } = createContainer({
      identity,
      projections: [{ projectionKey: 'case:c1:v1', caseId: 'c1' }],
      begin: async () => {
        throw new Error('[internal] peer down')
      },
    })
    const result = await unlinkIdentity(container as never, INPUT)
    expect(result.status).toBe('source_unavailable')
    // Nothing was cleared, because nothing was hidden.
    expect(identity.customerId).toBe(CUSTOMER_ID)
  })

  it('still reports success when only the commit announcement fails', async () => {
    // The local decision is already durable; recovery replays the publish.
    const identity = createIdentity()
    const { container, sagas } = createContainer({
      identity,
      projections: [{ projectionKey: 'case:c1:v1', caseId: 'c1' }],
      commit: async () => {
        throw new Error('[internal] publish failed')
      },
    })
    const result = await unlinkIdentity(container as never, INPUT)
    expect(result.status).toBe('unlinked')
    expect(identity.customerId).toBeNull()
    expect(sagas[0]).toMatchObject({ decision: 'commit' })
  })

  it('accepts an already-begun saga as a resumable retry', async () => {
    const { container } = createContainer({
      identity: createIdentity(),
      projections: [{ projectionKey: 'case:c1:v1', caseId: 'c1' }],
      begin: async () => ({ status: 'already_begun' }),
    })
    expect((await unlinkIdentity(container as never, INPUT)).status).toBe('unlinked')
  })
})

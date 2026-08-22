import { ConnectContactIdentity, ConnectRetractionSaga } from '../../data/entities'
import handle from '../recover-retraction-sagas'

/**
 * Recovery must never guess. Every branch here is driven by what the SOURCE
 * ledger says, because inferring a decision from a missing HTTP response is how
 * a customer's timeline ends up half-cleared — or how interactions get
 * tombstoned on the strength of an intention nobody recorded.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION = '22222222-2222-4222-8222-222222222222'

type SagaRow = {
  id: string
  tenantId: string
  organizationId: string
  identityId: string
  sagaId: string
  epoch: number
  decision: 'undecided' | 'commit' | 'abort'
  phase: string
  completedAt: Date | null
  leaseExpiresAt: Date | null
  lastError: string | null
}

function createSaga(overrides: Partial<SagaRow> = {}): SagaRow {
  return {
    id: 'saga-row-1',
    tenantId: TENANT,
    organizationId: ORGANIZATION,
    identityId: 'identity-1',
    sagaId: 'unlink:identity-1:e2',
    epoch: 2,
    decision: 'undecided',
    phase: 'pending_hide',
    completedAt: null,
    leaseExpiresAt: new Date(),
    lastError: null,
    ...overrides,
  }
}

type IdentityRow = {
  id: string
  unlinkPendingSagaId: string | null
  unlinkPendingEpoch: number | null
}

type Options = {
  saga: SagaRow
  identity?: IdentityRow | null
  source?: Record<string, unknown>
  sourceThrows?: boolean
  lifecycleMissing?: boolean
}

function createCtx(options: Options) {
  const identity =
    options.identity === undefined
      ? { id: 'identity-1', unlinkPendingSagaId: 'unlink:identity-1:e2', unlinkPendingEpoch: 2 }
      : options.identity
  const em = {
    execute: jest.fn(async () => [{ id: options.saga.id }]),
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === ConnectRetractionSaga) return options.saga
      if (entity === ConnectContactIdentity) return identity
      return null
    }),
    flush: jest.fn(async () => {}),
    fork: () => em,
  }
  const listRetractions = jest.fn(async () => {
    if (options.sourceThrows) throw new Error('[internal] peer down')
    return options.source ?? { status: 'found', decision: null, finalized: false }
  })
  const commitRetractionSaga = jest.fn(async () => ({ status: 'committed' }))
  const abortRetractionSaga = jest.fn(async () => ({ status: 'aborted' }))
  const ctx = {
    resolve: (name: string) => {
      if (name === 'em') return em
      if (name === 'customersInteractionLifecycle') {
        if (options.lifecycleMissing) throw new Error('[internal] not registered')
        return { listRetractions, commitRetractionSaga, abortRetractionSaga }
      }
      throw new Error(`[internal] unexpected resolve: ${name}`)
    },
  }
  return { ctx, em, identity, listRetractions, commitRetractionSaga, abortRetractionSaga }
}

const JOB = {} as never

describe('recover-retraction-sagas', () => {
  it('aborts and releases the fence when the source never saw a begin', async () => {
    // Nothing is hidden upstream, so there is no inventory to restore.
    const saga = createSaga()
    const { ctx, identity, abortRetractionSaga } = createCtx({ saga, source: { status: 'missing' } })
    await handle(JOB, ctx as never)
    expect(saga).toMatchObject({ decision: 'abort', phase: 'aborted' })
    expect(identity!.unlinkPendingSagaId).toBeNull()
    expect(abortRetractionSaga).not.toHaveBeenCalled()
  })

  it('adopts an abort the source already recorded', async () => {
    const saga = createSaga()
    const { ctx, identity } = createCtx({ saga, source: { status: 'found', decision: 'abort' } })
    await handle(JOB, ctx as never)
    expect(saga.decision).toBe('abort')
    expect(identity!.unlinkPendingSagaId).toBeNull()
  })

  it('republishes a local commit the source has not recorded', async () => {
    // The common case: the decision was durable locally but the announcement
    // was lost.
    const saga = createSaga({ decision: 'commit', phase: 'finalizing' })
    const { ctx, commitRetractionSaga } = createCtx({ saga, source: { status: 'found', decision: null } })
    await handle(JOB, ctx as never)
    expect(commitRetractionSaga).toHaveBeenCalledTimes(1)
    expect(saga.phase).toBe('finalizing')
  })

  it('does not republish a commit the source already has', async () => {
    const saga = createSaga({ decision: 'commit', phase: 'finalizing' })
    const { ctx, commitRetractionSaga } = createCtx({
      saga,
      source: { status: 'found', decision: 'commit', finalized: true },
    })
    await handle(JOB, ctx as never)
    expect(commitRetractionSaga).not.toHaveBeenCalled()
    expect(saga.phase).toBe('completed')
    expect(saga.completedAt).not.toBeNull()
  })

  it('converges hidden-but-undecided to abort', async () => {
    // The coordinator died between begin and commit. Restoring the timeline is
    // the safe direction; tombstoning would be irreversible.
    const saga = createSaga()
    const { ctx, abortRetractionSaga, identity } = createCtx({
      saga,
      source: { status: 'found', decision: null, inventory: ['case:c1:v1'] },
    })
    await handle(JOB, ctx as never)
    expect(abortRetractionSaga).toHaveBeenCalledTimes(1)
    expect(saga).toMatchObject({ decision: 'abort', phase: 'aborted' })
    expect(identity!.unlinkPendingSagaId).toBeNull()
  })

  it('retries later when the source cannot be reached', async () => {
    const saga = createSaga()
    const { ctx, identity } = createCtx({ saga, sourceThrows: true })
    await handle(JOB, ctx as never)
    expect(saga.decision).toBe('undecided')
    expect(saga.lastError).toBe('source_unreachable')
    // The fence stays, because the saga is still open.
    expect(identity!.unlinkPendingSagaId).toBe('unlink:identity-1:e2')
  })

  it('never clears a fence that belongs to a newer saga', async () => {
    const saga = createSaga()
    const identity = { id: 'identity-1', unlinkPendingSagaId: 'unlink:identity-1:e3', unlinkPendingEpoch: 3 }
    const { ctx } = createCtx({ saga, identity, source: { status: 'missing' } })
    await handle(JOB, ctx as never)
    expect(identity.unlinkPendingSagaId).toBe('unlink:identity-1:e3')
  })

  it('never clears a fence whose epoch does not match', async () => {
    const saga = createSaga()
    const identity = { id: 'identity-1', unlinkPendingSagaId: 'unlink:identity-1:e2', unlinkPendingEpoch: 9 }
    const { ctx } = createCtx({ saga, identity, source: { status: 'missing' } })
    await handle(JOB, ctx as never)
    expect(identity.unlinkPendingEpoch).toBe(9)
  })

  it('claims only unsettled sagas, with a lease', async () => {
    const saga = createSaga()
    const { ctx, em } = createCtx({ saga, source: { status: 'missing' } })
    await handle(JOB, ctx as never)
    const [sql, params] = em.execute.mock.calls[0]!
    expect(String(sql)).toContain('for update skip locked')
    expect(params as unknown[]).toEqual(
      expect.arrayContaining([expect.arrayContaining(['pending_hide', 'committing', 'finalizing'])]),
    )
  })

  it('leaves sagas unsettled when the peer contract is not registered', async () => {
    const saga = createSaga()
    const { ctx } = createCtx({ saga, lifecycleMissing: true })
    await handle(JOB, ctx as never)
    expect(saga.decision).toBe('undecided')
    expect(saga.phase).toBe('pending_hide')
  })
})

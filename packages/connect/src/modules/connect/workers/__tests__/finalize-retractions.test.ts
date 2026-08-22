import { ConnectPendingRetraction, ConnectRetractionSaga } from '../../data/entities'
import handle, { CONNECT_RETRACTION_MAX_ATTEMPTS } from '../finalize-retractions'

/**
 * By the time these jobs run, the customer's timeline is already clear — the
 * begin step hid the whole inventory before Connect cleared its associations.
 * So the risk here is the opposite direction: finalizing a saga that was never
 * committed would tombstone interactions the coordinator may still restore.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION = '22222222-2222-4222-8222-222222222222'

type RetractionRow = {
  id: string
  tenantId: string
  organizationId: string
  sagaId: string
  projectionKey: string
  status: string
  attempts: number
  leaseExpiresAt: Date | null
  finalizedAt: Date | null
  lastError: string | null
}

function createRow(overrides: Partial<RetractionRow> = {}): RetractionRow {
  return {
    id: 'ret-1',
    tenantId: TENANT,
    organizationId: ORGANIZATION,
    sagaId: 'unlink:identity-1:e2',
    projectionKey: 'case:c1:v1',
    status: 'pending',
    attempts: 1,
    leaseExpiresAt: new Date(),
    finalizedAt: null,
    lastError: null,
    ...overrides,
  }
}

type Options = {
  rows: RetractionRow[]
  saga?: Record<string, unknown> | null
  finalizeStatus?: string
  finalizeThrows?: boolean
  lifecycleMissing?: boolean
}

function createCtx(options: Options) {
  const saga =
    options.saga === undefined
      ? {
          tenantId: TENANT,
          organizationId: ORGANIZATION,
          sagaId: 'unlink:identity-1:e2',
          epoch: 2,
          decision: 'commit',
          phase: 'finalizing',
          completedAt: null as Date | null,
        }
      : options.saga
  const em = {
    execute: jest.fn(async () => options.rows.map((row) => ({ id: row.id }))),
    find: jest.fn(async (entity: unknown) => (entity === ConnectPendingRetraction ? options.rows : [])),
    findOne: jest.fn(async (entity: unknown) => (entity === ConnectRetractionSaga ? saga : null)),
    flush: jest.fn(async () => {}),
    fork: () => em,
  }
  const finalizeRetractionSaga = jest.fn(async () => {
    if (options.finalizeThrows) throw new Error('[internal] peer down')
    return { status: options.finalizeStatus ?? 'finalized' }
  })
  const ctx = {
    resolve: (name: string) => {
      if (name === 'em') return em
      if (name === 'customersInteractionLifecycle') {
        if (options.lifecycleMissing) throw new Error('[internal] not registered')
        return { finalizeRetractionSaga }
      }
      throw new Error(`[internal] unexpected resolve: ${name}`)
    },
  }
  return { ctx, em, saga, finalizeRetractionSaga }
}

const JOB = {} as never

describe('finalize-retractions', () => {
  it('finalizes a committed saga and completes it', async () => {
    const rows = [createRow()]
    const { ctx, saga } = createCtx({ rows })
    await handle(JOB, ctx as never)
    expect(rows[0]!.status).toBe('finalized')
    expect(saga).toMatchObject({ phase: 'completed' })
  })

  it('calls the source once per saga, not once per row', async () => {
    const rows = [createRow({ id: 'ret-1' }), createRow({ id: 'ret-2', projectionKey: 'case:c2:v1' })]
    const { ctx, finalizeRetractionSaga } = createCtx({ rows })
    await handle(JOB, ctx as never)
    expect(finalizeRetractionSaga).toHaveBeenCalledTimes(1)
    expect(rows.every((row) => row.status === 'finalized')).toBe(true)
  })

  it('refuses to finalize an undecided saga', async () => {
    const rows = [createRow()]
    const { ctx, finalizeRetractionSaga } = createCtx({
      rows,
      saga: { tenantId: TENANT, organizationId: ORGANIZATION, sagaId: 'unlink:identity-1:e2', epoch: 2, decision: 'undecided', phase: 'pending_hide' },
    })
    await handle(JOB, ctx as never)
    expect(finalizeRetractionSaga).not.toHaveBeenCalled()
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.leaseExpiresAt).toBeNull()
  })

  it('refuses to finalize an aborted saga', async () => {
    // Its interactions may still be restored; tombstoning them is irreversible.
    const rows = [createRow()]
    const { ctx, finalizeRetractionSaga } = createCtx({
      rows,
      saga: { tenantId: TENANT, organizationId: ORGANIZATION, sagaId: 'unlink:identity-1:e2', epoch: 2, decision: 'abort', phase: 'aborted' },
    })
    await handle(JOB, ctx as never)
    expect(finalizeRetractionSaga).not.toHaveBeenCalled()
    expect(rows[0]!.status).toBe('pending')
  })

  it('leaves rows pending when the saga cannot be found', async () => {
    const rows = [createRow()]
    const { ctx, finalizeRetractionSaga } = createCtx({ rows, saga: null })
    await handle(JOB, ctx as never)
    expect(finalizeRetractionSaga).not.toHaveBeenCalled()
    expect(rows[0]!.status).toBe('pending')
  })

  it('treats an already-finalized saga as settled', async () => {
    const rows = [createRow()]
    const { ctx } = createCtx({ rows, finalizeStatus: 'already_finalized' })
    await handle(JOB, ctx as never)
    expect(rows[0]!.status).toBe('finalized')
  })

  it('retries a transient failure', async () => {
    const rows = [createRow({ attempts: 2 })]
    const { ctx } = createCtx({ rows, finalizeThrows: true })
    await handle(JOB, ctx as never)
    expect(rows[0]!.status).toBe('pending')
    expect(rows[0]!.lastError).toBe('error')
  })

  it('marks exhausted rows failed so an operator is alerted', async () => {
    const rows = [createRow({ attempts: CONNECT_RETRACTION_MAX_ATTEMPTS })]
    const { ctx } = createCtx({ rows, finalizeThrows: true })
    await handle(JOB, ctx as never)
    expect(rows[0]!.status).toBe('failed')
    expect(rows[0]!.lastError).toBe('attempts_exhausted')
  })

  it('does nothing when there is no claimable work', async () => {
    const { ctx, finalizeRetractionSaga } = createCtx({ rows: [] })
    await handle(JOB, ctx as never)
    expect(finalizeRetractionSaga).not.toHaveBeenCalled()
  })

  it('leaves retractions pending and hidden when the peer is not registered', async () => {
    const rows = [createRow()]
    const { ctx } = createCtx({ rows, lifecycleMissing: true })
    await handle(JOB, ctx as never)
    expect(rows[0]!.status).toBe('pending')
  })
})

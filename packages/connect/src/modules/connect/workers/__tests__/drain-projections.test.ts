import { ConnectCase, ConnectContactIdentity, ConnectPendingProjection } from '../../data/entities'
import handle, { CONNECT_PROJECTION_MAX_ATTEMPTS } from '../drain-projections'

/**
 * The drain is the only path by which a Connect Case reaches a customer's
 * timeline. Its critical rule is the fence re-check under the identity lock:
 * a projection admitted while an unlink is undecided would fall outside the
 * inventory that saga already committed to and survive the retraction.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION = '22222222-2222-4222-8222-222222222222'

type ProjectionRow = {
  id: string
  tenantId: string
  organizationId: string
  caseId: string
  identityId: string | null
  customerKind: 'person' | 'company' | null
  customerId: string | null
  projectionKey: string
  associationEpoch: number
  status: string
  attempts: number
  leaseExpiresAt: Date | null
  projectedAt: Date | null
  lastError: string | null
}

function createProjection(overrides: Partial<ProjectionRow> = {}): ProjectionRow {
  return {
    id: 'proj-1',
    tenantId: TENANT,
    organizationId: ORGANIZATION,
    caseId: 'case-1',
    identityId: 'identity-1',
    customerKind: 'person',
    customerId: 'customer-1',
    projectionKey: 'case:case-1:v1',
    associationEpoch: 2,
    status: 'pending',
    attempts: 1,
    leaseExpiresAt: new Date(),
    projectedAt: null,
    lastError: null,
    ...overrides,
  }
}

type Options = {
  projection: ProjectionRow
  identity?: Record<string, unknown> | null
  target?: Record<string, unknown> | null
  createStatus?: string
  createThrows?: boolean
  lifecycleMissing?: boolean
}

function createCtx(options: Options) {
  const em = {
    execute: jest.fn(async () => [{ id: options.projection.id }]),
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === ConnectPendingProjection) return options.projection
      if (entity === ConnectContactIdentity) {
        return options.identity === undefined
          ? { id: 'identity-1', unlinkPendingSagaId: null, associationEpoch: 2 }
          : options.identity
      }
      if (entity === ConnectCase) {
        return options.target === undefined ? { id: 'case-1', displayLabel: 'a…b@example.com' } : options.target
      }
      return null
    }),
    flush: jest.fn(async () => {}),
    fork: () => em,
  }
  const createInteraction = jest.fn(async () => {
    if (options.createThrows) throw new Error('[internal] peer down')
    return { status: options.createStatus ?? 'created' }
  })
  const ctx = {
    resolve: (name: string) => {
      if (name === 'em') return em
      if (name === 'customersInteractionLifecycle') {
        if (options.lifecycleMissing) throw new Error('[internal] not registered')
        return { createInteraction }
      }
      throw new Error(`[internal] unexpected resolve: ${name}`)
    },
  }
  return { ctx, em, createInteraction }
}

const JOB = {} as never

describe('drain-projections', () => {
  it('marks a created projection as projected', async () => {
    const projection = createProjection()
    const { ctx, createInteraction } = createCtx({ projection })
    await handle(JOB, ctx as never)
    expect(projection.status).toBe('projected')
    expect(projection.leaseExpiresAt).toBeNull()
    expect(createInteraction).toHaveBeenCalledTimes(1)
  })

  it('sends the deterministic source key so a retry is recognised upstream', async () => {
    const projection = createProjection()
    const { ctx, createInteraction } = createCtx({ projection })
    await handle(JOB, ctx as never)
    expect(createInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'connect', sourceKey: 'case:case-1:v1' }),
    )
  })

  it('treats an upstream duplicate as success', async () => {
    // A lost acknowledgement must not leave the row pending forever.
    const projection = createProjection()
    const { ctx } = createCtx({ projection, createStatus: 'duplicate' })
    await handle(JOB, ctx as never)
    expect(projection.status).toBe('projected')
  })

  it('waits instead of projecting while an unlink is undecided', async () => {
    const projection = createProjection()
    const { ctx, createInteraction } = createCtx({
      projection,
      identity: { id: 'identity-1', unlinkPendingSagaId: 'unlink:identity-1:e2', associationEpoch: 2 },
    })
    await handle(JOB, ctx as never)
    expect(createInteraction).not.toHaveBeenCalled()
    expect(projection.status).toBe('pending')
    // The lease is released so the row is retried after the saga settles.
    expect(projection.leaseExpiresAt).toBeNull()
  })

  it('supersedes a projection staged under a previous association', async () => {
    const projection = createProjection({ associationEpoch: 1 })
    const { ctx, createInteraction } = createCtx({ projection })
    await handle(JOB, ctx as never)
    expect(projection.status).toBe('superseded')
    expect(createInteraction).not.toHaveBeenCalled()
  })

  it('supersedes a projection whose case is gone', async () => {
    const projection = createProjection()
    const { ctx, createInteraction } = createCtx({ projection, target: null })
    await handle(JOB, ctx as never)
    expect(projection.status).toBe('superseded')
    expect(createInteraction).not.toHaveBeenCalled()
  })

  it('fails permanently when the customer no longer exists', async () => {
    // Retrying cannot make a deleted customer reappear.
    const projection = createProjection()
    const { ctx } = createCtx({ projection, createStatus: 'customer_missing' })
    await handle(JOB, ctx as never)
    expect(projection.status).toBe('failed')
    expect(projection.lastError).toBe('customer_missing')
  })

  it('keeps a transient failure pending for another attempt', async () => {
    const projection = createProjection({ attempts: 2 })
    const { ctx } = createCtx({ projection, createThrows: true })
    await handle(JOB, ctx as never)
    expect(projection.status).toBe('pending')
    expect(projection.lastError).toBe('error')
  })

  it('gives up once attempts are exhausted', async () => {
    const projection = createProjection({ attempts: CONNECT_PROJECTION_MAX_ATTEMPTS })
    const { ctx } = createCtx({ projection, createThrows: true })
    await handle(JOB, ctx as never)
    expect(projection.status).toBe('failed')
    expect(projection.lastError).toBe('attempts_exhausted')
  })

  it('leaves everything pending when the peer contract is not registered', async () => {
    const projection = createProjection()
    const { ctx } = createCtx({ projection, lifecycleMissing: true })
    await handle(JOB, ctx as never)
    expect(projection.status).toBe('pending')
  })

  it('claims a bounded batch with a lease so a crash cannot strand rows', async () => {
    const projection = createProjection()
    const { ctx, em } = createCtx({ projection })
    await handle(JOB, ctx as never)
    const [sql] = em.execute.mock.calls[0]!
    expect(String(sql)).toContain('for update skip locked')
    expect(String(sql)).toContain('lease_expires_at')
  })
})

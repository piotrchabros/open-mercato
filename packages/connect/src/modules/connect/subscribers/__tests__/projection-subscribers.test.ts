import { ConnectCase, ConnectContactIdentity, ConnectManualMatchTask, ConnectPendingProjection } from '../../data/entities'
import unresolvedHandler, { metadata as unresolvedMeta } from '../contact-identity-unresolved'
import resolvedHandler, { metadata as resolvedMeta } from '../case-resolved-projection'

/**
 * Both subscribers are persistent, so the bus may redeliver, reorder or deliver
 * late. Each one therefore re-reads current state instead of trusting what the
 * event described, and defers to a database constraint for the actual
 * idempotency.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION = '22222222-2222-4222-8222-222222222222'

type Stores = {
  identity?: Record<string, unknown> | null
  task?: Record<string, unknown> | null
  target?: Record<string, unknown> | null
  projection?: Record<string, unknown> | null
  flushThrows?: boolean
}

function createCtx(stores: Stores) {
  const created: Array<{ entity: unknown; data: Record<string, unknown> }> = []
  const em = {
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === ConnectContactIdentity) return stores.identity ?? null
      if (entity === ConnectManualMatchTask) return stores.task ?? null
      if (entity === ConnectCase) return stores.target ?? null
      if (entity === ConnectPendingProjection) return stores.projection ?? null
      return null
    }),
    create: jest.fn((entity: unknown, data: Record<string, unknown>) => {
      created.push({ entity, data })
      return { id: 'created', ...data }
    }),
    persist: jest.fn(),
    flush: jest.fn(async () => {
      if (stores.flushThrows) throw Object.assign(new Error('duplicate key'), { code: '23505' })
    }),
    fork: () => em,
  }
  return { ctx: { resolve: () => em }, em, created }
}

describe('contact-identity-unresolved subscriber', () => {
  it('is persistent, so an outage cannot silently drop matching work', () => {
    expect(unresolvedMeta).toMatchObject({ event: 'connect.contact_identity.unresolved', persistent: true })
  })

  it('opens one task for an unresolved identity', async () => {
    const { ctx, created } = createCtx({ identity: { id: 'identity-1', linkState: 'unresolved' } })
    await unresolvedHandler({ identityId: 'identity-1', tenantId: TENANT, organizationId: ORGANIZATION }, ctx as never)
    expect(created).toHaveLength(1)
    expect(created[0]!.data).toMatchObject({ identityId: 'identity-1', status: 'open' })
  })

  it('ignores an event that arrived after the identity was linked', async () => {
    // Reopening a task here would send a human to look at finished work.
    const { ctx, created } = createCtx({ identity: { id: 'identity-1', linkState: 'linked' } })
    await unresolvedHandler({ identityId: 'identity-1', tenantId: TENANT, organizationId: ORGANIZATION }, ctx as never)
    expect(created).toHaveLength(0)
  })

  it('does not open a second task when one is already open', async () => {
    const { ctx, created } = createCtx({
      identity: { id: 'identity-1', linkState: 'unresolved' },
      task: { id: 'task-1', status: 'open' },
    })
    await unresolvedHandler({ identityId: 'identity-1', tenantId: TENANT, organizationId: ORGANIZATION }, ctx as never)
    expect(created).toHaveLength(0)
  })

  it('swallows the unique violation when a concurrent delivery won', async () => {
    const { ctx } = createCtx({ identity: { id: 'identity-1', linkState: 'unresolved' }, flushThrows: true })
    await expect(
      unresolvedHandler({ identityId: 'identity-1', tenantId: TENANT, organizationId: ORGANIZATION }, ctx as never),
    ).resolves.toBeUndefined()
  })

  it('ignores an identity outside the event scope', async () => {
    const { ctx, created } = createCtx({ identity: null })
    await unresolvedHandler({ identityId: 'identity-1', tenantId: TENANT, organizationId: ORGANIZATION }, ctx as never)
    expect(created).toHaveLength(0)
  })

  it('ignores a malformed payload rather than throwing at the bus', async () => {
    const { ctx, em } = createCtx({})
    await unresolvedHandler({ identityId: 'identity-1' }, ctx as never)
    expect(em.findOne).not.toHaveBeenCalled()
  })
})

describe('case-resolved-projection subscriber', () => {
  it('is persistent, so a resolve cannot lose its projection intent', () => {
    expect(resolvedMeta).toMatchObject({ event: 'connect.case.resolved', persistent: true })
  })

  it('stages a projection with a deterministic key', async () => {
    const { ctx, created } = createCtx({
      target: { id: 'case-1', customerKind: 'person', customerId: 'customer-1' },
      identity: { id: 'identity-1', associationEpoch: 2 },
    })
    await resolvedHandler({ caseId: 'case-1', tenantId: TENANT, organizationId: ORGANIZATION }, ctx as never)
    expect(created[0]!.data).toMatchObject({
      caseId: 'case-1',
      projectionKey: 'case:case-1:v3',
      associationEpoch: 2,
      status: 'pending',
    })
  })

  it('stages unresolved work too, so it drains after a later link', async () => {
    // Skipping it here would mean a Case resolved before its identity was
    // matched never reaches the timeline at all.
    const { ctx, created } = createCtx({
      target: { id: 'case-1', customerKind: null, customerId: null },
      identity: null,
    })
    await resolvedHandler({ caseId: 'case-1', tenantId: TENANT, organizationId: ORGANIZATION }, ctx as never)
    expect(created[0]!.data).toMatchObject({ customerId: null, status: 'pending' })
  })

  it('does not stage a second row for a redelivered event', async () => {
    const { ctx, created } = createCtx({
      target: { id: 'case-1', customerKind: 'person', customerId: 'customer-1' },
      identity: { id: 'identity-1', associationEpoch: 2 },
      projection: { id: 'proj-1' },
    })
    await resolvedHandler({ caseId: 'case-1', tenantId: TENANT, organizationId: ORGANIZATION }, ctx as never)
    expect(created).toHaveLength(0)
  })

  it('ignores a case outside the event scope', async () => {
    const { ctx, created } = createCtx({ target: null })
    await resolvedHandler({ caseId: 'case-1', tenantId: TENANT, organizationId: ORGANIZATION }, ctx as never)
    expect(created).toHaveLength(0)
  })

  it('swallows the deterministic-key unique violation', async () => {
    const { ctx } = createCtx({
      target: { id: 'case-1', customerKind: 'person', customerId: 'customer-1' },
      identity: { id: 'identity-1', associationEpoch: 1 },
      flushThrows: true,
    })
    await expect(
      resolvedHandler({ caseId: 'case-1', tenantId: TENANT, organizationId: ORGANIZATION }, ctx as never),
    ).resolves.toBeUndefined()
  })
})

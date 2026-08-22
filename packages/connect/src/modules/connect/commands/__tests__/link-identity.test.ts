import { ConnectCase, ConnectContactIdentity, ConnectIdentityLinkAudit, ConnectManualMatchTask } from '../../data/entities'
import { linkIdentity } from '../link-identity'

/**
 * The security property under test is the ORDER: the customer reference is
 * validated through the source-owned contract before any Connect row is
 * written. Six different ways of being wrong — stale, forged, deleted,
 * wrong-kind, sibling-organization, foreign-tenant — must all produce the same
 * answer and leave nothing behind.
 */

const ACTOR = {
  userId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  features: ['connect.customer_match.link'],
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
    customerKind: null,
    customerId: null,
    linkState: 'unresolved',
    confidence: null,
    matchMethod: null,
    associationEpoch: 1,
    unlinkPendingSagaId: null,
    unlinkPendingEpoch: null,
    updatedAt: new Date('2026-08-22T10:00:00.000Z'),
    ...overrides,
  }
}

function createContainer(identity: IdentityRow | null, referenceStatus: string) {
  const created: Array<{ entity: unknown; data: Record<string, unknown> }> = []
  const em = {
    transactional: async <T,>(work: (tem: unknown) => Promise<T>) => work(em),
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === ConnectContactIdentity) return identity
      if (entity === ConnectManualMatchTask) return null
      return null
    }),
    find: jest.fn(async () => []),
    create: jest.fn((entity: unknown, data: Record<string, unknown>) => {
      created.push({ entity, data })
      return { id: 'created', ...data }
    }),
    persist: jest.fn(),
    flush: jest.fn(async () => {}),
    execute: jest.fn(async () => []),
    nativeUpdate: jest.fn(async () => 0),
    fork: () => em,
  }
  const resolveCustomerReference = jest.fn(async () => ({ status: referenceStatus }))
  const container = {
    resolve: (name: string) => {
      if (name === 'em') return em
      if (name === 'customersInteractionLifecycle') return { resolveCustomerReference }
      throw new Error(`[internal] unexpected resolve: ${name}`)
    },
  }
  return { container, em, created, resolveCustomerReference }
}

describe('linkIdentity', () => {
  it('links an unresolved identity and bumps the association epoch', async () => {
    const identity = createIdentity()
    const { container, created } = createContainer(identity, 'resolved')
    const result = await linkIdentity(container as never, {
      identityId: IDENTITY_ID,
      customerKind: 'person',
      customerId: CUSTOMER_ID,
      actor: ACTOR,
    })
    expect(result.status).toBe('linked')
    expect(identity.customerId).toBe(CUSTOMER_ID)
    expect(identity.linkState).toBe('linked')
    // A NEW epoch: projections written under the previous link belong to a
    // retraction group this one's unlink must not reach.
    expect(identity.associationEpoch).toBe(2)
    expect(created.some((entry) => entry.entity === ConnectIdentityLinkAudit)).toBe(true)
  })

  it('refuses an unresolvable customer without writing anything', async () => {
    const identity = createIdentity()
    const { container, created } = createContainer(identity, 'not_found')
    const result = await linkIdentity(container as never, {
      identityId: IDENTITY_ID,
      customerKind: 'person',
      customerId: CUSTOMER_ID,
      actor: ACTOR,
    })
    expect(result.status).toBe('customer_missing')
    expect(created).toHaveLength(0)
    expect(identity.customerId).toBeNull()
  })

  it('validates the customer before it even loads the identity', async () => {
    const { container, em, resolveCustomerReference } = createContainer(createIdentity(), 'not_found')
    await linkIdentity(container as never, {
      identityId: IDENTITY_ID,
      customerKind: 'person',
      customerId: CUSTOMER_ID,
      actor: ACTOR,
    })
    expect(resolveCustomerReference).toHaveBeenCalledTimes(1)
    // Nothing in Connect was even read, let alone written.
    expect(em.findOne).not.toHaveBeenCalled()
  })

  it('passes the caller scope to the source so it cannot resolve across tenants', async () => {
    const { container, resolveCustomerReference } = createContainer(createIdentity(), 'resolved')
    await linkIdentity(container as never, {
      identityId: IDENTITY_ID,
      customerKind: 'company',
      customerId: CUSTOMER_ID,
      actor: ACTOR,
    })
    expect(resolveCustomerReference).toHaveBeenCalledWith({
      kind: 'company',
      id: CUSTOMER_ID,
      scope: { tenantId: ACTOR.tenantId, organizationId: ACTOR.organizationId },
    })
  })

  it('refuses to link while an unlink saga is in flight', async () => {
    // A link admitted mid-unlink would create an association outside the
    // inventory the saga already committed to, and would survive the retraction.
    const identity = createIdentity({ unlinkPendingSagaId: 'unlink:i:e1', unlinkPendingEpoch: 1 })
    const { container, created } = createContainer(identity, 'resolved')
    const result = await linkIdentity(container as never, {
      identityId: IDENTITY_ID,
      customerKind: 'person',
      customerId: CUSTOMER_ID,
      actor: ACTOR,
    })
    expect(result).toEqual({ status: 'unlink_in_progress', sagaId: 'unlink:i:e1' })
    expect(created).toHaveLength(0)
  })

  it('reports a stale optimistic version as a conflict', async () => {
    const identity = createIdentity()
    const { container, created } = createContainer(identity, 'resolved')
    const result = await linkIdentity(container as never, {
      identityId: IDENTITY_ID,
      customerKind: 'person',
      customerId: CUSTOMER_ID,
      expectedUpdatedAt: '2026-08-21T10:00:00.000Z',
      actor: ACTOR,
    })
    expect(result.status).toBe('conflict')
    expect(created).toHaveLength(0)
  })

  it('is a no-op when the identity already points at the same customer', async () => {
    // Re-confirming an existing link must not append a second audit row or
    // advance the epoch, which would orphan the projections under the old one.
    const identity = createIdentity({ customerKind: 'person', customerId: CUSTOMER_ID, linkState: 'linked' })
    const { container, created } = createContainer(identity, 'resolved')
    const result = await linkIdentity(container as never, {
      identityId: IDENTITY_ID,
      customerKind: 'person',
      customerId: CUSTOMER_ID,
      actor: ACTOR,
    })
    expect(result.status).toBe('noop')
    expect(created).toHaveLength(0)
    expect(identity.associationEpoch).toBe(1)
  })

  it('records a relink with the previous customer preserved in the audit', async () => {
    const identity = createIdentity({ customerKind: 'person', customerId: 'old-customer', linkState: 'linked' })
    const { container, created } = createContainer(identity, 'resolved')
    await linkIdentity(container as never, {
      identityId: IDENTITY_ID,
      customerKind: 'person',
      customerId: CUSTOMER_ID,
      actor: ACTOR,
    })
    const audit = created.find((entry) => entry.entity === ConnectIdentityLinkAudit)
    expect(audit?.data).toMatchObject({
      action: 'relink',
      fromCustomerId: 'old-customer',
      toCustomerId: CUSTOMER_ID,
    })
  })

  it('returns not_found for an identity outside the caller scope', async () => {
    const { container } = createContainer(null, 'resolved')
    const result = await linkIdentity(container as never, {
      identityId: IDENTITY_ID,
      customerKind: 'person',
      customerId: CUSTOMER_ID,
      actor: ACTOR,
    })
    expect(result).toEqual({ status: 'not_found' })
  })
})

describe('linkIdentity case propagation', () => {
  it('adopts the new customer on the cases already attached to this identity', async () => {
    // Without this the agent's Case view and the customer timeline disagree
    // until the next inbound, and the link looks like it did nothing.
    const identity = createIdentity()
    const { container, em } = createContainer(identity, 'resolved')
    await linkIdentity(container as never, {
      identityId: IDENTITY_ID,
      customerKind: 'person',
      customerId: CUSTOMER_ID,
      actor: ACTOR,
    })
    const update = em.execute.mock.calls.find(([sql]) => String(sql).includes('update "connect_cases"'))
    expect(update).toBeDefined()
    expect(update![1]).toEqual(expect.arrayContaining([CUSTOMER_ID, ACTOR.tenantId, ACTOR.organizationId]))
    // Scoped to the caller's organization, so a link can never touch a sibling
    // organization's cases.
    expect(String(update![0])).toContain('"organization_id" = ?')
  })

  it('closes the open manual-match task once the identity is linked', async () => {
    const identity = createIdentity()
    const task = { status: 'open', resolution: null as string | null, resolvedAt: null as Date | null }
    const { container, em } = createContainer(identity, 'resolved')
    em.findOne.mockImplementation(async (entity: unknown) => {
      if (entity === ConnectContactIdentity) return identity
      if (entity === ConnectManualMatchTask) return task
      return null
    })
    await linkIdentity(container as never, {
      identityId: IDENTITY_ID,
      customerKind: 'person',
      customerId: CUSTOMER_ID,
      actor: ACTOR,
    })
    expect(task).toMatchObject({ status: 'resolved', resolution: 'linked' })
  })
})

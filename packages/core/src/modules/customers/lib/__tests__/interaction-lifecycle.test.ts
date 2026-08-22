import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CustomerEntity,
  CustomerInteraction,
  CustomerInteractionRetractionSaga,
} from '../../data/entities'
import {
  CUSTOMERS_INTERACTIONS_RETRACT_FEATURE,
  abortRetractionSaga,
  beginRetractionSaga,
  commitRetractionSaga,
  createInteraction,
  finalizeRetractionSaga,
  listRetractions,
} from '../interaction-lifecycle'

/**
 * Retraction exists because a mistaken identity link puts someone else's
 * conversation on a customer's timeline. Getting it wrong in either direction
 * is bad: leaving part of it visible, or hiding history that was correct. These
 * tests pin the all-or-none inventory rule, the monotonic decision, and the
 * fact that an abort restores exactly what the saga hid and nothing else.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const PERSON = '44444444-4444-4444-8444-444444444444'
const NAMESPACE = 'connect'

const actor = {
  serviceId: 'connect.projection',
  userId: '55555555-5555-4555-8555-555555555555',
  features: [CUSTOMERS_INTERACTIONS_RETRACT_FEATURE],
}

const scope = { tenantId: TENANT, organizationId: ORG }
const sagaScope = { ...scope, namespace: NAMESPACE, sagaId: 'saga-1', epoch: 1 }

type Row = Record<string, unknown>

type Fixture = {
  customer?: Row | null
  interactions: Row[]
  sagas: Row[]
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === null) return row[key] == null
    return row[key] === value
  })
}

function createEm(fixture: Fixture): EntityManager {
  const em = {
    findOne: jest.fn(async (entity: unknown, where: Row) => {
      if (entity === CustomerEntity) {
        const customer = fixture.customer
        return customer && matches(customer, where) ? customer : null
      }
      if (entity === CustomerInteraction) {
        return fixture.interactions.find((row) => matches(row, where)) ?? null
      }
      if (entity === CustomerInteractionRetractionSaga) {
        return fixture.sagas.find((row) => matches(row, where)) ?? null
      }
      return null
    }),
    find: jest.fn(async (entity: unknown, where: Row) => {
      if (entity === CustomerInteraction) return fixture.interactions.filter((row) => matches(row, where))
      if (entity === CustomerInteractionRetractionSaga) return fixture.sagas.filter((row) => matches(row, where))
      return []
    }),
    count: jest.fn(async (entity: unknown, where: Row) =>
      entity === CustomerInteraction ? fixture.interactions.filter((row) => matches(row, where)).length : 0,
    ),
    create: jest.fn((entity: unknown, data: Row) => {
      const row = { id: `row-${fixture.interactions.length + fixture.sagas.length + 1}`, ...data }
      if (entity === CustomerInteraction) fixture.interactions.push(row)
      if (entity === CustomerInteractionRetractionSaga) fixture.sagas.push(row)
      return row
    }),
    persist: jest.fn(),
    flush: jest.fn(async () => undefined),
    getReference: jest.fn((_entity: unknown, id: string) => ({ id })),
    transactional: jest.fn(async (callback: (tem: unknown) => Promise<unknown>) => callback(em)),
  } as unknown as EntityManager
  return em
}

function customer(): Row {
  return { id: PERSON, kind: 'person', tenantId: TENANT, organizationId: ORG, deletedAt: null }
}

function member(sourceKey: string, overrides: Row = {}): Row {
  return {
    id: `interaction-${sourceKey}`,
    tenantId: TENANT,
    organizationId: ORG,
    interactionType: 'email',
    title: 'Order 4711',
    body: 'hello',
    channelProviderKey: 'gmail',
    sourceNamespace: NAMESPACE,
    sourceKey,
    sourceIdentityId: 'identity-1',
    sourceAssociationEpoch: 1,
    retractionState: null,
    retractionSagaId: null,
    retractedAt: null,
    deletedAt: null,
    ...overrides,
  }
}

const createInput = {
  scope,
  actor,
  customer: { kind: 'person' as const, id: PERSON },
  namespace: NAMESPACE,
  sourceKey: 'msg-1',
  identityId: 'identity-1',
  associationEpoch: 1,
  payload: {
    interactionType: 'email',
    title: 'Order 4711',
    body: 'hello',
    channelProviderKey: 'gmail',
  },
}

describe('createInteraction', () => {
  it('creates a projected interaction carrying its source keys and retraction group', async () => {
    const fixture: Fixture = { customer: customer(), interactions: [], sagas: [] }
    const result = await createInteraction(createEm(fixture), createInput)
    expect(result.status).toBe('created')
    expect(fixture.interactions[0]).toMatchObject({
      sourceNamespace: NAMESPACE,
      sourceKey: 'msg-1',
      sourceIdentityId: 'identity-1',
      sourceAssociationEpoch: 1,
    })
  })

  it('is idempotent for an identical retry', async () => {
    const fixture: Fixture = { customer: customer(), interactions: [member('msg-1')], sagas: [] }
    const result = await createInteraction(createEm(fixture), createInput)
    expect(result).toEqual({ status: 'duplicate', interactionId: 'interaction-msg-1' })
    expect(fixture.interactions).toHaveLength(1)
  })

  // Treating a changed retry as the same projection would let a caller rewrite
  // a customer's timeline entry through the idempotency path.
  it('refuses a changed payload under the same source key', async () => {
    const fixture: Fixture = { customer: customer(), interactions: [member('msg-1')], sagas: [] }
    const result = await createInteraction(createEm(fixture), {
      ...createInput,
      payload: { ...createInput.payload, body: 'something else' },
    })
    expect(result).toEqual({ status: 'conflict', reason: 'payload_mismatch' })
  })

  // A row adopted into the wrong group could never be reached by that group's
  // retraction.
  it('refuses the same source key under a different identity or epoch', async () => {
    const fixture: Fixture = { customer: customer(), interactions: [member('msg-1')], sagas: [] }
    const em = createEm(fixture)
    await expect(
      createInteraction(em, { ...createInput, identityId: 'identity-2' }),
    ).resolves.toEqual({ status: 'conflict', reason: 'group_mismatch' })
    await expect(
      createInteraction(em, { ...createInput, associationEpoch: 2 }),
    ).resolves.toEqual({ status: 'conflict', reason: 'group_mismatch' })
  })

  it('refuses to project onto a customer it cannot resolve', async () => {
    const fixture: Fixture = { customer: null, interactions: [], sagas: [] }
    const result = await createInteraction(createEm(fixture), createInput)
    expect(result).toEqual({ status: 'customer_missing' })
    expect(fixture.interactions).toHaveLength(0)
  })

  it('refuses an actor without the retract feature', async () => {
    const fixture: Fixture = { customer: customer(), interactions: [], sagas: [] }
    const result = await createInteraction(createEm(fixture), {
      ...createInput,
      actor: { ...actor, features: [] },
    })
    expect(result).toEqual({ status: 'forbidden' })
    expect(fixture.interactions).toHaveLength(0)
  })

  it('accepts a wildcard feature grant', async () => {
    const fixture: Fixture = { customer: customer(), interactions: [], sagas: [] }
    const result = await createInteraction(createEm(fixture), {
      ...createInput,
      actor: { ...actor, features: ['customers.*'] },
    })
    expect(result.status).toBe('created')
  })
})

describe('beginRetractionSaga', () => {
  const beginInput = {
    scope: sagaScope,
    actor,
    identityId: 'identity-1',
    associationEpoch: 1,
    inventory: ['msg-1', 'msg-2'],
    reason: 'mistaken link',
    idempotencyKey: 'idem-1',
  }

  it('hides the whole group and journals the inventory', async () => {
    const fixture: Fixture = {
      customer: customer(),
      interactions: [member('msg-1'), member('msg-2')],
      sagas: [],
    }
    const result = await beginRetractionSaga(createEm(fixture), beginInput)
    expect(result).toEqual({ status: 'begun', hiddenCount: 2, inventory: ['msg-1', 'msg-2'] })
    for (const row of fixture.interactions) {
      expect(row.retractionState).toBe('pending_hidden')
      // Hidden through the module's existing soft-delete predicate, which every
      // ordinary reader already applies.
      expect(row.deletedAt).toBeInstanceOf(Date)
      expect(row.retractionSagaId).toBe('saga-1')
    }
  })

  // An omitted key would leave part of a mistaken link on the timeline; an
  // extra key means the caller's view is stale. Either way, hide nothing.
  it('hides nothing when the caller omitted a member', async () => {
    const fixture: Fixture = {
      customer: customer(),
      interactions: [member('msg-1'), member('msg-2')],
      sagas: [],
    }
    const result = await beginRetractionSaga(createEm(fixture), {
      ...beginInput,
      inventory: ['msg-1'],
    })
    expect(result).toEqual({
      status: 'inventory_conflict',
      missingFromRequest: ['msg-2'],
      unknownInRequest: [],
    })
    expect(fixture.interactions.every((row) => row.deletedAt == null)).toBe(true)
    expect(fixture.sagas).toHaveLength(0)
  })

  it('hides nothing when the caller supplied an unknown member', async () => {
    const fixture: Fixture = { customer: customer(), interactions: [member('msg-1')], sagas: [] }
    const result = await beginRetractionSaga(createEm(fixture), {
      ...beginInput,
      inventory: ['msg-1', 'msg-stale'],
    })
    expect(result).toEqual({
      status: 'inventory_conflict',
      missingFromRequest: [],
      unknownInRequest: ['msg-stale'],
    })
    expect(fixture.interactions[0].deletedAt).toBeNull()
  })

  // Recovering from a lost acknowledgement must not hide twice.
  it('is idempotent when the saga already exists', async () => {
    const fixture: Fixture = {
      customer: customer(),
      interactions: [member('msg-1', { retractionSagaId: 'saga-1', retractionState: 'pending_hidden' })],
      sagas: [
        {
          tenantId: TENANT,
          organizationId: ORG,
          namespace: NAMESPACE,
          sagaId: 'saga-1',
          epoch: 1,
          inventory: ['msg-1'],
        },
      ],
    }
    const result = await beginRetractionSaga(createEm(fixture), {
      ...beginInput,
      inventory: ['msg-1'],
    })
    expect(result).toEqual({ status: 'already_begun', hiddenCount: 1, inventory: ['msg-1'] })
  })

  it('rejects a stale worker carrying an older epoch', async () => {
    const fixture: Fixture = {
      customer: customer(),
      interactions: [member('msg-1')],
      sagas: [
        {
          tenantId: TENANT,
          organizationId: ORG,
          namespace: NAMESPACE,
          sagaId: 'saga-1',
          epoch: 5,
          inventory: ['msg-1'],
        },
      ],
    }
    const result = await beginRetractionSaga(createEm(fixture), { ...beginInput, inventory: ['msg-1'] })
    expect(result).toEqual({ status: 'stale_epoch', currentEpoch: 5 })
  })

  // A member of a NEWER association epoch belongs to a later link, and an older
  // unlink must not reach it.
  it('never touches a member of a different association epoch', async () => {
    const laterEpochMember = member('msg-later', { sourceAssociationEpoch: 2 })
    const fixture: Fixture = {
      customer: customer(),
      interactions: [member('msg-1'), laterEpochMember],
      sagas: [],
    }
    const result = await beginRetractionSaga(createEm(fixture), {
      ...beginInput,
      inventory: ['msg-1'],
    })
    expect(result).toMatchObject({ status: 'begun', hiddenCount: 1 })
    expect(laterEpochMember.deletedAt).toBeNull()
  })

  it('refuses an unauthorized actor', async () => {
    const fixture: Fixture = { customer: customer(), interactions: [member('msg-1')], sagas: [] }
    const result = await beginRetractionSaga(createEm(fixture), {
      ...beginInput,
      actor: { ...actor, features: [] },
    })
    expect(result).toEqual({ status: 'forbidden' })
  })
})

describe('retraction decisions', () => {
  function withSaga(overrides: Row = {}): Fixture {
    return {
      customer: customer(),
      interactions: [
        member('msg-1', {
          retractionState: 'pending_hidden',
          retractionSagaId: 'saga-1',
          deletedAt: new Date(),
        }),
      ],
      sagas: [
        {
          tenantId: TENANT,
          organizationId: ORG,
          namespace: NAMESPACE,
          sagaId: 'saga-1',
          epoch: 1,
          identityId: 'identity-1',
          associationEpoch: 1,
          inventory: ['msg-1'],
          decision: null,
          finalizedAt: null,
          ...overrides,
        },
      ],
    }
  }

  it('records a commit and is idempotent on replay', async () => {
    const fixture = withSaga()
    const em = createEm(fixture)
    await expect(commitRetractionSaga(em, { scope: sagaScope, actor })).resolves.toEqual({
      status: 'decided',
      decision: 'commit',
    })
    await expect(commitRetractionSaga(em, { scope: sagaScope, actor })).resolves.toEqual({
      status: 'already_decided',
      decision: 'commit',
    })
  })

  // Commit and abort are mutually exclusive: a recovery worker replaying the
  // other decision must not be able to flip a settled saga.
  it('refuses an abort after a commit and vice versa', async () => {
    const committed = createEm(withSaga({ decision: 'commit' }))
    await expect(abortRetractionSaga(committed, { scope: sagaScope, actor })).resolves.toEqual({
      status: 'conflicting_decision',
      decision: 'commit',
    })

    const aborted = createEm(withSaga({ decision: 'abort' }))
    await expect(commitRetractionSaga(aborted, { scope: sagaScope, actor })).resolves.toEqual({
      status: 'conflicting_decision',
      decision: 'abort',
    })
  })

  it('rejects a decision carrying a stale epoch', async () => {
    const em = createEm(withSaga({ epoch: 7 }))
    await expect(commitRetractionSaga(em, { scope: sagaScope, actor })).resolves.toEqual({
      status: 'stale_epoch',
      currentEpoch: 7,
    })
  })

  it('reports a missing saga', async () => {
    const em = createEm({ customer: customer(), interactions: [], sagas: [] })
    await expect(commitRetractionSaga(em, { scope: sagaScope, actor })).resolves.toEqual({
      status: 'missing',
    })
  })
})

describe('finalizeRetractionSaga', () => {
  function withDecision(decision: 'commit' | 'abort', extraInteractions: Row[] = []): Fixture {
    return {
      customer: customer(),
      interactions: [
        member('msg-1', {
          retractionState: 'pending_hidden',
          retractionSagaId: 'saga-1',
          retractedAt: new Date(),
          deletedAt: new Date(),
        }),
        ...extraInteractions,
      ],
      sagas: [
        {
          tenantId: TENANT,
          organizationId: ORG,
          namespace: NAMESPACE,
          sagaId: 'saga-1',
          epoch: 1,
          identityId: 'identity-1',
          associationEpoch: 1,
          inventory: ['msg-1'],
          decision,
          finalizedAt: null,
        },
      ],
    }
  }

  it('tombstones the hidden members on commit', async () => {
    const fixture = withDecision('commit')
    const result = await finalizeRetractionSaga(createEm(fixture), { scope: sagaScope, actor })
    expect(result).toEqual({ status: 'finalized', decision: 'commit', affectedCount: 1 })
    expect(fixture.interactions[0].retractionState).toBe('tombstoned')
    // Still hidden from ordinary readers; a restricted audit reader can tell it
    // apart from a user deletion.
    expect(fixture.interactions[0].deletedAt).toBeInstanceOf(Date)
  })

  it('restores exactly what the saga hid on abort', async () => {
    const fixture = withDecision('abort')
    const result = await finalizeRetractionSaga(createEm(fixture), { scope: sagaScope, actor })
    expect(result).toEqual({ status: 'finalized', decision: 'abort', affectedCount: 1 })
    expect(fixture.interactions[0]).toMatchObject({
      retractionState: null,
      retractedAt: null,
      retractionSagaId: null,
      deletedAt: null,
    })
  })

  // An abort must undo the saga, not resurrect unrelated decisions.
  it('does not resurrect a row deleted outside the saga', async () => {
    const independentlyDeleted = member('msg-other', { deletedAt: new Date() })
    const fixture = withDecision('abort', [independentlyDeleted])
    await finalizeRetractionSaga(createEm(fixture), { scope: sagaScope, actor })
    expect(independentlyDeleted.deletedAt).toBeInstanceOf(Date)
  })

  it('refuses to finalize an undecided saga', async () => {
    const fixture = withDecision('commit')
    fixture.sagas[0].decision = null
    const result = await finalizeRetractionSaga(createEm(fixture), { scope: sagaScope, actor })
    expect(result).toEqual({ status: 'undecided' })
  })

  // Recovery replays finalize; the stored decision, not the caller's intent, is
  // what makes that safe.
  it('is idempotent once finalized', async () => {
    const fixture = withDecision('commit')
    fixture.sagas[0].finalizedAt = new Date()
    const result = await finalizeRetractionSaga(createEm(fixture), { scope: sagaScope, actor })
    expect(result).toEqual({ status: 'already_finalized', decision: 'commit' })
  })
})

describe('listRetractions', () => {
  it('lets a caller recover the inventory after a lost acknowledgement', async () => {
    const fixture: Fixture = {
      customer: customer(),
      interactions: [],
      sagas: [
        {
          tenantId: TENANT,
          organizationId: ORG,
          namespace: NAMESPACE,
          sagaId: 'saga-1',
          epoch: 1,
          inventory: ['msg-1', 'msg-2'],
          decision: 'commit',
          finalizedAt: null,
        },
      ],
    }
    const result = await listRetractions(createEm(fixture), { scope: sagaScope, actor })
    expect(result).toEqual({
      status: 'found',
      inventory: ['msg-1', 'msg-2'],
      decision: 'commit',
      finalized: false,
      epoch: 1,
    })
  })

  it('reports a foreign namespace as missing', async () => {
    const fixture: Fixture = {
      customer: customer(),
      interactions: [],
      sagas: [
        {
          tenantId: TENANT,
          organizationId: ORG,
          namespace: 'someone-else',
          sagaId: 'saga-1',
          epoch: 1,
          inventory: ['msg-1'],
        },
      ],
    }
    const result = await listRetractions(createEm(fixture), { scope: sagaScope, actor })
    expect(result).toEqual({ status: 'missing' })
  })

  it('refuses an unauthorized actor', async () => {
    const em = createEm({ customer: customer(), interactions: [], sagas: [] })
    const result = await listRetractions(em, { scope: sagaScope, actor: { ...actor, features: [] } })
    expect(result).toEqual({ status: 'forbidden' })
  })
})

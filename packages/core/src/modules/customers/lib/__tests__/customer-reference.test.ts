import type { EntityManager } from '@mikro-orm/postgresql'
import { CustomerEntity } from '../../data/entities'
import { resolveCustomerReference } from '../customer-reference'

/**
 * The reference check runs BEFORE any downstream mutation, so it is the last
 * point at which a bad link can be stopped cheaply. It must therefore be strict
 * about what it accepts and silent about what it rejects.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999'
const ORG = '22222222-2222-4222-8222-222222222222'
const SIBLING_ORG = '33333333-3333-4333-8333-333333333333'
const PERSON = '44444444-4444-4444-8444-444444444444'

const scope = { tenantId: TENANT, organizationId: ORG }

function createEm(row: Record<string, unknown> | null): EntityManager {
  return {
    findOne: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
      if (entity !== CustomerEntity || !row) return null
      return Object.entries(where).every(([key, value]) => row[key] === value) ? row : null
    }),
  } as unknown as EntityManager
}

function person(overrides: Record<string, unknown> = {}) {
  return {
    id: PERSON,
    kind: 'person',
    tenantId: TENANT,
    organizationId: ORG,
    deletedAt: null,
    displayName: 'Alice Example',
    primaryEmail: 'alice@example.com',
    ...overrides,
  }
}

describe('resolveCustomerReference', () => {
  it('resolves an active person to id and kind only', async () => {
    const result = await resolveCustomerReference(createEm(person()), {
      kind: 'person',
      id: PERSON,
      scope,
    })
    // Deliberately minimal: a projector does not need — and must not receive —
    // the customer's name or email just to link to them.
    expect(result).toEqual({ status: 'resolved', reference: { kind: 'person', id: PERSON } })
  })

  it('resolves an active company', async () => {
    const result = await resolveCustomerReference(
      createEm(person({ kind: 'company' })),
      { kind: 'company', id: PERSON, scope },
    )
    expect(result).toEqual({ status: 'resolved', reference: { kind: 'company', id: PERSON } })
  })

  // Every negative answer is the same answer: a caller must not be able to
  // learn that an id exists somewhere it cannot see.
  it.each([
    ['a wrong kind', person({ kind: 'company' }), 'person'],
    ['a deleted customer', person({ deletedAt: new Date() }), 'person'],
    ['a sibling organization', person({ organizationId: SIBLING_ORG }), 'person'],
    ['another tenant', person({ tenantId: OTHER_TENANT }), 'person'],
  ])('returns missing for %s', async (_label, row, kind) => {
    const result = await resolveCustomerReference(createEm(row), {
      kind: kind as 'person',
      id: PERSON,
      scope,
    })
    expect(result).toEqual({ status: 'missing' })
  })

  it('returns missing for an id that does not exist', async () => {
    const result = await resolveCustomerReference(createEm(null), {
      kind: 'person',
      id: PERSON,
      scope,
    })
    expect(result).toEqual({ status: 'missing' })
  })

  // `deal` and `address` are real customer-module entities; silently widening
  // the accepted set would let a caller project onto records this contract was
  // never reviewed for.
  it('rejects a kind outside person|company without querying', async () => {
    const em = createEm(person())
    const result = await resolveCustomerReference(em, {
      kind: 'deal' as never,
      id: PERSON,
      scope,
    })
    expect(result).toEqual({ status: 'missing' })
    expect(em.findOne).not.toHaveBeenCalled()
  })
})

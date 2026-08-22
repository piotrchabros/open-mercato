import { enrichers } from '../enrichers'

/**
 * The enrichers are the only Connect data that reaches a Customers screen. What
 * matters is that they are gated on the same feature as the context API, batch
 * a whole page into one query, and contribute NOTHING for a reference they
 * cannot account for — an explicit zero would confirm the record exists in this
 * scope.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION = '22222222-2222-4222-8222-222222222222'

type Row = { kind: string; id: string; open_count: number; last_case_at: string | null; last_case_status: string | null }

function createCtx(rows: Row[], options: { active?: boolean; tenantId?: string | null; organizationId?: string | null } = {}) {
  const calls: Array<{ sql: string }> = []
  const em = {
    execute: jest.fn(async (sql: string) => {
      calls.push({ sql })
      return rows
    }),
  }
  const container = {
    hasRegistration: () => options.active !== false,
    resolve: (name: string) => {
      if (name === 'em') return em
      if (name === 'customersInteractionLifecycle' && options.active === false) {
        throw new Error('[internal] not registered')
      }
      return {}
    },
  }
  return {
    ctx: {
      em,
      container,
      tenantId: options.tenantId === undefined ? TENANT : options.tenantId,
      organizationId: options.organizationId === undefined ? ORGANIZATION : options.organizationId,
      userId: 'user-1',
    },
    calls,
  }
}

const personEnricher = enrichers.find((entry) => entry.targetEntity === 'customers.person')!
const companyEnricher = enrichers.find((entry) => entry.targetEntity === 'customers.company')!

describe('connect customer-context enrichers', () => {
  it('registers one enricher per customer entity', () => {
    expect(enrichers).toHaveLength(2)
    expect(personEnricher).toBeDefined()
    expect(companyEnricher).toBeDefined()
  })

  it('requires the same feature as the context API', () => {
    // Otherwise a viewer denied by the route could get the same numbers by
    // loading a customer list instead.
    for (const enricher of enrichers) {
      expect(enricher.features).toEqual(['connect.customer_match.read'])
    }
  })

  it('never caches its output on a list cache hit', () => {
    // It aggregates over connect_cases, which the customers list cache knows
    // nothing about, so a cached page would serve stale counts.
    for (const enricher of enrichers) {
      expect(enricher.cacheableOnListHit).toBe(false)
    }
  })

  it('adds `_connect` to a record with in-scope traffic', async () => {
    const { ctx } = createCtx([
      { kind: 'person', id: 'p1', open_count: 3, last_case_at: '2026-08-22T09:00:00.000Z', last_case_status: 'new' },
    ])
    const [record] = await personEnricher.enrichMany!([{ id: 'p1' }], ctx as never)
    expect(record).toMatchObject({
      id: 'p1',
      _connect: { openCaseCount: 3, lastCaseAt: '2026-08-22T09:00:00.000Z', lastCaseStatus: 'new' },
    })
  })

  it('leaves an unaccounted record untouched rather than reporting zero', async () => {
    const { ctx } = createCtx([])
    const [record] = await personEnricher.enrichMany!([{ id: 'foreign' }], ctx as never)
    expect(record).not.toHaveProperty('_connect')
  })

  it('answers a whole page with one query', async () => {
    const records = Array.from({ length: 40 }, (_unused, index) => ({ id: `p${index}` }))
    const { ctx, calls } = createCtx([])
    await personEnricher.enrichMany!(records, ctx as never)
    expect(calls).toHaveLength(1)
  })

  it('keys company records on the company kind', async () => {
    const { ctx } = createCtx([
      { kind: 'company', id: 'c1', open_count: 1, last_case_at: null, last_case_status: null },
    ])
    const [record] = await companyEnricher.enrichMany!([{ id: 'c1' }], ctx as never)
    expect(record).toHaveProperty('_connect')
  })

  it('contributes nothing when Connect is not activated', async () => {
    const { ctx, calls } = createCtx([], { active: false })
    const [record] = await personEnricher.enrichMany!([{ id: 'p1' }], ctx as never)
    expect(record).not.toHaveProperty('_connect')
    expect(calls).toHaveLength(0)
  })

  it('contributes nothing without a selected organization', async () => {
    // Falling back to the tenant would mix one organization's conversation
    // counts into another's customer list.
    const { ctx, calls } = createCtx([], { organizationId: null })
    const [record] = await personEnricher.enrichMany!([{ id: 'p1' }], ctx as never)
    expect(record).not.toHaveProperty('_connect')
    expect(calls).toHaveLength(0)
  })

  it('routes the single-record path through the same batched reader', async () => {
    const { ctx, calls } = createCtx([
      { kind: 'person', id: 'p1', open_count: 1, last_case_at: null, last_case_status: null },
    ])
    const record = await personEnricher.enrichOne({ id: 'p1' }, ctx as never)
    expect(record).toHaveProperty('_connect')
    expect(calls).toHaveLength(1)
  })
})

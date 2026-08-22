import type { EntityManager } from '@mikro-orm/postgresql'
import { CUSTOMER_CONTEXT_BATCH_LIMIT, readCustomerContexts } from '../customer-context'

/**
 * The context reader is the only thing that decides what a Customer screen may
 * learn about Connect. Its two safety properties are tested here: it never
 * confirms an out-of-scope reference, and it answers a whole page with one
 * query.
 */

const SCOPE = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}

type Row = {
  kind: string
  id: string
  open_count: number
  last_case_at: string | null
  last_case_status: string | null
}

function createEm(rows: Row[]): { em: EntityManager; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const em = {
    execute: jest.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return rows
    }),
  } as unknown as EntityManager
  return { em, calls }
}

describe('readCustomerContexts', () => {
  it('maps a contributing reference to its counts', async () => {
    const { em } = createEm([
      { kind: 'person', id: 'p1', open_count: 2, last_case_at: '2026-08-22T10:00:00.000Z', last_case_status: 'new' },
    ])
    const contexts = await readCustomerContexts(em, SCOPE, [{ kind: 'person', id: 'p1' }])
    expect(contexts).toEqual([
      {
        kind: 'person',
        id: 'p1',
        openCaseCount: 2,
        lastCaseAt: '2026-08-22T10:00:00.000Z',
        lastCaseStatus: 'new',
      },
    ])
  })

  it('omits references with no contribution instead of returning zeros', async () => {
    // A zeroed entry would confirm the reference exists in this scope, which is
    // exactly what a foreign reference must not be able to establish.
    const { em } = createEm([])
    const contexts = await readCustomerContexts(em, SCOPE, [{ kind: 'person', id: 'foreign' }])
    expect(contexts).toEqual([])
  })

  it('never crosses a person id with a company kind', async () => {
    // The driver is asked for PAIRS, so a grouped row for another kind cannot be
    // attributed to the requested one.
    const { em } = createEm([
      { kind: 'company', id: 'p1', open_count: 9, last_case_at: null, last_case_status: null },
    ])
    const contexts = await readCustomerContexts(em, SCOPE, [{ kind: 'person', id: 'p1' }])
    expect(contexts).toEqual([])
  })

  it('issues exactly one query for a whole page', async () => {
    const refs = Array.from({ length: 50 }, (_unused, index) => ({
      kind: 'person' as const,
      id: `p${index}`,
    }))
    const { em, calls } = createEm([])
    await readCustomerContexts(em, SCOPE, refs)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sql).toContain('group by')
  })

  it('scopes every query to the caller tenant and organization', async () => {
    const { em, calls } = createEm([])
    await readCustomerContexts(em, SCOPE, [{ kind: 'person', id: 'p1' }])
    expect(calls[0]!.params).toContain(SCOPE.tenantId)
    expect(calls[0]!.params).toContain(SCOPE.organizationId)
  })

  it('deduplicates repeated references', async () => {
    const { em, calls } = createEm([])
    await readCustomerContexts(em, SCOPE, [
      { kind: 'person', id: 'p1' },
      { kind: 'person', id: 'p1' },
    ])
    expect(calls[0]!.sql.match(/\(\?, \?\)/g)).toHaveLength(1)
  })

  it('caps the batch at the published limit', async () => {
    const refs = Array.from({ length: CUSTOMER_CONTEXT_BATCH_LIMIT + 20 }, (_unused, index) => ({
      kind: 'person' as const,
      id: `p${index}`,
    }))
    const { em, calls } = createEm([])
    await readCustomerContexts(em, SCOPE, refs)
    expect(calls[0]!.sql.match(/\(\?, \?\)/g)).toHaveLength(CUSTOMER_CONTEXT_BATCH_LIMIT)
  })

  it('returns nothing without touching the database for an empty batch', async () => {
    const { em, calls } = createEm([])
    expect(await readCustomerContexts(em, SCOPE, [])).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

import {
  CONNECT_CONTACT_DENOMINATOR_CONTRACT_VERSION,
  CONNECT_DENOMINATOR_MAX_RANGE_DAYS,
  ConnectDenominatorRangeError,
  createConnectContactDenominatorReader,
  validateDenominatorRange,
} from '../contact-denominator-reader'

/**
 * The cost-per-contact denominator.
 *
 * The rule worth protecting: splitting one mis-grouped Case into three does not
 * mean three customers got in touch. If split children counted, cost-per-contact
 * would fall every time a supervisor corrected a mistake — the metric would
 * reward the thing it should be neutral about.
 */

const DAY_MS = 24 * 60 * 60 * 1000

type ExecuteCall = { sql: string; params: unknown[] }

function fakeEm(rows: Array<{ roots: string | number }> = [{ roots: 7 }]) {
  const calls: ExecuteCall[] = []
  const em = {
    fork: () => em,
    execute: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return rows
    },
  }
  return { em, calls }
}

describe('validateDenominatorRange', () => {
  it('accepts a half-open range', () => {
    const range = validateDenominatorRange('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')
    expect(range.from.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(range.to.toISOString()).toBe('2026-02-01T00:00:00.000Z')
  })

  // An empty range would return 0, which reads like a real answer to a
  // malformed question.
  it.each([
    ['an equal from and to', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'empty_range'],
    ['an inverted range', '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'empty_range'],
    ['an unparseable bound', 'not-a-date', '2026-01-01T00:00:00.000Z', 'invalid_range'],
  ] as const)('rejects %s', (_label, from, to, reason) => {
    expect(() => validateDenominatorRange(from, to)).toThrow(ConnectDenominatorRangeError)
    try {
      validateDenominatorRange(from, to)
    } catch (err) {
      expect((err as ConnectDenominatorRangeError).reason).toBe(reason)
    }
  })

  it('accepts exactly the maximum span but not one millisecond more', () => {
    const start = new Date('2026-01-01T00:00:00.000Z')
    const atLimit = new Date(start.getTime() + CONNECT_DENOMINATOR_MAX_RANGE_DAYS * DAY_MS)
    expect(() => validateDenominatorRange(start.toISOString(), atLimit.toISOString())).not.toThrow()

    const overLimit = new Date(atLimit.getTime() + 1)
    try {
      validateDenominatorRange(start.toISOString(), overLimit.toISOString())
      throw new Error('expected a range error')
    } catch (err) {
      expect((err as ConnectDenominatorRangeError).reason).toBe('range_too_large')
    }
  })
})

describe('createConnectContactDenominatorReader', () => {
  const scope = { tenantId: 'tenant-1', organizationId: 'org-1' }
  const window = { from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z' }

  it('returns the versioned scalar and nothing else', async () => {
    const { em } = fakeEm([{ roots: '12' }])
    const reader = createConnectContactDenominatorReader(
      em as never,
      () => new Date('2026-02-02T00:00:00.000Z'),
    )
    await expect(reader.countCanonicalRoots({ ...scope, ...window })).resolves.toEqual({
      contractVersion: CONNECT_CONTACT_DENOMINATOR_CONTRACT_VERSION,
      generatedAt: '2026-02-02T00:00:00.000Z',
      count: 12,
    })
  })

  // Split descendants are a re-grouping of contact already counted under the
  // parent, so the predicate must exclude them.
  it('counts only canonical roots, scoped and non-deleted', async () => {
    const { em, calls } = fakeEm()
    const reader = createConnectContactDenominatorReader(em as never)
    await reader.countCanonicalRoots({ ...scope, ...window })

    const sql = calls[0].sql.replace(/\s+/g, ' ')
    expect(sql).toContain('"split_from_case_id" is null')
    expect(sql).toContain('"deleted_at" is null')
    expect(sql).toContain('"tenant_id" = ?')
    expect(sql).toContain('"organization_id" = ?')
    // Half-open on created_at, so a Case is counted in exactly one window.
    expect(sql).toContain('"created_at" >= ?')
    expect(sql).toContain('"created_at" < ?')
    expect(calls[0].params.slice(0, 2)).toEqual(['tenant-1', 'org-1'])
  })

  it('validates the range before touching the database', async () => {
    const { em, calls } = fakeEm()
    const reader = createConnectContactDenominatorReader(em as never)
    await expect(
      reader.countCanonicalRoots({ ...scope, from: window.to, to: window.from }),
    ).rejects.toThrow(ConnectDenominatorRangeError)
    expect(calls).toHaveLength(0)
  })

  // A denominator needs a number. Returning ids would make this a cross-module
  // enumeration of an organization's Cases.
  it('exposes no case identifiers', async () => {
    const { em } = fakeEm([{ roots: 3 }])
    const reader = createConnectContactDenominatorReader(em as never)
    const result = await reader.countCanonicalRoots({ ...scope, ...window })
    expect(Object.keys(result).sort()).toEqual(['contractVersion', 'count', 'generatedAt'])
  })

  it('reports zero rather than NaN when the scope has no cases', async () => {
    const { em } = fakeEm([])
    const reader = createConnectContactDenominatorReader(em as never)
    await expect(reader.countCanonicalRoots({ ...scope, ...window })).resolves.toMatchObject({ count: 0 })
  })
})

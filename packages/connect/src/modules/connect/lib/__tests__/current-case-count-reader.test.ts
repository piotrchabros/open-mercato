import type { EntityManager } from '@mikro-orm/postgresql'
import {
  CONNECT_ACTIVE_CASE_STATUSES,
  CONNECT_MAX_CURRENT_CASE_COUNT,
  createConnectCurrentCaseCountReader,
  isActiveConnectCaseStatus,
  parseCurrentCaseCount,
} from '../current-case-count-reader'

type ExecutedQuery = { sql: string; params: unknown[] }

function createEmStub(rows: Array<{ assigneeUserId: string; currentCaseCount: unknown }>) {
  const executed: ExecutedQuery[] = []
  const em = {
    execute: async (sql: string, params: unknown[]) => {
      executed.push({ sql, params })
      return rows
    },
  } as unknown as EntityManager
  return { em, executed }
}

describe('connect current case count reader', () => {
  it('counts only statuses that are still workload', () => {
    for (const status of ['new', 'in_progress', 'waiting_customer']) {
      expect(isActiveConnectCaseStatus(status)).toBe(true)
    }
    for (const status of ['resolved', 'closed', 'archived', '']) {
      expect(isActiveConnectCaseStatus(status)).toBe(false)
    }
  })

  it('scopes the grouped query to one tenant, one organization and the active statuses', async () => {
    const { em, executed } = createEmStub([])
    const reader = createConnectCurrentCaseCountReader(em)

    await reader.listByAssignee({
      tenantId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
    })

    const [query] = executed
    expect(query.sql).toContain('"tenant_id" = ?')
    expect(query.sql).toContain('"organization_id" = ?')
    // Soft-deleted and unassigned Cases are excluded in SQL rather than in JS:
    // a predicate that only existed in the mapping step would still transfer
    // every row across the wire and would drift from the grouped count.
    expect(query.sql).toContain('"assignee_user_id" is not null')
    expect(query.sql).toContain('"deleted_at" is null')
    expect(query.sql).toContain('group by "assignee_user_id"')
    expect(query.params).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      ...CONNECT_ACTIVE_CASE_STATUSES,
    ])
  })

  it('returns one row per assignee with a numeric count', async () => {
    const { em } = createEmStub([
      { assigneeUserId: 'agent-a', currentCaseCount: '3' },
      { assigneeUserId: 'agent-b', currentCaseCount: 7 },
    ])
    const reader = createConnectCurrentCaseCountReader(em)

    await expect(
      reader.listByAssignee({ tenantId: 'tenant', organizationId: 'organization' }),
    ).resolves.toEqual([
      { assigneeUserId: 'agent-a', currentCaseCount: 3 },
      { assigneeUserId: 'agent-b', currentCaseCount: 7 },
    ])
  })

  it('accepts every driver form of a bigint aggregate at both bounds', () => {
    expect(parseCurrentCaseCount('0')).toBe(0)
    expect(parseCurrentCaseCount(0)).toBe(0)
    expect(parseCurrentCaseCount(BigInt(0))).toBe(0)
    expect(parseCurrentCaseCount(String(CONNECT_MAX_CURRENT_CASE_COUNT))).toBe(CONNECT_MAX_CURRENT_CASE_COUNT)
    expect(parseCurrentCaseCount(BigInt(CONNECT_MAX_CURRENT_CASE_COUNT))).toBe(CONNECT_MAX_CURRENT_CASE_COUNT)
  })

  it('rejects negative, fractional, overflowing and unparseable aggregates', () => {
    for (const raw of [
      -1,
      1.5,
      '-1',
      '1.5',
      'seven',
      '',
      null,
      undefined,
      CONNECT_MAX_CURRENT_CASE_COUNT + 1,
      String(CONNECT_MAX_CURRENT_CASE_COUNT + 1),
      BigInt('9223372036854775807'),
    ]) {
      expect(() => parseCurrentCaseCount(raw)).toThrow('case_count_out_of_range')
    }
  })

  it('fails the whole read rather than letting one bad aggregate through', async () => {
    const { em } = createEmStub([
      { assigneeUserId: 'agent-a', currentCaseCount: '1' },
      { assigneeUserId: 'agent-b', currentCaseCount: '-4' },
    ])
    const reader = createConnectCurrentCaseCountReader(em)

    await expect(
      reader.listByAssignee({ tenantId: 'tenant', organizationId: 'organization' }),
    ).rejects.toThrow('case_count_out_of_range')
  })
})

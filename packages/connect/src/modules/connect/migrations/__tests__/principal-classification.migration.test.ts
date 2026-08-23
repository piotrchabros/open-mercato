import { jest } from '@jest/globals'
import { Migration20260822233500_connect } from '../Migration20260822233500_connect'

async function collectSql(direction: 'up' | 'down'): Promise<string[]> {
  const migration = Object.create(
    Migration20260822233500_connect.prototype,
  ) as Migration20260822233500_connect
  const statements: string[] = []
  Object.defineProperty(migration, 'addSql', {
    value: jest.fn((sql: string) => statements.push(sql.replace(/\s+/g, ' ').trim())),
  })

  await migration[direction]()

  return statements
}

describe('principal classification migration', () => {
  it('creates only the empty scoped classification table and its guards', async () => {
    const statements = await collectSql('up')
    const sql = statements.join(' ')

    expect(statements).toHaveLength(4)
    expect(sql).toContain('create table "connect_principal_classifications"')
    expect(sql).toContain('"tenant_id" uuid not null')
    expect(sql).toContain('"organization_id" uuid not null')
    expect(sql).toContain('"user_id" uuid not null')
    expect(sql).toContain('connect_principal_classifications_scope_user_idx')
    expect(sql).toContain('connect_principal_classifications_scope_user_uq')
    expect(sql).toContain('connect_principal_classifications_kind_chk')
    expect(sql).toContain("'human', 'system_bot', 'integration'")
    expect(sql).not.toContain('insert into')
    expect(sql).not.toContain('auth_')
  })

  it('drops only the classification table', async () => {
    await expect(collectSql('down')).resolves.toEqual([
      'drop table if exists "connect_principal_classifications" cascade;',
    ])
  })
})

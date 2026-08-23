import { jest } from '@jest/globals'
import { Migration20260822235625_connect } from '../Migration20260822235625_connect'

async function collectSql(direction: 'up' | 'down'): Promise<string[]> {
  const migration = Object.create(
    Migration20260822235625_connect.prototype,
  ) as Migration20260822235625_connect
  const statements: string[] = []
  Object.defineProperty(migration, 'addSql', {
    value: jest.fn((sql: string) => statements.push(sql.replace(/\s+/g, ' ').trim())),
  })
  await migration[direction]()
  return statements
}

describe('principal classification provisioning migration', () => {
  it('creates only the immutable ledger and durable manifest tables', async () => {
    const statements = await collectSql('up')
    const sql = statements.join(' ')

    expect(sql).toContain('create table "connect_principal_classification_changes"')
    expect(sql).toContain('create table "connect_principal_classification_manifest_entries"')
    expect(sql).toContain('connect_principal_classification_changes_operation_uq')
    expect(sql).toContain('connect_principal_classification_changes_kind_chk')
    expect(sql).toContain('connect_principal_manifest_scope_external_key_uq')
    expect(sql).toContain('connect_principal_manifest_scope_user_uq')
    expect(sql).toContain('connect_principal_manifest_kind_chk')
    expect(sql).not.toContain('insert into')
    expect(sql).not.toContain('auth_')
    expect(sql).not.toContain('connect_operational_facts')
  })

  it('drops only the two provisioning tables', async () => {
    await expect(collectSql('down')).resolves.toEqual([
      'drop table if exists "connect_principal_classification_manifest_entries" cascade;',
      'drop table if exists "connect_principal_classification_changes" cascade;',
    ])
  })
})

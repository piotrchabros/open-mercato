import fs from 'node:fs'
import path from 'node:path'

const MIGRATION = path.resolve(__dirname, '../migrations/Migration20260824013500_connect_sla.ts')
const SNAPSHOT = path.resolve(__dirname, '../migrations/.snapshot-open-mercato.json')

describe('connect SLA migration', () => {
  const source = fs.readFileSync(MIGRATION, 'utf8')
  const tables = [
    'connect_sla_business_calendars',
    'connect_sla_business_calendar_versions',
    'connect_sla_business_windows',
    'connect_sla_business_holidays',
    'connect_sla_policies',
    'connect_sla_policy_versions',
    'connect_sla_case_clocks',
    'connect_sla_event_receipts',
    'connect_sla_event_outbox',
    'connect_sla_rebuild_runs',
    'connect_sla_clock_revisions',
  ]

  it.each(tables)('creates and reverses %s', (table) => {
    expect(source).toContain(`create table \"${table}\"`)
    expect(source).toContain(`drop table if exists \"${table}\" cascade`)
  })

  it('contains the scoped uniqueness and state constraints', () => {
    expect(source).toContain('connect_sla_business_calendars_default_uq')
    expect(source).toContain('connect_sla_case_clocks_case_generation_uq')
    expect(source).toContain('connect_sla_event_receipts_uq')
    expect(source).toContain('connect_sla_rebuild_runs_command_uq')
    expect(source).toContain('connect_sla_case_clocks_response_state_chk')
    expect(source).toContain('connect_sla_case_clocks_resolution_state_chk')
  })

  it('protects same-module references without coupling to Connect tables', () => {
    expect(source).toContain('connect_sla_business_calendar_versions_calendar_id_foreign')
    expect(source).toContain('connect_sla_policy_versions_calendar_version_id_foreign')
    expect(source).toContain('connect_sla_case_clocks_policy_version_id_foreign')
    expect(source).toContain('connect_sla_clock_revisions_clock_id_foreign')
    expect(source).not.toMatch(/references "connect_(?!sla_)/)
  })

  it('keeps a complete scoped snapshot for exactly the migrated tables', () => {
    const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as { tables: Array<{ name: string; columns: Record<string, unknown>; foreignKeys?: Record<string, unknown> }> }
    expect(snapshot.tables.map((table) => table.name).sort()).toEqual([...tables].sort())
    for (const table of snapshot.tables) {
      expect(Object.keys(table.columns)).toEqual(expect.arrayContaining(['id', 'tenant_id', 'organization_id', 'created_at']))
    }
  })
})

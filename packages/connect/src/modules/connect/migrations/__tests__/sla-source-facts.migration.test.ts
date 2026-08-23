import { jest } from '@jest/globals'
import { Migration20260823120000_connect } from '../Migration20260823120000_connect'

async function collectSql(direction: 'up' | 'down'): Promise<string[]> {
  const migration = Object.create(
    Migration20260823120000_connect.prototype,
  ) as Migration20260823120000_connect
  const statements: string[] = []
  Object.defineProperty(migration, 'addSql', {
    value: jest.fn((sql: string) => statements.push(sql.replace(/\s+/g, ' ').trim())),
  })

  await migration[direction]()

  return statements
}

describe('sla source facts migration', () => {
  it('backfills existing history as unverifiable rather than retro-crediting anyone', async () => {
    const sql = (await collectSql('up')).join(' ')
    expect(sql).toContain(`"response_evidence" text not null default 'unknown'`)
    // Nothing may look up who a present-day user is on behalf of a past send.
    expect(sql).not.toContain('update "connect_outbound_messages" set')
    expect(sql).not.toContain('auth_')
    expect(sql).not.toContain('insert into')
  })

  it('starts every existing case at round 0 and forbids a negative round', async () => {
    const sql = (await collectSql('up')).join(' ')
    expect(sql).toContain(`alter table "connect_cases" add column "sla_generation" int not null default 0;`)
    expect(sql).toContain('connect_cases_sla_generation_chk')
  })

  it('creates the three scoped fact tables with their idempotency keys', async () => {
    const sql = (await collectSql('up')).join(' ')
    for (const table of [
      'connect_case_generation_facts',
      'connect_case_wait_facts',
      'connect_outbound_delivery_facts',
    ]) {
      expect(sql).toContain(`create table "${table}"`)
      // Scope on every row, and the unique key that makes a replay a no-op.
      expect(sql).toContain(`alter table "${table}" add constraint "${table}_source_uq" unique ("tenant_id", "organization_id", "source_event_id");`)
      expect(sql).toContain(`create index "${table}_keyset_idx" on "${table}" ("tenant_id", "organization_id", "occurred_at", "id");`)
      expect(sql).toContain(`create index "${table}_case_idx" on "${table}" ("tenant_id", "organization_id", "case_id", "generation", "occurred_at", "id");`)
    }
  })

  it('constrains every closed enum it introduces', async () => {
    const sql = (await collectSql('up')).join(' ')
    expect(sql).toContain(`"content_origin" in ('human_authored', 'ai_draft', 'automation')`)
    expect(sql).toContain(`"response_evidence" in ('human', 'human_accepted_ai', 'unknown')`)
    expect(sql).toContain(`"boundary" in ('started', 'resolved')`)
    expect(sql).toContain(`"boundary" in ('started', 'ended')`)
    expect(sql).toContain(`"cause" in ('opened', 'reopened', 'resolved')`)
  })

  it('touches no table outside connect', async () => {
    const statements = [...(await collectSql('up')), ...(await collectSql('down'))]
    for (const statement of statements) {
      expect(statement).toMatch(/"connect_[a-z_]+"/)
    }
  })

  it('reverses cleanly', async () => {
    const sql = (await collectSql('down')).join(' ')
    expect(sql).toContain('drop table if exists "connect_outbound_delivery_facts" cascade;')
    expect(sql).toContain('drop table if exists "connect_case_wait_facts" cascade;')
    expect(sql).toContain('drop table if exists "connect_case_generation_facts" cascade;')
    expect(sql).toContain('alter table "connect_cases" drop column "sla_generation";')
  })
})

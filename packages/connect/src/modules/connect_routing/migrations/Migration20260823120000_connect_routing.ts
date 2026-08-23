import { Migration } from '@mikro-orm/migrations';

/**
 * Mercato Connect — routing capacity foundation.
 *
 * Creates empty storage only. The backfill deliberately lives in module setup
 * rather than in an `insert ... select connect_cases` here: cross-module SQL in
 * a migration would bypass module isolation outright, and would fail on any
 * deployment where Connect is not installed.
 *
 * `down()` drops only the two tables this migration created. Disabling the
 * module is not a schema rollback — an operator who wants the tables gone runs
 * this deliberately, because dropping them discards a projection that would then
 * have to be rebuilt before routing could be enabled again.
 */
export class Migration20260823120000_connect_routing extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "connect_agent_presences" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "user_id" uuid not null, "status" text not null default 'offline', "current_case_count" int not null default 0, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    // Unconditional, because a presence row is a durable identity that is never
    // soft-deleted. Reconciliation zeroes a departed agent's count and keeps the
    // row, so the upsert target is unambiguous on every rerun.
    this.addSql(`alter table "connect_agent_presences" add constraint "connect_agent_presences_scope_uq" unique ("tenant_id", "organization_id", "user_id");`);
    this.addSql(`create index "connect_agent_presences_status_idx" on "connect_agent_presences" ("tenant_id", "organization_id", "status");`);
    // `available`, `busy` and `away` are accepted now so Phase 3 can start
    // writing liveness without a schema change; Phase 2 only ever writes 'offline'.
    this.addSql(`alter table "connect_agent_presences" add constraint "connect_agent_presences_status_chk" check ("status" in ('available', 'busy', 'away', 'offline'));`);
    this.addSql(`alter table "connect_agent_presences" add constraint "connect_agent_presences_case_count_chk" check ("current_case_count" >= 0 and "current_case_count" <= 2147483647);`);

    this.addSql(`create table "connect_routing_capacity_checkpoints" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "state" text not null default 'pending', "foundation_version" text null, "generation" bigint not null default 0, "last_attempt_at" timestamptz not null, "completed_at" timestamptz null, "last_error_code" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_routing_capacity_checkpoints" add constraint "connect_routing_capacity_checkpoints_scope_uq" unique ("tenant_id", "organization_id");`);
    this.addSql(`alter table "connect_routing_capacity_checkpoints" add constraint "connect_routing_capacity_checkpoints_state_chk" check ("state" in ('pending', 'completed', 'dependency_unavailable', 'failed'));`);
    this.addSql(`alter table "connect_routing_capacity_checkpoints" add constraint "connect_routing_capacity_checkpoints_generation_chk" check ("generation" >= 0);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "connect_routing_capacity_checkpoints" cascade;`);
    this.addSql(`drop table if exists "connect_agent_presences" cascade;`);
  }

}

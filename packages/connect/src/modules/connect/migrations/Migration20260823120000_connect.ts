import { Migration } from '@mikro-orm/migrations';

/**
 * Mercato Connect — case reparenting (split, merge, conditional undo).
 *
 * Additive throughout: new nullable columns, one defaulted integer, three new
 * tables and a set of indexes. Nothing existing is rewritten, so the schema can
 * roll out ahead of the code that uses it.
 *
 * Two steps deserve explanation.
 *
 * The active-binding unique index is a real invariant change, not bookkeeping.
 * Reparenting reads "the conversation's open interval" as a singular fact; if
 * two ever existed, an undo could close the wrong one. The migration therefore
 * PREFLIGHTS for duplicates and aborts with a named, actionable error rather
 * than picking a winner — silently unbinding one of a customer's conversations
 * is exactly the class of damage this feature exists to prevent.
 *
 * The Case-number sequence is seeded from each scope's existing maximum with an
 * upsert that keeps the greater value. That makes the migration safe to re-run
 * while traffic continues: a rerun can only ever move a sequence forward, and
 * the Case-number unique constraint remains the final guard either way.
 */
export class Migration20260823120000_connect extends Migration {

  override up(): void | Promise<void> {
    // ── Case lineage ──────────────────────────────────────────
    this.addSql(`alter table "connect_cases" add column "merged_into_case_id" uuid null;`);
    this.addSql(`alter table "connect_cases" add column "split_from_case_id" uuid null;`);
    // Defaulted rather than backfilled: Postgres 11+ stores the default in the
    // catalog, so this is a metadata-only change even on a large table.
    this.addSql(`alter table "connect_cases" add column "lineage_version" int not null default 0;`);

    this.addSql(`create index "connect_cases_merged_into_idx" on "connect_cases" ("tenant_id", "organization_id", "merged_into_case_id") where "merged_into_case_id" is not null;`);
    this.addSql(`create index "connect_cases_split_from_idx" on "connect_cases" ("tenant_id", "organization_id", "split_from_case_id") where "split_from_case_id" is not null;`);
    // Supports the canonical-root denominator, which counts only Cases that are
    // not split descendants.
    this.addSql(`create index "connect_cases_root_created_idx" on "connect_cases" ("tenant_id", "organization_id", "created_at") where "split_from_case_id" is null and "deleted_at" is null;`);

    // ── One open interval per conversation ────────────────────
    // Abort loudly if the data does not already satisfy the invariant. A
    // migration that resolved duplicates by choosing one would be deciding,
    // unsupervised, which Case a customer's conversation belongs to.
    this.addSql(`do $$
declare
  offenders int;
begin
  select count(*) into offenders from (
    select "tenant_id", "organization_id", "conversation_id"
      from "connect_conversation_case_bindings"
     where "unbound_at" is null
     group by "tenant_id", "organization_id", "conversation_id"
    having count(*) > 1
  ) duplicates;
  if offenders > 0 then
    raise exception 'connect_conversation_case_bindings_active_uq preflight failed: % conversation(s) have more than one open binding interval. Resolve them before migrating; see .ai/specs/2026-08-22-connect-case-reparenting-contract.md', offenders;
  end if;
end $$;`);
    // Dropped first so a retry after a failed/interrupted creation does not trip
    // over an invalid index stub left behind.
    this.addSql(`drop index if exists "connect_conversation_case_bindings_active_uq";`);
    this.addSql(`create unique index "connect_conversation_case_bindings_active_uq" on "connect_conversation_case_bindings" ("tenant_id", "organization_id", "conversation_id") where "unbound_at" is null;`);

    // ── Case number sequence ──────────────────────────────────
    this.addSql(`create table "connect_case_number_sequences" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "next_number" int not null default 1, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "connect_case_number_sequences_pkey" primary key ("id"));`);
    this.addSql(`alter table "connect_case_number_sequences" add constraint "connect_case_number_sequences_scope_uq" unique ("tenant_id", "organization_id");`);
    this.addSql(`alter table "connect_case_number_sequences" add constraint "connect_case_number_sequences_next_chk" check ("next_number" > 0);`);
    this.addSql(`insert into "connect_case_number_sequences" ("tenant_id", "organization_id", "next_number", "created_at", "updated_at")
select "tenant_id", "organization_id", max("number") + 1, now(), now()
  from "connect_cases"
 group by "tenant_id", "organization_id"
on conflict ("tenant_id", "organization_id") do update
   set "next_number" = greatest("connect_case_number_sequences"."next_number", excluded."next_number"),
       "updated_at" = now();`);

    // ── Reparenting audit ─────────────────────────────────────
    this.addSql(`create table "connect_case_reparentings" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "operation" text not null, "source_case_id" uuid not null, "destination_case_id" uuid not null, "client_command_key" text not null, "payload_fingerprint" text not null, "actor_user_id" uuid not null, "reason" text not null, "source_before" jsonb not null, "destination_before" jsonb null, "source_post_updated_at" timestamptz not null, "destination_post_updated_at" timestamptz not null, "reverses_reparenting_id" uuid null, "status" text not null default 'completed', "occurred_at" timestamptz not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, constraint "connect_case_reparentings_pkey" primary key ("id"));`);
    this.addSql(`alter table "connect_case_reparentings" add constraint "connect_case_reparentings_operation_chk" check ("operation" in ('split', 'merge', 'undo_split', 'undo_merge'));`);
    this.addSql(`alter table "connect_case_reparentings" add constraint "connect_case_reparentings_status_chk" check ("status" in ('completed', 'reversed'));`);
    // An inverse row names what it reverses; an original never does.
    this.addSql(`alter table "connect_case_reparentings" add constraint "connect_case_reparentings_inverse_chk" check (("operation" in ('split', 'merge') and "reverses_reparenting_id" is null) or ("operation" in ('undo_split', 'undo_merge') and "reverses_reparenting_id" is not null));`);
    // Only an original can be reversed. An inverse row is terminal — there is no
    // redo, so nothing may ever mark one reversed.
    this.addSql(`alter table "connect_case_reparentings" add constraint "connect_case_reparentings_reversed_chk" check ("status" = 'completed' or "operation" in ('split', 'merge'));`);
    this.addSql(`alter table "connect_case_reparentings" add constraint "connect_case_reparentings_command_uq" unique ("tenant_id", "organization_id", "client_command_key");`);
    // One inverse per original: two undo attempts racing must not both append a
    // reversal and move the same conversations twice.
    this.addSql(`create unique index "connect_case_reparentings_reverses_uq" on "connect_case_reparentings" ("reverses_reparenting_id") where "reverses_reparenting_id" is not null;`);
    this.addSql(`create index "connect_case_reparentings_source_idx" on "connect_case_reparentings" ("tenant_id", "organization_id", "source_case_id", "created_at", "id");`);
    this.addSql(`create index "connect_case_reparentings_destination_idx" on "connect_case_reparentings" ("tenant_id", "organization_id", "destination_case_id", "created_at", "id");`);
    this.addSql(`create index "connect_case_reparentings_keyset_idx" on "connect_case_reparentings" ("tenant_id", "organization_id", "created_at", "id");`);

    this.addSql(`create table "connect_case_reparenting_items" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "reparenting_id" uuid not null, "conversation_id" uuid not null, "from_case_id" uuid not null, "to_case_id" uuid not null, "before_binding_id" uuid not null, "after_binding_id" uuid not null, "before_conversation_updated_at" timestamptz not null, "after_conversation_updated_at" timestamptz not null, "last_message_at_at_execution" timestamptz null, "created_at" timestamptz not null, constraint "connect_case_reparenting_items_pkey" primary key ("id"));`);
    this.addSql(`alter table "connect_case_reparenting_items" add constraint "connect_case_reparenting_items_conversation_uq" unique ("tenant_id", "organization_id", "reparenting_id", "conversation_id");`);
    this.addSql(`create index "connect_case_reparenting_items_from_idx" on "connect_case_reparenting_items" ("tenant_id", "organization_id", "from_case_id");`);
    this.addSql(`create index "connect_case_reparenting_items_to_idx" on "connect_case_reparenting_items" ("tenant_id", "organization_id", "to_case_id");`);
    this.addSql(`create index "connect_case_reparenting_items_keyset_idx" on "connect_case_reparenting_items" ("reparenting_id", "conversation_id");`);
  }

  /**
   * Reversible only while no correction has been recorded.
   *
   * The audit tables are dropped because a rollback of THIS migration means the
   * feature never shipped; an operator rolling back after real use must export
   * the evidence first. The Case columns are dropped for the same reason —
   * `merged_into_case_id` is the only thing distinguishing a merged source from
   * an ordinary closed Case, and leaving it behind without the code that reads
   * it would be worse than removing it.
   */
  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "connect_case_reparenting_items" cascade;`);
    this.addSql(`drop table if exists "connect_case_reparentings" cascade;`);
    this.addSql(`drop table if exists "connect_case_number_sequences" cascade;`);
    this.addSql(`drop index if exists "connect_conversation_case_bindings_active_uq";`);
    this.addSql(`drop index if exists "connect_cases_root_created_idx";`);
    this.addSql(`drop index if exists "connect_cases_split_from_idx";`);
    this.addSql(`drop index if exists "connect_cases_merged_into_idx";`);
    this.addSql(`alter table "connect_cases" drop column if exists "lineage_version";`);
    this.addSql(`alter table "connect_cases" drop column if exists "split_from_case_id";`);
    this.addSql(`alter table "connect_cases" drop column if exists "merged_into_case_id";`);
  }

}

import { Migration } from '@mikro-orm/migrations';

/**
 * Mercato Connect — operational metrics baseline.
 *
 * Two tables with opposite lifecycles, on purpose: facts are append-only and
 * uniquely keyed by their publishing event, and aggregates are a derived,
 * rebuildable projection of them. Everything a number on the metrics screen
 * claims can therefore be traced back to an event, and a wrong number is fixed
 * by recomputing rather than by patching a counter nobody can audit.
 *
 * The two Case columns exist because the alternative — deriving them at read
 * time — lets a later reassignment or reopen silently rewrite a timing that
 * was already reported.
 */
export class Migration20260823050000_connect extends Migration {

  override up(): void | Promise<void> {
    // Stamped once each, never overwritten. A transfer three hours in must not
    // reset "time to pick up" to zero, and a retry must not reset "time to
    // first reply".
    this.addSql(`alter table "connect_cases" add column "first_assigned_at" timestamptz null;`);
    this.addSql(`alter table "connect_cases" add column "first_outbound_sent_at" timestamptz null;`);

    this.addSql(`create table "connect_operational_facts" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "fact_type" text not null, "source_key" text not null, "cohort_utc_date" varchar(10) not null, "case_id" uuid null, "conversation_id" uuid null, "attempt_id" uuid null, "projection_key" text null, "channel_id" uuid null, "sender_hash" text null, "disposition" text null, "value" double precision null, "applied_window_minutes" int null, "applied_count_limit" int null, "occurred_at" timestamptz not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_operational_facts" add constraint "connect_operational_facts_type_chk" check ("fact_type" in ('inbound_claimed', 'inbound_opened', 'inbound_attached', 'inbound_suppressed', 'inbound_dead_lettered', 'outbound_attempted', 'outbound_sent', 'outbound_failed', 'outbound_unknown', 'case_assigned', 'case_resolved', 'case_reopened', 'first_response_seconds', 'elapsed_assigned_to_resolution_seconds', 'projection_lag_ms', 'projection_failed'));`);
    // The idempotency arbiter. Publication is at-least-once, so a redelivered
    // event must be rejected here rather than double-counted.
    this.addSql(`alter table "connect_operational_facts" add constraint "connect_operational_facts_source_uq" unique ("tenant_id", "organization_id", "source_key");`);
    this.addSql(`create index "connect_operational_facts_day_idx" on "connect_operational_facts" ("tenant_id", "organization_id", "cohort_utc_date", "fact_type");`);
    // Supports the per-sender suppression criterion without ever needing a raw
    // handle: the hash is a keyed blind index.
    this.addSql(`create index "connect_operational_facts_sender_idx" on "connect_operational_facts" ("tenant_id", "organization_id", "channel_id", "sender_hash");`);

    this.addSql(`create table "connect_metric_daily" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "utc_date" varchar(10) not null, "inbound_claimed" int not null default 0, "cases_opened" int not null default 0, "cases_attached" int not null default 0, "inbound_suppressed" int not null default 0, "inbound_dead_lettered" int not null default 0, "outbound_attempted" int not null default 0, "outbound_sent" int not null default 0, "outbound_failed" int not null default 0, "outbound_unknown" int not null default 0, "unknown_max_age_seconds" int null, "cases_assigned" int not null default 0, "cases_resolved" int not null default 0, "cases_reopened" int not null default 0, "first_response_p50_seconds" double precision null, "first_response_p90_seconds" double precision null, "first_response_sample_count" int not null default 0, "elapsed_resolution_p50_seconds" double precision null, "elapsed_resolution_p90_seconds" double precision null, "elapsed_resolution_sample_count" int not null default 0, "projection_lag_p50_ms" double precision null, "projection_lag_p90_ms" double precision null, "projection_lag_max_ms" double precision null, "projection_sample_count" int not null default 0, "projection_failed" int not null default 0, "observed_max_permitted_per_sender" int not null default 0, "applied_count_limit" int null, "stale" boolean not null default false, "generated_at" timestamptz not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_metric_daily" add constraint "connect_metric_daily_day_uq" unique ("tenant_id", "organization_id", "utc_date");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "connect_metric_daily" cascade;`);
    this.addSql(`drop table if exists "connect_operational_facts" cascade;`);
    this.addSql(`alter table "connect_cases" drop column if exists "first_outbound_sent_at";`);
    this.addSql(`alter table "connect_cases" drop column if exists "first_assigned_at";`);
  }

}

import { Migration } from '@mikro-orm/migrations'

export class Migration20260824013500_connect_sla extends Migration {
  override up(): void | Promise<void> {
    this.addSql(`create table "connect_sla_business_calendars" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "name" text not null, "is_default" boolean not null default false, "current_version" integer null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`)
    this.addSql(`create unique index "connect_sla_business_calendars_active_name_uq" on "connect_sla_business_calendars" ("tenant_id", "organization_id", lower("name")) where "deleted_at" is null;`)
    this.addSql(`create unique index "connect_sla_business_calendars_default_uq" on "connect_sla_business_calendars" ("tenant_id", "organization_id") where "is_default" = true and "deleted_at" is null;`)

    this.addSql(`create table "connect_sla_business_calendar_versions" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "calendar_id" uuid not null, "version" integer not null, "timezone" text not null, "published_by_user_id" uuid null, "published_at" timestamptz not null, "created_at" timestamptz not null, primary key ("id"));`)
    this.addSql(`create unique index "connect_sla_business_calendar_versions_uq" on "connect_sla_business_calendar_versions" ("tenant_id", "organization_id", "calendar_id", "version");`)

    this.addSql(`create table "connect_sla_business_windows" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "calendar_version_id" uuid not null, "weekday" smallint not null, "local_start" time(0) not null, "local_end" time(0) not null, "created_at" timestamptz not null, primary key ("id"), constraint "connect_sla_business_windows_weekday_chk" check ("weekday" between 0 and 6), constraint "connect_sla_business_windows_bounds_chk" check ("local_end" > "local_start"));`)
    this.addSql(`create index "connect_sla_business_windows_version_idx" on "connect_sla_business_windows" ("tenant_id", "organization_id", "calendar_version_id", "weekday", "local_start");`)

    this.addSql(`create table "connect_sla_business_holidays" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "calendar_version_id" uuid not null, "local_date" date not null, "label" text null, "created_at" timestamptz not null, primary key ("id"));`)
    this.addSql(`create unique index "connect_sla_business_holidays_uq" on "connect_sla_business_holidays" ("tenant_id", "organization_id", "calendar_version_id", "local_date");`)

    this.addSql(`create table "connect_sla_policies" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "name" text not null, "priority" integer not null, "is_active" boolean not null default true, "current_version" integer null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`)
    this.addSql(`create unique index "connect_sla_policies_active_name_uq" on "connect_sla_policies" ("tenant_id", "organization_id", lower("name")) where "deleted_at" is null;`)
    this.addSql(`create index "connect_sla_policies_match_idx" on "connect_sla_policies" ("tenant_id", "organization_id", "is_active", "priority");`)

    this.addSql(`create table "connect_sla_policy_versions" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "policy_id" uuid not null, "version" integer not null, "channel_id" uuid null, "response_target_minutes" integer not null, "resolution_target_minutes" integer not null, "response_warning_minutes" integer not null, "resolution_warning_minutes" integer not null, "calendar_version_id" uuid not null, "effective_from" timestamptz not null, "published_by_user_id" uuid null, "published_at" timestamptz not null, "created_at" timestamptz not null, primary key ("id"), constraint "connect_sla_policy_versions_targets_chk" check ("response_target_minutes" > 0 and "resolution_target_minutes" > 0), constraint "connect_sla_policy_versions_warnings_chk" check ("response_warning_minutes" >= 0 and "response_warning_minutes" < "response_target_minutes" and "resolution_warning_minutes" >= 0 and "resolution_warning_minutes" < "resolution_target_minutes"));`)
    this.addSql(`create unique index "connect_sla_policy_versions_uq" on "connect_sla_policy_versions" ("tenant_id", "organization_id", "policy_id", "version");`)
    this.addSql(`create index "connect_sla_policy_versions_effective_idx" on "connect_sla_policy_versions" ("tenant_id", "organization_id", "channel_id", "effective_from");`)

    this.addSql(`create table "connect_sla_case_clocks" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "case_id" uuid not null, "generation" integer not null, "source_event_id" text not null, "policy_version_id" uuid not null, "calendar_version_id" uuid not null, "started_at" timestamptz not null, "response_due_at" timestamptz not null, "resolution_due_at" timestamptz not null, "response_state" text not null, "resolution_state" text not null, "responded_at" timestamptz null, "resolved_at" timestamptz null, "resolution_paused_seconds" integer not null default 0, "wait_started_at" timestamptz null, "parent_clock_id" uuid null, "superseded_by_clock_id" uuid null, "next_due_at" timestamptz null, "internal_version" integer not null default 1, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"), constraint "connect_sla_case_clocks_response_state_chk" check ("response_state" in ('open', 'met', 'breached', 'unknown')), constraint "connect_sla_case_clocks_resolution_state_chk" check ("resolution_state" in ('open', 'met', 'breached', 'merged', 'superseded')), constraint "connect_sla_case_clocks_pause_chk" check ("resolution_paused_seconds" >= 0));`)
    this.addSql(`create unique index "connect_sla_case_clocks_case_generation_uq" on "connect_sla_case_clocks" ("tenant_id", "organization_id", "case_id", "generation");`)
    this.addSql(`create index "connect_sla_case_clocks_due_idx" on "connect_sla_case_clocks" ("tenant_id", "organization_id", "next_due_at", "id");`)

    this.addSql(`create table "connect_sla_event_receipts" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "source_event_id" text not null, "consumer_version" integer not null, "created_at" timestamptz not null, primary key ("id"));`)
    this.addSql(`create unique index "connect_sla_event_receipts_uq" on "connect_sla_event_receipts" ("tenant_id", "organization_id", "source_event_id", "consumer_version");`)

    this.addSql(`create table "connect_sla_event_outbox" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "source_event_id" text not null, "event_type" text not null, "payload" jsonb not null, "status" text not null default 'pending', "lease_expires_at" timestamptz null, "published_at" timestamptz null, "attempts" integer not null default 0, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"), constraint "connect_sla_event_outbox_status_chk" check ("status" in ('pending', 'published')));`)
    this.addSql(`create unique index "connect_sla_event_outbox_source_uq" on "connect_sla_event_outbox" ("tenant_id", "organization_id", "source_event_id", "event_type");`)
    this.addSql(`create index "connect_sla_event_outbox_pending_idx" on "connect_sla_event_outbox" ("status", "lease_expires_at", "created_at");`)

    this.addSql(`create table "connect_sla_rebuild_runs" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "command_key" text not null, "reason" text not null, "watermark" text null, "generation_cursor" text null, "wait_cursor" text null, "delivery_cursor" text null, "lease_owner" text null, "lease_expires_at" timestamptz null, "status" text not null, "processed_count" integer not null default 0, "error_count" integer not null default 0, "progress_job_id" uuid null, "internal_version" integer not null default 1, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"), constraint "connect_sla_rebuild_runs_status_chk" check ("status" in ('pending', 'running', 'completed', 'failed', 'cancelled')));`)
    this.addSql(`create unique index "connect_sla_rebuild_runs_command_uq" on "connect_sla_rebuild_runs" ("tenant_id", "organization_id", "command_key");`)

    this.addSql(`create table "connect_sla_clock_revisions" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "clock_id" uuid not null, "internal_version" integer not null, "reason" text not null, "before_state" jsonb not null, "after_state" jsonb not null, "created_at" timestamptz not null, primary key ("id"));`)
    this.addSql(`create index "connect_sla_clock_revisions_clock_idx" on "connect_sla_clock_revisions" ("tenant_id", "organization_id", "clock_id", "internal_version");`)
    this.addSql(`alter table "connect_sla_business_calendar_versions" add constraint "connect_sla_business_calendar_versions_calendar_id_foreign" foreign key ("calendar_id") references "connect_sla_business_calendars" ("id") on delete restrict;`)
    this.addSql(`alter table "connect_sla_business_windows" add constraint "connect_sla_business_windows_calendar_version_id_foreign" foreign key ("calendar_version_id") references "connect_sla_business_calendar_versions" ("id") on delete cascade;`)
    this.addSql(`alter table "connect_sla_business_holidays" add constraint "connect_sla_business_holidays_calendar_version_id_foreign" foreign key ("calendar_version_id") references "connect_sla_business_calendar_versions" ("id") on delete cascade;`)
    this.addSql(`alter table "connect_sla_policy_versions" add constraint "connect_sla_policy_versions_policy_id_foreign" foreign key ("policy_id") references "connect_sla_policies" ("id") on delete restrict;`)
    this.addSql(`alter table "connect_sla_policy_versions" add constraint "connect_sla_policy_versions_calendar_version_id_foreign" foreign key ("calendar_version_id") references "connect_sla_business_calendar_versions" ("id") on delete restrict;`)
    this.addSql(`alter table "connect_sla_case_clocks" add constraint "connect_sla_case_clocks_policy_version_id_foreign" foreign key ("policy_version_id") references "connect_sla_policy_versions" ("id") on delete restrict;`)
    this.addSql(`alter table "connect_sla_case_clocks" add constraint "connect_sla_case_clocks_calendar_version_id_foreign" foreign key ("calendar_version_id") references "connect_sla_business_calendar_versions" ("id") on delete restrict;`)
    this.addSql(`alter table "connect_sla_case_clocks" add constraint "connect_sla_case_clocks_parent_clock_id_foreign" foreign key ("parent_clock_id") references "connect_sla_case_clocks" ("id") on delete restrict;`)
    this.addSql(`alter table "connect_sla_case_clocks" add constraint "connect_sla_case_clocks_superseded_by_clock_id_foreign" foreign key ("superseded_by_clock_id") references "connect_sla_case_clocks" ("id") on delete restrict;`)
    this.addSql(`alter table "connect_sla_clock_revisions" add constraint "connect_sla_clock_revisions_clock_id_foreign" foreign key ("clock_id") references "connect_sla_case_clocks" ("id") on delete cascade;`)
  }

  override down(): void | Promise<void> {
    this.addSql('drop table if exists "connect_sla_clock_revisions" cascade;')
    this.addSql('drop table if exists "connect_sla_rebuild_runs" cascade;')
    this.addSql('drop table if exists "connect_sla_event_outbox" cascade;')
    this.addSql('drop table if exists "connect_sla_event_receipts" cascade;')
    this.addSql('drop table if exists "connect_sla_case_clocks" cascade;')
    this.addSql('drop table if exists "connect_sla_policy_versions" cascade;')
    this.addSql('drop table if exists "connect_sla_policies" cascade;')
    this.addSql('drop table if exists "connect_sla_business_holidays" cascade;')
    this.addSql('drop table if exists "connect_sla_business_windows" cascade;')
    this.addSql('drop table if exists "connect_sla_business_calendar_versions" cascade;')
    this.addSql('drop table if exists "connect_sla_business_calendars" cascade;')
  }
}

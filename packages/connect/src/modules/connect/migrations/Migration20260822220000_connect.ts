import { Migration } from '@mikro-orm/migrations';

/**
 * Mercato Connect — foundation schema.
 *
 * Every table is organization-scoped: `organization_id` is NOT NULL throughout,
 * because the vertical spike proved a nullable-organization Case cannot be
 * safely exposed by ordinary CRUD and weakens every candidate predicate.
 *
 * All tables are new; nothing outside `connect_*` is touched.
 */
export class Migration20260822220000_connect extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "connect_cases" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "number" int not null, "subject" text null, "display_label" text null, "status" text not null default 'new', "priority" text not null default 'normal', "assignee_user_id" uuid null, "customer_kind" text null, "customer_id" uuid null, "channel_id" uuid not null, "first_inbound_at" timestamptz null, "last_inbound_at" timestamptz null, "resolved_at" timestamptz null, "closed_at" timestamptz null, "wrap_up" text null, "previous_case_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`alter table "connect_cases" add constraint "connect_cases_status_chk" check ("status" in ('new', 'in_progress', 'waiting_customer', 'resolved', 'closed'));`);
    this.addSql(`alter table "connect_cases" add constraint "connect_cases_priority_chk" check ("priority" in ('low', 'normal', 'high', 'urgent'));`);
    this.addSql(`alter table "connect_cases" add constraint "connect_cases_number_uq" unique ("tenant_id", "organization_id", "number");`);
    this.addSql(`create index "connect_cases_candidate_idx" on "connect_cases" ("tenant_id", "organization_id", "customer_id", "status", "last_inbound_at");`);
    this.addSql(`create index "connect_cases_assignee_idx" on "connect_cases" ("tenant_id", "organization_id", "assignee_user_id", "status");`);

    this.addSql(`create table "connect_conversations" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "channel_id" uuid not null, "external_conversation_id" uuid not null, "current_case_id" uuid null, "last_external_message_id" uuid null, "last_message_at" timestamptz null, "reply_target_ref" text null, "reply_target_masked_label" text null, "reply_target_source_version" int null, "reply_target_message_id" uuid null, "reply_target_external_message_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_conversations" add constraint "connect_conversations_external_uq" unique ("tenant_id", "organization_id", "external_conversation_id");`);
    this.addSql(`create index "connect_conversations_case_idx" on "connect_conversations" ("tenant_id", "current_case_id");`);

    this.addSql(`create table "connect_conversation_case_bindings" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "conversation_id" uuid not null, "case_id" uuid not null, "bound_at" timestamptz not null, "unbound_at" timestamptz null, "reason" text null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "connect_conversation_case_bindings_conv_idx" on "connect_conversation_case_bindings" ("tenant_id", "conversation_id", "bound_at");`);
    this.addSql(`create index "connect_conversation_case_bindings_case_idx" on "connect_conversation_case_bindings" ("tenant_id", "case_id");`);

    this.addSql(`create table "connect_contact_identities" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "channel_id" uuid not null, "handle_type" text not null, "handle_value" text not null, "handle_hash" text not null, "handle_display_label" text null, "link_state" text not null default 'unresolved', "customer_kind" text null, "customer_id" uuid null, "confidence" int null, "match_method" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_contact_identities" add constraint "connect_contact_identities_link_state_chk" check ("link_state" in ('unresolved', 'linked', 'rejected'));`);
    this.addSql(`alter table "connect_contact_identities" add constraint "connect_contact_identities_hash_uq" unique ("tenant_id", "organization_id", "channel_id", "handle_hash");`);
    this.addSql(`create index "connect_contact_identities_customer_idx" on "connect_contact_identities" ("tenant_id", "organization_id", "customer_id");`);

    this.addSql(`create table "connect_identity_case_bindings" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "identity_id" uuid not null, "current_case_id" uuid null, "version" int not null default 0, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_identity_case_bindings" add constraint "connect_identity_case_bindings_identity_uq" unique ("tenant_id", "organization_id", "identity_id");`);

    this.addSql(`create table "connect_case_transitions" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "case_id" uuid not null, "actor_kind" text not null, "actor_user_id" uuid null, "from_status" text null, "to_status" text not null, "payload" jsonb null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "connect_case_transitions_case_idx" on "connect_case_transitions" ("tenant_id", "case_id", "created_at");`);

    this.addSql(`create table "connect_inbound_receipts" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "channel_id" uuid not null, "external_message_id" uuid not null, "source_event_id" text null, "claim_cohort_utc_date" date not null, "status" text not null default 'processing', "disposition" text null, "terminal_reason" text null, "case_id" uuid null, "lease_expires_at" timestamptz null, "attempts" int not null default 0, "last_attempt_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_inbound_receipts" add constraint "connect_inbound_receipts_status_chk" check ("status" in ('processing', 'completed'));`);
    this.addSql(`alter table "connect_inbound_receipts" add constraint "connect_inbound_receipts_disposition_chk" check ("disposition" is null or "disposition" in ('opened', 'attached', 'suppressed', 'dead_lettered'));`);
    this.addSql(`alter table "connect_inbound_receipts" add constraint "connect_inbound_receipts_shape_chk" check (("status" = 'processing' and "disposition" is null and "case_id" is null) or ("status" = 'completed' and "disposition" in ('opened', 'attached') and "case_id" is not null) or ("status" = 'completed' and "disposition" in ('suppressed', 'dead_lettered') and "case_id" is null));`);
    this.addSql(`alter table "connect_inbound_receipts" add constraint "connect_inbound_receipts_message_uq" unique ("tenant_id", "organization_id", "channel_id", "external_message_id");`);
    this.addSql(`create index "connect_inbound_receipts_sweep_idx" on "connect_inbound_receipts" ("tenant_id", "status", "lease_expires_at");`);

    this.addSql(`create table "connect_inbound_suppressions" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "channel_id" uuid not null, "from_handle_hash" text not null, "window_started_at" timestamptz not null, "hit_count" int not null default 0, "last_external_message_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_inbound_suppressions" add constraint "connect_inbound_suppressions_key_uq" unique ("tenant_id", "organization_id", "channel_id", "from_handle_hash", "window_started_at");`);
    this.addSql(`create index "connect_inbound_suppressions_window_idx" on "connect_inbound_suppressions" ("tenant_id", "window_started_at");`);

    this.addSql(`create table "connect_settings" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "attach_window_hours" int not null default 72, "reopen_window_days" int not null default 7, "auto_close_after_days" int not null default 14, "identity_match_threshold" int not null default 80, "suppression_count" int not null default 3, "suppression_window_minutes" int not null default 60, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_settings" add constraint "connect_settings_windows_chk" check ("reopen_window_days" <= "auto_close_after_days");`);
    this.addSql(`alter table "connect_settings" add constraint "connect_settings_scope_uq" unique ("tenant_id", "organization_id");`);

    this.addSql(`create table "connect_domain_outbox" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "source_event_id" text not null, "aggregate_id" uuid not null, "aggregate_version" int not null, "event_type" text not null, "payload" jsonb not null, "status" text not null default 'pending', "lease_expires_at" timestamptz null, "published_at" timestamptz null, "attempts" int not null default 0, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_domain_outbox" add constraint "connect_domain_outbox_status_chk" check ("status" in ('pending', 'published'));`);
    this.addSql(`alter table "connect_domain_outbox" add constraint "connect_domain_outbox_event_uq" unique ("tenant_id", "source_event_id");`);
    this.addSql(`create index "connect_domain_outbox_pending_idx" on "connect_domain_outbox" ("status", "lease_expires_at");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "connect_domain_outbox" cascade;`);
    this.addSql(`drop table if exists "connect_settings" cascade;`);
    this.addSql(`drop table if exists "connect_inbound_suppressions" cascade;`);
    this.addSql(`drop table if exists "connect_inbound_receipts" cascade;`);
    this.addSql(`drop table if exists "connect_case_transitions" cascade;`);
    this.addSql(`drop table if exists "connect_identity_case_bindings" cascade;`);
    this.addSql(`drop table if exists "connect_contact_identities" cascade;`);
    this.addSql(`drop table if exists "connect_conversation_case_bindings" cascade;`);
    this.addSql(`drop table if exists "connect_conversations" cascade;`);
    this.addSql(`drop table if exists "connect_cases" cascade;`);
  }

}

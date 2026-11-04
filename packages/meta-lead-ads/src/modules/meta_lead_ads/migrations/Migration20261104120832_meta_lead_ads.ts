import { Migration } from '@mikro-orm/migrations';

export class Migration20261104120832_meta_lead_ads extends Migration {

  override name = 'Migration20261104120832';

  override up(): void | Promise<void> {
    this.addSql(`create table "meta_lead_ads_connections" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "meta_user_id" text not null, "meta_user_name" text null, "user_access_token" text null, "token_expires_at" timestamptz null, "granted_scopes" jsonb not null default '[]', "status" text not null default 'active', "last_health_check_at" timestamptz null, "last_error" text null, "connected_by_user_id" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "meta_lead_ads_connections_status_idx" on "meta_lead_ads_connections" ("status");`);
    this.addSql(`create unique index "meta_lead_ads_connections_scope_user_uq" on "meta_lead_ads_connections" ("tenant_id","organization_id","meta_user_id") where deleted_at is null;`);
    this.addSql(`create index "meta_lead_ads_connections_tenant_org_idx" on "meta_lead_ads_connections" ("tenant_id", "organization_id");`);

    this.addSql(`create table "meta_lead_ads_consents" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "person_id" uuid not null, "lead_event_id" uuid not null, "consent_key" text not null, "consent_text" text not null, "given_at" timestamptz not null, "is_checked" boolean not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "meta_lead_ads_consents_person_idx" on "meta_lead_ads_consents" ("person_id");`);
    this.addSql(`create index "meta_lead_ads_consents_tenant_org_idx" on "meta_lead_ads_consents" ("tenant_id", "organization_id");`);
    this.addSql(`alter table "meta_lead_ads_consents" add constraint "meta_lead_ads_consents_lead_key_uq" unique ("lead_event_id", "consent_key");`);

    this.addSql(`create table "meta_lead_ads_deletion_requests" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid null, "organization_id" uuid null, "confirmation_code" text not null, "meta_user_id" text not null, "status" text not null default 'pending', "purged_count" int not null default 0, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "meta_lead_ads_deletion_requests_meta_user_idx" on "meta_lead_ads_deletion_requests" ("meta_user_id");`);
    this.addSql(`create index "meta_lead_ads_deletion_requests_scope_idx" on "meta_lead_ads_deletion_requests" ("tenant_id", "organization_id");`);
    this.addSql(`alter table "meta_lead_ads_deletion_requests" add constraint "meta_lead_ads_deletion_requests_code_uq" unique ("confirmation_code");`);

    this.addSql(`create table "meta_lead_ads_forms" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "page_id" uuid not null, "meta_form_id" text not null, "name" text not null, "locale" text null, "is_enabled" boolean not null default true, "questions" jsonb not null default '[]', "questions_fingerprint" text not null, "needs_attention" boolean not null default false, "attention_reason" text null, "field_mapping" jsonb not null default '[{"questionKey":"email","target":"person.primaryEmail"},{"questionKey":"phone_number","target":"person.primaryPhone"},{"questionKey":"full_name","target":"person.fullName"},{"questionKey":"first_name","target":"person.firstName"},{"questionKey":"last_name","target":"person.lastName"},{"questionKey":"company_name","target":"company.displayName"},{"questionKey":"job_title","target":"person.jobTitle"},{"questionKey":"city","target":"person.city"}]', "create_deal" boolean not null default false, "pipeline_id" uuid null, "pipeline_stage_id" uuid null, "owner_mode" text not null default 'none', "owner_user_id" uuid null, "owner_user_ids" jsonb not null default '[]', "round_robin_cursor" int not null default 0, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "meta_lead_ads_forms_page_idx" on "meta_lead_ads_forms" ("page_id");`);
    this.addSql(`create index "meta_lead_ads_forms_scope_enabled_idx" on "meta_lead_ads_forms" ("tenant_id", "organization_id", "is_enabled");`);
    this.addSql(`create unique index "meta_lead_ads_forms_page_form_uq" on "meta_lead_ads_forms" ("page_id","meta_form_id") where deleted_at is null;`);
    this.addSql(`create index "meta_lead_ads_forms_tenant_org_idx" on "meta_lead_ads_forms" ("tenant_id", "organization_id");`);

    this.addSql(`create table "meta_lead_ads_lead_events" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid null, "organization_id" uuid null, "meta_lead_id" text not null, "meta_page_id" text not null, "page_id" uuid null, "form_id" uuid null, "meta_form_id" text not null, "ad_id" text null, "adset_id" text null, "campaign_id" text null, "ad_name" text null, "adset_name" text null, "campaign_name" text null, "platform" text null, "is_organic" boolean null, "submitted_at" timestamptz null, "source" text not null, "raw_notification" jsonb null, "raw_payload" jsonb null, "payload_purged_at" timestamptz null, "status" text not null default 'received', "attempt_count" int not null default 0, "manual_retry_count" int not null default 0, "next_attempt_at" timestamptz null, "last_error_code" text null, "last_error" text null, "person_id" uuid null, "company_id" uuid null, "interaction_id" uuid null, "deal_id" uuid null, "match_type" text null, "email_hash" text null, "phone_hash" text null, "meta_user_id" text null, "processed_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "meta_lead_ads_lead_events_meta_user_idx" on "meta_lead_ads_lead_events" ("meta_user_id") where "meta_user_id" is not null;`);
    this.addSql(`create index "meta_lead_ads_lead_events_status_next_attempt_idx" on "meta_lead_ads_lead_events" ("status", "next_attempt_at");`);
    this.addSql(`create index "meta_lead_ads_lead_events_form_submitted_idx" on "meta_lead_ads_lead_events" ("form_id", "submitted_at");`);
    this.addSql(`create index "meta_lead_ads_lead_events_person_idx" on "meta_lead_ads_lead_events" ("person_id");`);
    this.addSql(`create index "meta_lead_ads_lead_events_org_status_created_idx" on "meta_lead_ads_lead_events" ("organization_id","status","created_at" desc);`);
    this.addSql(`create index "meta_lead_ads_lead_events_scope_idx" on "meta_lead_ads_lead_events" ("tenant_id", "organization_id");`);
    this.addSql(`alter table "meta_lead_ads_lead_events" add constraint "meta_lead_ads_lead_events_meta_lead_id_uq" unique ("meta_lead_id");`);
    this.addSql(`alter table "meta_lead_ads_lead_events" add constraint "meta_lead_ads_lead_events_scope_chk" check (("tenant_id" is not null and "organization_id" is not null) or "status" = 'unrouted');`);

    this.addSql(`create table "meta_lead_ads_pages" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "connection_id" uuid not null, "meta_page_id" text not null, "name" text not null, "page_access_token" text null, "subscription_status" text not null default 'unsubscribed', "status_checked_at" timestamptz null, "last_error" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "meta_lead_ads_pages_subscription_status_idx" on "meta_lead_ads_pages" ("subscription_status");`);
    this.addSql(`create index "meta_lead_ads_pages_connection_idx" on "meta_lead_ads_pages" ("connection_id");`);
    this.addSql(`create unique index "meta_lead_ads_pages_meta_page_id_uq" on "meta_lead_ads_pages" ("meta_page_id") where deleted_at is null;`);
    this.addSql(`create index "meta_lead_ads_pages_tenant_org_idx" on "meta_lead_ads_pages" ("tenant_id", "organization_id");`);

    this.addSql(`create table "meta_lead_ads_person_keys" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "person_id" uuid not null, "email_hash" text null, "phone_hash" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create unique index "meta_lead_ads_person_keys_org_person_uq" on "meta_lead_ads_person_keys" ("organization_id","person_id") where deleted_at is null;`);
    this.addSql(`create index "meta_lead_ads_person_keys_org_phone_idx" on "meta_lead_ads_person_keys" ("organization_id","phone_hash");`);
    this.addSql(`create index "meta_lead_ads_person_keys_org_email_idx" on "meta_lead_ads_person_keys" ("organization_id","email_hash");`);
    this.addSql(`create index "meta_lead_ads_person_keys_tenant_org_idx" on "meta_lead_ads_person_keys" ("tenant_id", "organization_id");`);

    this.addSql(`create table "meta_lead_ads_settings" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "retention_days" int not null default 30, "default_country" text not null default 'PL', "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`alter table "meta_lead_ads_settings" add constraint "meta_lead_ads_settings_scope_uq" unique ("tenant_id", "organization_id");`);
    this.addSql(`alter table "meta_lead_ads_settings" add constraint "meta_lead_ads_settings_retention_days_chk" check ("retention_days" between 1 and 365);`);

    this.addSql(`create table "meta_lead_ads_sync_runs" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "kind" text not null, "form_id" uuid null, "range_from" timestamptz not null, "range_to" timestamptz not null, "status" text not null default 'running', "checked" int not null default 0, "imported" int not null default 0, "duplicates" int not null default 0, "failed" int not null default 0, "progress_job_id" uuid null, "error" text null, "started_at" timestamptz not null, "finished_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "meta_lead_ads_sync_runs_status_idx" on "meta_lead_ads_sync_runs" ("status");`);
    this.addSql(`create index "meta_lead_ads_sync_runs_org_started_idx" on "meta_lead_ads_sync_runs" ("organization_id","started_at" desc);`);
    this.addSql(`create index "meta_lead_ads_sync_runs_tenant_org_idx" on "meta_lead_ads_sync_runs" ("tenant_id", "organization_id");`);
  }

}

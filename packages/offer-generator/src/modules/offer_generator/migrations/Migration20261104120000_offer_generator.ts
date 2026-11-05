import { Migration } from '@mikro-orm/migrations';

export class Migration20261104120000_offer_generator extends Migration {

  override name = 'Migration20261104120000';

  override up(): void | Promise<void> {
    this.addSql(`create table "offer_generator_generation_runs" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "offer_id" uuid not null, "kind" text not null, "input_text" text not null, "language" text not null, "status" text not null default 'queued', "progress_job_id" uuid null, "provider_id" text null, "model_id" text null, "bytes_received" int not null default 0, "chunks" int not null default 0, "error_code" text null, "result_revision_id" uuid null, "started_at" timestamptz null, "finished_at" timestamptz null, "created_by_user_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "offer_generator_generation_runs_offer_status_idx" on "offer_generator_generation_runs" ("offer_id", "status");`);
    this.addSql(`create index "offer_generator_generation_runs_scope_offer_created_idx" on "offer_generator_generation_runs" ("tenant_id","organization_id","offer_id","created_at" desc);`);

    this.addSql(`create table "offer_generator_offer_revisions" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "offer_id" uuid not null, "html" text not null, "source" text not null, "feedback" text null, "generation_run_id" uuid null, "created_by_user_id" uuid null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "offer_generator_offer_revisions_offer_created_idx" on "offer_generator_offer_revisions" ("offer_id","created_at" desc);`);

    this.addSql(`create table "offer_generator_offer_views" ("id" uuid not null default gen_random_uuid(), "view_key" uuid not null, "tenant_id" uuid not null, "organization_id" uuid not null, "offer_id" uuid not null, "visitor_id" uuid not null, "ip_hash" varchar(64) null, "country" varchar(2) null, "device" varchar(16) not null, "browser" varchar(32) not null, "os" varchar(32) not null, "referrer" varchar(300) null, "is_internal" boolean not null default false, "started_at" timestamptz not null, "last_seen_at" timestamptz not null, "active_ms" int not null default 0, "max_scroll_pct" int not null default 0, "beats" int not null default 0, "sections" jsonb not null default '{}', "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "offer_generator_offer_views_offer_ip_started_idx" on "offer_generator_offer_views" ("offer_id", "ip_hash", "started_at");`);
    this.addSql(`create index "offer_generator_offer_views_offer_started_idx" on "offer_generator_offer_views" ("offer_id","started_at" desc);`);
    this.addSql(`alter table "offer_generator_offer_views" add constraint "offer_generator_offer_views_view_key_uq" unique ("view_key");`);

    this.addSql(`create table "offer_generator_offers" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "owner_user_id" uuid null, "title" text not null, "client_name" text not null, "language" text not null, "status" text not null default 'draft', "customer_entity_id" uuid null, "customer_kind" text null, "deal_id" uuid null, "slug" text not null, "access_token" varchar(12) not null, "prompt" text null, "notes" text null, "html" text null, "html_updated_at" timestamptz null, "value_amount" numeric(14,2) null, "currency_code" text null, "valid_until" date null, "sent_at" timestamptz null, "viewed_at" timestamptz null, "responded_at" timestamptz null, "view_count" int not null default 0, "last_viewed_at" timestamptz null, "generation_status" text not null default 'idle', "last_generation_run_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "offer_generator_offers_scope_status_idx" on "offer_generator_offers" ("tenant_id", "organization_id", "status");`);
    this.addSql(`create index "offer_generator_offers_scope_deal_idx" on "offer_generator_offers" ("tenant_id", "organization_id", "deal_id");`);
    this.addSql(`create index "offer_generator_offers_scope_customer_idx" on "offer_generator_offers" ("tenant_id", "organization_id", "customer_entity_id");`);
    this.addSql(`create index "offer_generator_offers_scope_created_idx" on "offer_generator_offers" ("tenant_id", "organization_id", "created_at");`);
    this.addSql(`alter table "offer_generator_offers" add constraint "offer_generator_offers_slug_uq" unique ("slug");`);

    this.addSql(`create table "offer_generator_settings" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "company_name" text not null default '', "template_html" text not null, "extra_instructions" text null, "default_language" text not null default 'pl', "default_currency" text not null default 'PLN', "default_model" text null, "alternate_models" jsonb not null default '[]', "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "offer_generator_settings" add constraint "offer_generator_settings_scope_uq" unique ("tenant_id", "organization_id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "offer_generator_generation_runs" cascade;`);
    this.addSql(`drop table if exists "offer_generator_offer_revisions" cascade;`);
    this.addSql(`drop table if exists "offer_generator_offer_views" cascade;`);
    this.addSql(`drop table if exists "offer_generator_offers" cascade;`);
    this.addSql(`drop table if exists "offer_generator_settings" cascade;`);
  }

}

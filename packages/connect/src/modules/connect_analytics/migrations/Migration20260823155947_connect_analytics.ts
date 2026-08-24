import { Migration } from '@mikro-orm/migrations';

/**
 * Connect cost accounting inputs.
 *
 * Additive only: two new tables, their indexes and their check constraints.
 * Nothing outside `connect_analytics` is touched — in particular the
 * `currencies` schema is read through a service, never joined to, so no
 * foreign key crosses the module boundary here.
 *
 * `down()` drops exactly those two tables. Rolling the *code* back is the
 * intended recovery path (it removes the routes, pages and reader while the
 * already-recorded rows survive); running `down()` discards recorded financial
 * data, so it exists for a failed forward migration, not for a rollback.
 */
export class Migration20260823155947_connect_analytics extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "connect_cost_inputs" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "period_start" timestamptz not null, "period_end" timestamptz not null, "cost_type" text not null, "user_id" uuid null, "channel_id" uuid null, "amount_minor" bigint not null, "currency_code" char(3) not null, "source" text not null, "provider_invoice_ref" text null, "provider_line_ref" text null, "description" text null, "created_by_user_id" uuid null, "updated_by_user_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "connect_cost_inputs_channel_idx" on "connect_cost_inputs" ("tenant_id", "organization_id", "channel_id");`);
    this.addSql(`create index "connect_cost_inputs_user_idx" on "connect_cost_inputs" ("tenant_id", "organization_id", "user_id");`);
    this.addSql(`create index "connect_cost_inputs_currency_type_idx" on "connect_cost_inputs" ("tenant_id", "organization_id", "currency_code", "cost_type", "period_start");`);
    this.addSql(`create index "connect_cost_inputs_period_idx" on "connect_cost_inputs" ("tenant_id", "organization_id", "period_start", "period_end");`);
    this.addSql(`create index "connect_cost_inputs_allocation_idx" on "connect_cost_inputs" ("tenant_id", "organization_id", "currency_code", "period_start", "period_end") where "deleted_at" is null;`);
    this.addSql(`create unique index "connect_cost_inputs_provider_line_uq" on "connect_cost_inputs" ("tenant_id", "organization_id", "provider_invoice_ref", "provider_line_ref") where "source" = 'provider_invoice' and "deleted_at" is null;`);
    this.addSql(`alter table "connect_cost_inputs" add constraint "connect_cost_inputs_provenance_chk" check ((
    ("source" = 'manual' and "provider_invoice_ref" is null and "provider_line_ref" is null)
    or ("source" = 'provider_invoice' and "provider_invoice_ref" is not null and "provider_line_ref" is not null)
  ));`);
    this.addSql(`alter table "connect_cost_inputs" add constraint "connect_cost_inputs_dimension_chk" check ((
    ("cost_type" = 'agent' and "user_id" is not null and "channel_id" is null)
    or ("cost_type" = 'channel' and "channel_id" is not null and "user_id" is null)
    or ("cost_type" = 'ai' and "user_id" is null and "channel_id" is null)
  ));`);
    this.addSql(`alter table "connect_cost_inputs" add constraint "connect_cost_inputs_currency_chk" check ("currency_code" ~ '^[A-Z]{3}\$');`);
    this.addSql(`alter table "connect_cost_inputs" add constraint "connect_cost_inputs_amount_chk" check ("amount_minor" >= 0);`);
    this.addSql(`alter table "connect_cost_inputs" add constraint "connect_cost_inputs_source_chk" check ("source" in ('manual', 'provider_invoice'));`);
    this.addSql(`alter table "connect_cost_inputs" add constraint "connect_cost_inputs_type_chk" check ("cost_type" in ('agent', 'channel', 'ai'));`);
    this.addSql(`alter table "connect_cost_inputs" add constraint "connect_cost_inputs_period_chk" check ("period_end" > "period_start");`);

    this.addSql(`create table "connect_cost_input_revision_secrets" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "cost_input_id" uuid not null, "operation" text not null, "description_before" text null, "description_after" text null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "connect_cost_input_revision_secrets_scope_idx" on "connect_cost_input_revision_secrets" ("tenant_id", "organization_id", "cost_input_id");`);
    this.addSql(`alter table "connect_cost_input_revision_secrets" add constraint "connect_cost_input_revision_secrets_operation_chk" check ("operation" in ('create', 'update', 'delete'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "connect_cost_input_revision_secrets" cascade;`);
    this.addSql(`drop table if exists "connect_cost_inputs" cascade;`);
  }

}

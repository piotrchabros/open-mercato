import { Migration } from '@mikro-orm/migrations';

export class Migration20260822235625_connect extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "connect_principal_classification_changes" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "operation_id" uuid not null, "source" varchar(100) not null, "request_fingerprint" varchar(64) not null, "classification_id" uuid not null, "user_id" uuid not null, "before_kind" text null, "after_kind" text null, "created_classification" boolean not null, "changed_classification" boolean not null, "tombstoned_classification" boolean not null, "result_updated_at" timestamptz null, "outcome" text not null, "reason_code" varchar(100) not null, "reference_id" varchar(160) null, "inverse_of_id" uuid null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "connect_principal_classification_changes_user_idx" on "connect_principal_classification_changes" ("tenant_id", "organization_id", "user_id", "created_at");`);
    this.addSql(`alter table "connect_principal_classification_changes" add constraint "connect_principal_classification_changes_operation_uq" unique ("tenant_id", "organization_id", "source", "operation_id");`);

    this.addSql(`create table "connect_principal_classification_manifest_entries" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "external_key" varchar(100) not null, "user_id" uuid not null, "kind" text not null, "reason_code" varchar(100) not null, "reference_id" varchar(160) null, "operation_id" uuid not null, "revision" int not null default 1, "active" boolean not null default true, "last_reconciled_at" timestamptz null, "last_result_code" varchar(100) null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_principal_classification_manifest_entries" add constraint "connect_principal_manifest_scope_user_uq" unique ("tenant_id", "organization_id", "user_id");`);
    this.addSql(`alter table "connect_principal_classification_manifest_entries" add constraint "connect_principal_manifest_scope_external_key_uq" unique ("tenant_id", "organization_id", "external_key");`);

    this.addSql(`alter table "connect_principal_classification_changes" add constraint "connect_principal_classification_changes_outcome_chk" check ("outcome" in ('completed', 'undone'));`);
    this.addSql(`alter table "connect_principal_classification_changes" add constraint "connect_principal_classification_changes_kind_chk" check (("tombstoned_classification" = true and "before_kind" is not null and "after_kind" is null and "result_updated_at" is null) or ("tombstoned_classification" = false and "after_kind" is not null and "result_updated_at" is not null));`);

    this.addSql(`alter table "connect_principal_classification_manifest_entries" add constraint "connect_principal_manifest_kind_chk" check ("kind" in ('human', 'system_bot', 'integration'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "connect_principal_classification_manifest_entries" cascade;`);
    this.addSql(`drop table if exists "connect_principal_classification_changes" cascade;`);
  }

}

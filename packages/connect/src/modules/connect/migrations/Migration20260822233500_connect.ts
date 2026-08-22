import { Migration } from '@mikro-orm/migrations';

export class Migration20260822233500_connect extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "connect_principal_classifications" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "user_id" uuid not null, "kind" text not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "connect_principal_classifications_scope_user_idx" on "connect_principal_classifications" ("tenant_id", "organization_id", "user_id");`);
    this.addSql(`alter table "connect_principal_classifications" add constraint "connect_principal_classifications_scope_user_uq" unique ("tenant_id", "organization_id", "user_id");`);

    this.addSql(`alter table "connect_principal_classifications" add constraint "connect_principal_classifications_kind_chk" check ("kind" in ('human', 'system_bot', 'integration'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "connect_principal_classifications" cascade;`);
  }

}

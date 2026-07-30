import { Migration } from '@mikro-orm/migrations';

export class Migration20260730122616_customer_accounts extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "domain_mappings" add "target" text not null default 'portal';`);
    this.addSql(`create unique index "domain_mappings_backend_active_org_unique" on "domain_mappings" ("organization_id") where "target" = 'backend' and "status" = 'active';`);
    this.addSql(`alter table "domain_mappings" add constraint "domain_mappings_target_check" check ("target" in ('portal', 'backend'));`);
  }

  override down(): void | Promise<void> {
    // Created via CREATE UNIQUE INDEX, so it is an index and not a table
    // constraint; DROP CONSTRAINT would not remove it.
    this.addSql(`drop index if exists "domain_mappings_backend_active_org_unique";`);
    this.addSql(`alter table "domain_mappings" drop constraint if exists "domain_mappings_target_check";`);
    this.addSql(`alter table "domain_mappings" drop column "target";`);
  }

}

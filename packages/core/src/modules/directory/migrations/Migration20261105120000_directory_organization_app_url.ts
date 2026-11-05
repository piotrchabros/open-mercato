import { Migration } from '@mikro-orm/migrations';

export class Migration20261105120000DirectoryOrganizationAppUrl extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "organizations" add column "app_url" text null;`);
    this.addSql(`create unique index if not exists "organizations_app_url_uniq" on "organizations" ("app_url") where "deleted_at" is null and "app_url" is not null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index if exists "organizations_app_url_uniq";`);
    this.addSql(`alter table "organizations" drop column "app_url";`);
  }

}

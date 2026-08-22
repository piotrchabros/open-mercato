import { Migration } from '@mikro-orm/migrations';

/**
 * Connect upstream Contract D — event-time projection snapshot on inbound links.
 *
 * Additive and nullable. Existing rows keep NULL, which the envelope reader
 * reads as `legacy_customers` — exactly what those channels were when the
 * messages arrived.
 */
export class Migration20260822180000_communication_channels extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "message_channel_links" add column "projection_mode_at_ingest" text null;`);
    this.addSql(`alter table "message_channel_links" add column "traffic_enabled_at_ingest" boolean null;`);
    this.addSql(`alter table "message_channel_links" add constraint "message_channel_links_projection_mode_chk" check ("projection_mode_at_ingest" is null or "projection_mode_at_ingest" in ('legacy_customers', 'connect_managed'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "message_channel_links" drop constraint if exists "message_channel_links_projection_mode_chk";`);
    this.addSql(`alter table "message_channel_links" drop column "traffic_enabled_at_ingest";`);
    this.addSql(`alter table "message_channel_links" drop column "projection_mode_at_ingest";`);
  }

}

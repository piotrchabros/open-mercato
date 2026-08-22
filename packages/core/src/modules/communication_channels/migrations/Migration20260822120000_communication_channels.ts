import { Migration } from '@mikro-orm/migrations';

/**
 * Connect upstream Contract E — shared-channel authorization foundation.
 *
 * Adds organization ownership metadata + immutable projection mode to
 * `communication_channels`, and the explicit shared-inbox membership table.
 *
 * The classification UPDATEs deliberately do NOT assign any existing channel to
 * an organization. Pre-existing tenant-wide rows (`user_id IS NULL AND
 * organization_id IS NULL`) are only labelled so the admin UI can tell genuine
 * push infrastructure apart from an email channel that must be reprovisioned
 * before it can become a Connect-managed team inbox.
 */
export class Migration20260822120000_communication_channels extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "communication_channels" add column "is_shared_inbox" boolean not null default false;`);
    this.addSql(`alter table "communication_channels" add column "projection_mode" text not null default 'legacy_customers';`);
    this.addSql(`alter table "communication_channels" add column "ownership_frozen_at" timestamptz null;`);
    this.addSql(`alter table "communication_channels" add column "traffic_enabled_at" timestamptz null;`);
    this.addSql(`alter table "communication_channels" add column "connect_capability_snapshot" jsonb null;`);
    this.addSql(`alter table "communication_channels" add column "legacy_shared_classification" text null;`);

    this.addSql(`alter table "communication_channels" add constraint "communication_channels_shared_inbox_scope_chk" check (not "is_shared_inbox" or ("organization_id" is not null and "user_id" is null));`);
    this.addSql(`alter table "communication_channels" add constraint "communication_channels_projection_mode_chk" check ("projection_mode" in ('legacy_customers', 'connect_managed'));`);
    this.addSql(`alter table "communication_channels" add constraint "communication_channels_connect_managed_shared_chk" check ("projection_mode" = 'legacy_customers' or "is_shared_inbox");`);
    this.addSql(`alter table "communication_channels" add constraint "communication_channels_legacy_classification_chk" check ("legacy_shared_classification" is null or "legacy_shared_classification" in ('tenant_push_infrastructure', 'email_requires_reprovision'));`);

    this.addSql(`create index "communication_channels_shared_inbox_idx" on "communication_channels" ("tenant_id", "organization_id") where "is_shared_inbox" and "deleted_at" is null;`);
    this.addSql(`create unique index "communication_channels_shared_mailbox_uq" on "communication_channels" ("tenant_id", "organization_id", "provider_key", "external_identifier") where "is_shared_inbox" and "deleted_at" is null and "external_identifier" is not null;`);

    // Classify — never assign — pre-existing tenant-wide channels.
    this.addSql(`update "communication_channels" set "legacy_shared_classification" = 'tenant_push_infrastructure' where "user_id" is null and "organization_id" is null and "channel_type" = 'push';`);
    this.addSql(`update "communication_channels" set "legacy_shared_classification" = 'email_requires_reprovision' where "user_id" is null and "organization_id" is null and "channel_type" <> 'push';`);

    this.addSql(`create table "communication_channel_shared_members" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "channel_id" uuid not null, "user_id" uuid not null, "is_active" boolean not null default true, "granted_by_user_id" uuid null, "revoked_by_user_id" uuid null, "revoked_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "communication_channel_shared_members_user_idx" on "communication_channel_shared_members" ("tenant_id", "organization_id", "user_id", "is_active");`);
    this.addSql(`create index "communication_channel_shared_members_channel_user_idx" on "communication_channel_shared_members" ("channel_id", "user_id", "is_active");`);
    this.addSql(`alter table "communication_channel_shared_members" add constraint "communication_channel_shared_members_uq" unique ("tenant_id", "organization_id", "channel_id", "user_id");`);

    this.addSql(`create table "communication_channel_shared_oauth_states" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "state_hash" text not null, "nonce" text not null, "initiated_by_user_id" uuid not null, "provider_key" text not null, "display_name" text null, "return_url" text null, "expires_at" timestamptz not null, "consumed_at" timestamptz null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "communication_channel_shared_oauth_states_expiry_idx" on "communication_channel_shared_oauth_states" ("expires_at");`);
    this.addSql(`alter table "communication_channel_shared_oauth_states" add constraint "communication_channel_shared_oauth_states_hash_uq" unique ("state_hash");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "communication_channel_shared_oauth_states" cascade;`);
    this.addSql(`drop table if exists "communication_channel_shared_members" cascade;`);

    this.addSql(`drop index if exists "communication_channels_shared_mailbox_uq";`);
    this.addSql(`drop index if exists "communication_channels_shared_inbox_idx";`);
    this.addSql(`alter table "communication_channels" drop constraint if exists "communication_channels_legacy_classification_chk";`);
    this.addSql(`alter table "communication_channels" drop constraint if exists "communication_channels_connect_managed_shared_chk";`);
    this.addSql(`alter table "communication_channels" drop constraint if exists "communication_channels_projection_mode_chk";`);
    this.addSql(`alter table "communication_channels" drop constraint if exists "communication_channels_shared_inbox_scope_chk";`);

    this.addSql(`alter table "communication_channels" drop column "legacy_shared_classification";`);
    this.addSql(`alter table "communication_channels" drop column "connect_capability_snapshot";`);
    this.addSql(`alter table "communication_channels" drop column "traffic_enabled_at";`);
    this.addSql(`alter table "communication_channels" drop column "ownership_frozen_at";`);
    this.addSql(`alter table "communication_channels" drop column "projection_mode";`);
    this.addSql(`alter table "communication_channels" drop column "is_shared_inbox";`);
  }

}

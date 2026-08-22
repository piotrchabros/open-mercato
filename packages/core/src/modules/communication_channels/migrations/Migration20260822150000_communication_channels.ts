import { Migration } from '@mikro-orm/migrations';

/**
 * Connect upstream Contract A — shared-channel send correlation.
 *
 * Adds the durable correlation/idempotency + outcome record for outbound sends.
 * Purely additive: no existing table, column or behaviour changes, so callers
 * that do not supply a correlation keep their current semantics.
 */
export class Migration20260822150000_communication_channels extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "channel_delivery_attempts" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid null, "channel_id" uuid not null, "correlation_id" text not null, "attempt_id" text not null, "fingerprint" text not null, "status" text not null default 'pending', "delivery_revision" int not null default 0, "provider_message_id" text null, "reason_code" text null, "message_id" uuid null, "thread_id" uuid null, "actor_user_id" uuid null, "occurred_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "channel_delivery_attempts" add constraint "channel_delivery_attempts_status_chk" check ("status" in ('pending', 'sent', 'failed', 'unknown'));`);
    // Expression index rather than a plain unique constraint: personal channels
    // store `organization_id IS NULL`, and NULLs are never equal to each other,
    // so a plain constraint would not deduplicate those rows at all.
    this.addSql(`create unique index "channel_delivery_attempts_correlation_uq" on "channel_delivery_attempts" ("tenant_id", (coalesce("organization_id", '00000000-0000-0000-0000-000000000000'::uuid)), "channel_id", "correlation_id");`);
    this.addSql(`create index "channel_delivery_attempts_attempt_idx" on "channel_delivery_attempts" ("tenant_id", "channel_id", "attempt_id");`);
    this.addSql(`create index "channel_delivery_attempts_message_idx" on "channel_delivery_attempts" ("message_id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "channel_delivery_attempts" cascade;`);
  }

}

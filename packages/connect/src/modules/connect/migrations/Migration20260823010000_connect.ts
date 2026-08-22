import { Migration } from '@mikro-orm/migrations';

/**
 * Mercato Connect — Inbox Operations schema.
 *
 * Outbound is modelled as one LOGICAL message with N attempts rather than a
 * single row, because a retry must not duplicate the customer-visible reply.
 * The dispatch outbox is written in the same transaction as the message and its
 * first attempt, so a crash between "202 returned" and "job enqueued" is
 * recoverable.
 */
export class Migration20260823010000_connect extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`create table "connect_outbound_messages" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "case_id" uuid not null, "conversation_id" uuid not null, "client_command_key" text not null, "payload" text not null, "payload_fingerprint" text not null, "reply_target_ref" text not null, "masked_recipient_label" text null, "actor_user_id" uuid not null, "channel_id" uuid not null, "erased_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_outbound_messages" add constraint "connect_outbound_messages_command_uq" unique ("tenant_id", "organization_id", "case_id", "client_command_key");`);
    this.addSql(`create index "connect_outbound_messages_case_idx" on "connect_outbound_messages" ("tenant_id", "case_id", "created_at");`);

    this.addSql(`create table "connect_outbound_attempts" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "message_id" uuid not null, "case_id" uuid not null, "predecessor_attempt_id" uuid null, "attempt_number" int not null, "hub_correlation_id" text not null, "status" text not null default 'queued', "provider_message_id" text null, "error_reason" text null, "delivery_revision" int not null default 0, "dispatched_at" timestamptz null, "settled_at" timestamptz null, "consumed_by_retry" boolean not null default false, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_outbound_attempts" add constraint "connect_outbound_attempts_status_chk" check ("status" in ('queued', 'sending', 'sent', 'failed', 'unknown'));`);
    this.addSql(`alter table "connect_outbound_attempts" add constraint "connect_outbound_attempts_correlation_uq" unique ("tenant_id", "hub_correlation_id");`);
    this.addSql(`create index "connect_outbound_attempts_message_idx" on "connect_outbound_attempts" ("tenant_id", "message_id");`);
    this.addSql(`create index "connect_outbound_attempts_status_idx" on "connect_outbound_attempts" ("tenant_id", "status", "updated_at");`);
    // One child per predecessor: two operators clicking retry at once must not
    // fork the attempt chain and send the customer two replies.
    this.addSql(`create unique index "connect_outbound_attempts_predecessor_uq" on "connect_outbound_attempts" ("tenant_id", "predecessor_attempt_id") where "predecessor_attempt_id" is not null;`);

    this.addSql(`create table "connect_outbox" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "attempt_id" uuid not null, "payload_fingerprint" text not null, "status" text not null default 'pending', "lease_expires_at" timestamptz null, "dispatched_at" timestamptz null, "attempts" int not null default 0, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_outbox" add constraint "connect_outbox_status_chk" check ("status" in ('pending', 'dispatched', 'abandoned'));`);
    this.addSql(`alter table "connect_outbox" add constraint "connect_outbox_attempt_uq" unique ("tenant_id", "attempt_id");`);
    this.addSql(`create index "connect_outbox_pending_idx" on "connect_outbox" ("status", "lease_expires_at");`);

    this.addSql(`create table "connect_assignment_audits" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "case_id" uuid not null, "actor_user_id" uuid not null, "from_assignee_user_id" uuid null, "to_assignee_user_id" uuid null, "reason" text null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "connect_assignment_audits_case_idx" on "connect_assignment_audits" ("tenant_id", "case_id", "created_at");`);

    this.addSql(`create table "connect_case_read_states" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "case_id" uuid not null, "user_id" uuid not null, "last_read_at" timestamptz null, "last_read_external_message_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_case_read_states" add constraint "connect_case_read_states_user_uq" unique ("tenant_id", "organization_id", "case_id", "user_id");`);

    this.addSql(`create table "connect_unknown_deliveries" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "case_id" uuid not null, "attempt_id" uuid not null, "channel_id" uuid not null, "lookup_supported" boolean null, "last_checked_at" timestamptz null, "acknowledged_at" timestamptz null, "acknowledged_by_user_id" uuid null, "acknowledge_reason" text null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_unknown_deliveries" add constraint "connect_unknown_deliveries_attempt_uq" unique ("tenant_id", "attempt_id");`);
    this.addSql(`create index "connect_unknown_deliveries_open_idx" on "connect_unknown_deliveries" ("tenant_id", "organization_id", "acknowledged_at");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "connect_unknown_deliveries" cascade;`);
    this.addSql(`drop table if exists "connect_case_read_states" cascade;`);
    this.addSql(`drop table if exists "connect_assignment_audits" cascade;`);
    this.addSql(`drop table if exists "connect_outbox" cascade;`);
    this.addSql(`drop table if exists "connect_outbound_attempts" cascade;`);
    this.addSql(`drop table if exists "connect_outbound_messages" cascade;`);
  }

}

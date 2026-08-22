import { Migration } from '@mikro-orm/migrations';

/**
 * Mercato Connect — customer identity and timeline projection.
 *
 * The unlink fence (`unlink_pending_saga_id` on the identity) is the reason
 * this is not just a set of tables: it is what stops a projection being
 * admitted mid-unlink and thereby surviving the retraction it should have been
 * part of.
 */
export class Migration20260823030000_connect extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "connect_contact_identities" add column "association_epoch" int not null default 0;`);
    this.addSql(`alter table "connect_contact_identities" add column "unlink_pending_saga_id" text null;`);
    this.addSql(`alter table "connect_contact_identities" add column "unlink_pending_epoch" int null;`);

    this.addSql(`create table "connect_identity_link_audits" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "identity_id" uuid not null, "action" text not null, "actor_user_id" uuid not null, "from_customer_kind" text null, "from_customer_id" uuid null, "to_customer_kind" text null, "to_customer_id" uuid null, "reason" text null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_identity_link_audits" add constraint "connect_identity_link_audits_action_chk" check ("action" in ('link', 'unlink', 'relink'));`);
    this.addSql(`create index "connect_identity_link_audits_identity_idx" on "connect_identity_link_audits" ("tenant_id", "identity_id", "created_at");`);

    this.addSql(`create table "connect_manual_match_tasks" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "identity_id" uuid not null, "status" text not null default 'open', "resolution" text null, "source_event_id" text null, "resolved_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_manual_match_tasks" add constraint "connect_manual_match_tasks_status_chk" check ("status" in ('open', 'resolved', 'superseded'));`);
    // At most ONE open task per identity: a customer writing five times should
    // produce one thing to do, not five.
    this.addSql(`create unique index "connect_manual_match_tasks_open_uq" on "connect_manual_match_tasks" ("tenant_id", "organization_id", "identity_id") where "status" = 'open';`);
    this.addSql(`create index "connect_manual_match_tasks_queue_idx" on "connect_manual_match_tasks" ("tenant_id", "organization_id", "status", "created_at");`);

    this.addSql(`create table "connect_pending_projections" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "case_id" uuid not null, "identity_id" uuid null, "customer_kind" text null, "customer_id" uuid null, "projection_key" text not null, "projection_version" int not null, "association_epoch" int not null, "status" text not null default 'pending', "last_error" text null, "lease_expires_at" timestamptz null, "attempts" int not null default 0, "projected_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_pending_projections" add constraint "connect_pending_projections_status_chk" check ("status" in ('pending', 'projected', 'failed', 'superseded'));`);
    this.addSql(`alter table "connect_pending_projections" add constraint "connect_pending_projections_key_uq" unique ("tenant_id", "projection_key");`);
    this.addSql(`create index "connect_pending_projections_drain_idx" on "connect_pending_projections" ("status", "lease_expires_at");`);
    this.addSql(`create index "connect_pending_projections_identity_idx" on "connect_pending_projections" ("tenant_id", "organization_id", "identity_id", "status");`);

    this.addSql(`create table "connect_retraction_sagas" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "identity_id" uuid not null, "saga_id" text not null, "epoch" int not null, "association_epoch" int not null, "inventory" jsonb not null, "phase" text not null default 'pending_hide', "decision" text not null default 'undecided', "actor_user_id" uuid not null, "last_error" text null, "lease_expires_at" timestamptz null, "attempts" int not null default 0, "completed_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_retraction_sagas" add constraint "connect_retraction_sagas_phase_chk" check ("phase" in ('pending_hide', 'committing', 'finalizing', 'completed', 'aborted'));`);
    this.addSql(`alter table "connect_retraction_sagas" add constraint "connect_retraction_sagas_decision_chk" check ("decision" in ('undecided', 'commit', 'abort'));`);
    this.addSql(`alter table "connect_retraction_sagas" add constraint "connect_retraction_sagas_saga_uq" unique ("tenant_id", "organization_id", "saga_id", "epoch");`);
    this.addSql(`create index "connect_retraction_sagas_recovery_idx" on "connect_retraction_sagas" ("phase", "lease_expires_at");`);

    this.addSql(`create table "connect_pending_retractions" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "saga_id" text not null, "case_id" uuid not null, "identity_id" uuid not null, "projection_key" text not null, "former_customer_kind" text null, "former_customer_id" uuid null, "status" text not null default 'pending', "last_error" text null, "lease_expires_at" timestamptz null, "attempts" int not null default 0, "finalized_at" timestamptz null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_pending_retractions" add constraint "connect_pending_retractions_status_chk" check ("status" in ('pending', 'finalized', 'failed'));`);
    this.addSql(`alter table "connect_pending_retractions" add constraint "connect_pending_retractions_key_uq" unique ("tenant_id", "projection_key");`);
    this.addSql(`create index "connect_pending_retractions_drain_idx" on "connect_pending_retractions" ("status", "lease_expires_at");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "connect_pending_retractions" cascade;`);
    this.addSql(`drop table if exists "connect_retraction_sagas" cascade;`);
    this.addSql(`drop table if exists "connect_pending_projections" cascade;`);
    this.addSql(`drop table if exists "connect_manual_match_tasks" cascade;`);
    this.addSql(`drop table if exists "connect_identity_link_audits" cascade;`);
    this.addSql(`alter table "connect_contact_identities" drop column "unlink_pending_epoch";`);
    this.addSql(`alter table "connect_contact_identities" drop column "unlink_pending_saga_id";`);
    this.addSql(`alter table "connect_contact_identities" drop column "association_epoch";`);
  }

}

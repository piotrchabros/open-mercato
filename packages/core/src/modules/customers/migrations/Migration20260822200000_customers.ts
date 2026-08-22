import { Migration } from '@mikro-orm/migrations';

/**
 * Connect upstream Contract B — source-owned interaction lifecycle.
 *
 * Purely additive: every column is nullable and every index is partial on
 * `source_namespace IS NOT NULL`, so hand-created interactions and existing
 * rows are untouched and behave exactly as before.
 */
export class Migration20260822200000_customers extends Migration {

  override up(): void | Promise<void> {
    this.addSql(`alter table "customer_interactions" add column "source_namespace" text null;`);
    this.addSql(`alter table "customer_interactions" add column "source_key" text null;`);
    this.addSql(`alter table "customer_interactions" add column "source_identity_id" text null;`);
    this.addSql(`alter table "customer_interactions" add column "source_association_epoch" int null;`);
    this.addSql(`alter table "customer_interactions" add column "retraction_state" text null;`);
    this.addSql(`alter table "customer_interactions" add column "retracted_at" timestamptz null;`);
    this.addSql(`alter table "customer_interactions" add column "retraction_saga_id" text null;`);
    this.addSql(`alter table "customer_interactions" add constraint "customer_interactions_retraction_state_chk" check ("retraction_state" is null or "retraction_state" in ('pending_hidden', 'tombstoned'));`);
    this.addSql(`create unique index "customer_interactions_source_key_uq" on "customer_interactions" ("tenant_id", "organization_id", "source_namespace", "source_key") where "source_namespace" is not null and "source_key" is not null;`);
    this.addSql(`create index "customer_interactions_retraction_group_idx" on "customer_interactions" ("tenant_id", "organization_id", "source_namespace", "source_identity_id", "source_association_epoch") where "source_namespace" is not null;`);

    this.addSql(`create table "customer_interaction_retraction_sagas" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "namespace" text not null, "saga_id" text not null, "epoch" int not null, "identity_id" text not null, "association_epoch" int not null, "inventory" jsonb not null, "decision" text null, "decided_at" timestamptz null, "finalized_at" timestamptz null, "reason" text null, "requested_by_user_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "customer_interaction_retraction_sagas" add constraint "customer_interaction_retraction_sagas_decision_chk" check ("decision" is null or "decision" in ('commit', 'abort'));`);
    this.addSql(`create index "customer_interaction_retraction_sagas_group_idx" on "customer_interaction_retraction_sagas" ("tenant_id", "organization_id", "namespace", "identity_id");`);
    this.addSql(`alter table "customer_interaction_retraction_sagas" add constraint "customer_interaction_retraction_sagas_uq" unique ("tenant_id", "organization_id", "namespace", "saga_id", "epoch");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "customer_interaction_retraction_sagas" cascade;`);
    this.addSql(`drop index if exists "customer_interactions_retraction_group_idx";`);
    this.addSql(`drop index if exists "customer_interactions_source_key_uq";`);
    this.addSql(`alter table "customer_interactions" drop constraint if exists "customer_interactions_retraction_state_chk";`);
    this.addSql(`alter table "customer_interactions" drop column "retraction_saga_id";`);
    this.addSql(`alter table "customer_interactions" drop column "retracted_at";`);
    this.addSql(`alter table "customer_interactions" drop column "retraction_state";`);
    this.addSql(`alter table "customer_interactions" drop column "source_association_epoch";`);
    this.addSql(`alter table "customer_interactions" drop column "source_identity_id";`);
    this.addSql(`alter table "customer_interactions" drop column "source_key";`);
    this.addSql(`alter table "customer_interactions" drop column "source_namespace";`);
  }

}

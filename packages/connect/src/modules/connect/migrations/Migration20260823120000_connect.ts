import { Migration } from '@mikro-orm/migrations';

/**
 * Mercato Connect — SLA-agnostic source facts.
 *
 * Three append-only tables plus the columns that feed them. Nothing here knows
 * about calendars, targets or clocks: it records what happened, so an optional
 * consumer can compute a clock without inferring one from mutable Case rows
 * that a reopen would silently rewrite.
 *
 * Backfill is deliberately pessimistic. Every outbound message that already
 * exists becomes `response_evidence = 'unknown'`, because nobody resolved its
 * author's classification at the time it was sent and resolving it now would
 * retro-credit a person from today's data — the exact false claim the evidence
 * exists to prevent. `content_origin` defaults to `human_authored` since the
 * human reply route was the only writer, but with no author kind behind it that
 * still yields `unknown`.
 */
export class Migration20260823120000_connect extends Migration {

  override up(): void | Promise<void> {
    // Round 0 for every Case that already exists. Only a reopen advances it.
    this.addSql(`alter table "connect_cases" add column "sla_generation" int not null default 0;`);
    this.addSql(`alter table "connect_cases" add constraint "connect_cases_sla_generation_chk" check ("sla_generation" >= 0);`);

    this.addSql(`alter table "connect_outbound_messages" add column "case_generation" int not null default 0;`);
    this.addSql(`alter table "connect_outbound_messages" add column "content_origin" text not null default 'human_authored';`);
    this.addSql(`alter table "connect_outbound_messages" add column "author_principal_kind" text null;`);
    this.addSql(`alter table "connect_outbound_messages" add column "accepted_by_user_id" uuid null;`);
    this.addSql(`alter table "connect_outbound_messages" add column "accepted_by_principal_kind" text null;`);
    // Historical sends are unverifiable, and unverifiable is `unknown`.
    this.addSql(`alter table "connect_outbound_messages" add column "response_evidence" text not null default 'unknown';`);
    this.addSql(`alter table "connect_outbound_messages" add column "response_evidence_version" int not null default 1;`);
    this.addSql(`alter table "connect_outbound_messages" add constraint "connect_outbound_messages_content_origin_chk" check ("content_origin" in ('human_authored', 'ai_draft', 'automation'));`);
    this.addSql(`alter table "connect_outbound_messages" add constraint "connect_outbound_messages_author_kind_chk" check ("author_principal_kind" is null or "author_principal_kind" in ('human', 'system_bot', 'integration'));`);
    this.addSql(`alter table "connect_outbound_messages" add constraint "connect_outbound_messages_acceptor_kind_chk" check ("accepted_by_principal_kind" is null or "accepted_by_principal_kind" in ('human', 'system_bot', 'integration'));`);
    this.addSql(`alter table "connect_outbound_messages" add constraint "connect_outbound_messages_response_evidence_chk" check ("response_evidence" in ('human', 'human_accepted_ai', 'unknown'));`);

    this.addSql(`create table "connect_case_generation_facts" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "source_event_id" text not null, "case_id" uuid not null, "generation" int not null, "channel_id" uuid not null, "boundary" text not null, "cause" text not null, "started_at" timestamptz not null, "resolved_at" timestamptz null, "merged_into_case_id" uuid null, "lineage_version" int not null default 0, "occurred_at" timestamptz not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_case_generation_facts" add constraint "connect_case_generation_facts_boundary_chk" check ("boundary" in ('started', 'resolved'));`);
    this.addSql(`alter table "connect_case_generation_facts" add constraint "connect_case_generation_facts_cause_chk" check ("cause" in ('opened', 'reopened', 'resolved'));`);
    this.addSql(`alter table "connect_case_generation_facts" add constraint "connect_case_generation_facts_generation_chk" check ("generation" >= 0);`);
    // The idempotency arbiter: a replayed write resolves to the same key.
    this.addSql(`alter table "connect_case_generation_facts" add constraint "connect_case_generation_facts_source_uq" unique ("tenant_id", "organization_id", "source_event_id");`);
    // Exactly the reader's two access paths: the scoped keyset sweep and the
    // per-Case, per-generation drill-down.
    this.addSql(`create index "connect_case_generation_facts_keyset_idx" on "connect_case_generation_facts" ("tenant_id", "organization_id", "occurred_at", "id");`);
    this.addSql(`create index "connect_case_generation_facts_case_idx" on "connect_case_generation_facts" ("tenant_id", "organization_id", "case_id", "generation", "occurred_at", "id");`);

    this.addSql(`create table "connect_case_wait_facts" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "source_event_id" text not null, "case_id" uuid not null, "generation" int not null, "boundary" text not null, "started_at" timestamptz not null, "ended_at" timestamptz null, "occurred_at" timestamptz not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_case_wait_facts" add constraint "connect_case_wait_facts_boundary_chk" check ("boundary" in ('started', 'ended'));`);
    this.addSql(`alter table "connect_case_wait_facts" add constraint "connect_case_wait_facts_generation_chk" check ("generation" >= 0);`);
    this.addSql(`alter table "connect_case_wait_facts" add constraint "connect_case_wait_facts_source_uq" unique ("tenant_id", "organization_id", "source_event_id");`);
    this.addSql(`create index "connect_case_wait_facts_keyset_idx" on "connect_case_wait_facts" ("tenant_id", "organization_id", "occurred_at", "id");`);
    this.addSql(`create index "connect_case_wait_facts_case_idx" on "connect_case_wait_facts" ("tenant_id", "organization_id", "case_id", "generation", "occurred_at", "id");`);

    this.addSql(`create table "connect_outbound_delivery_facts" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "source_event_id" text not null, "case_id" uuid not null, "generation" int not null, "outbound_message_id" uuid not null, "attempt_id" uuid not null, "delivery_revision" int not null, "confirmed_at" timestamptz not null, "response_evidence" text not null, "response_evidence_version" int not null default 1, "author_user_id" uuid null, "accepted_by_user_id" uuid null, "occurred_at" timestamptz not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "connect_outbound_delivery_facts" add constraint "connect_outbound_delivery_facts_evidence_chk" check ("response_evidence" in ('human', 'human_accepted_ai', 'unknown'));`);
    this.addSql(`alter table "connect_outbound_delivery_facts" add constraint "connect_outbound_delivery_facts_generation_chk" check ("generation" >= 0);`);
    this.addSql(`alter table "connect_outbound_delivery_facts" add constraint "connect_outbound_delivery_facts_source_uq" unique ("tenant_id", "organization_id", "source_event_id");`);
    this.addSql(`create index "connect_outbound_delivery_facts_keyset_idx" on "connect_outbound_delivery_facts" ("tenant_id", "organization_id", "occurred_at", "id");`);
    this.addSql(`create index "connect_outbound_delivery_facts_case_idx" on "connect_outbound_delivery_facts" ("tenant_id", "organization_id", "case_id", "generation", "occurred_at", "id");`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "connect_outbound_delivery_facts" cascade;`);
    this.addSql(`drop table if exists "connect_case_wait_facts" cascade;`);
    this.addSql(`drop table if exists "connect_case_generation_facts" cascade;`);

    this.addSql(`alter table "connect_outbound_messages" drop constraint if exists "connect_outbound_messages_response_evidence_chk";`);
    this.addSql(`alter table "connect_outbound_messages" drop constraint if exists "connect_outbound_messages_acceptor_kind_chk";`);
    this.addSql(`alter table "connect_outbound_messages" drop constraint if exists "connect_outbound_messages_author_kind_chk";`);
    this.addSql(`alter table "connect_outbound_messages" drop constraint if exists "connect_outbound_messages_content_origin_chk";`);
    this.addSql(`alter table "connect_outbound_messages" drop column "response_evidence_version";`);
    this.addSql(`alter table "connect_outbound_messages" drop column "response_evidence";`);
    this.addSql(`alter table "connect_outbound_messages" drop column "accepted_by_principal_kind";`);
    this.addSql(`alter table "connect_outbound_messages" drop column "accepted_by_user_id";`);
    this.addSql(`alter table "connect_outbound_messages" drop column "author_principal_kind";`);
    this.addSql(`alter table "connect_outbound_messages" drop column "content_origin";`);
    this.addSql(`alter table "connect_outbound_messages" drop column "case_generation";`);

    this.addSql(`alter table "connect_cases" drop constraint if exists "connect_cases_sla_generation_chk";`);
    this.addSql(`alter table "connect_cases" drop column "sla_generation";`);
  }

}

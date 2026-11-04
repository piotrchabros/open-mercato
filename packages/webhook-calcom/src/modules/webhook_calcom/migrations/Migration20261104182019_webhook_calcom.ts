import { Migration } from '@mikro-orm/migrations';
import { buildEncryptionMapBackfillSql } from '@open-mercato/shared/lib/encryption/migration-backfill';

export class Migration20261104182019_webhook_calcom extends Migration {

  override name = 'Migration20261104182019';

  override up(): void | Promise<void> {
    this.addSql(`create table "calcom_unassigned_transcripts" ("id" uuid not null default gen_random_uuid(), "tenant_id" uuid not null, "organization_id" uuid not null, "booking_uid" text not null, "transcript_id" text not null, "session_id" text not null, "source" text null, "title" text not null, "meeting_started_at" timestamptz not null, "meeting_ended_at" timestamptz not null, "organizer_email" text null, "organizer_user_id" text null, "participants_summary" jsonb not null, "language" text null, "completeness" text null, "duration_ms" int null, "passage_count" int null, "summary_status" text null, "summary_text" text null, "payload" jsonb not null, "reason" text not null, "status" text not null default 'pending', "resolved_at" timestamptz null, "resolved_by" uuid null, "resolved_entity_id" uuid null, "resolved_to_interaction_id" uuid null, "resolved_attachment_id" uuid null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "calcom_unassigned_transcripts_org_tenant_status_created_idx" on "calcom_unassigned_transcripts" ("organization_id", "tenant_id", "status", "created_at");`);
    this.addSql(`alter table "calcom_unassigned_transcripts" add constraint "calcom_unassigned_transcripts_tenant_org_transcript_uq" unique ("tenant_id", "organization_id", "transcript_id");`);

    this.addSql(buildEncryptionMapBackfillSql({
      entityId: 'webhook_calcom:calcom_unassigned_transcript',
      fields: [
        { field: 'title' },
        { field: 'organizer_email' },
        { field: 'participants_summary' },
        { field: 'summary_text' },
        { field: 'payload' },
      ],
    }));
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "calcom_unassigned_transcripts";`);
  }

}

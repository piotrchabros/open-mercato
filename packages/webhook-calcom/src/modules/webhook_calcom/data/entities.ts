import { OptionalProps } from '@mikro-orm/core'
import { Entity, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy'

export type CalcomUnassignedTranscriptStatus = 'pending' | 'resolved' | 'dismissed'

export type CalcomUnassignedTranscriptReason = 'no_attendees' | 'no_matching_attendee'

export type CalcomUnassignedTranscriptParticipant = {
  name: string | null
  email: string
}

export type CalcomUnassignedTranscriptPayload = {
  booking: Record<string, unknown>
  notetaker: Record<string, unknown>
}

@Entity({ tableName: 'calcom_unassigned_transcripts' })
@Index({
  name: 'calcom_unassigned_transcripts_org_tenant_status_created_idx',
  properties: ['organizationId', 'tenantId', 'status', 'createdAt'],
})
@Unique({
  name: 'calcom_unassigned_transcripts_tenant_org_transcript_uq',
  properties: ['tenantId', 'organizationId', 'transcriptId'],
})
export class CalcomUnassignedTranscript {
  [OptionalProps]?:
    | 'status'
    | 'source'
    | 'organizerEmail'
    | 'organizerUserId'
    | 'language'
    | 'completeness'
    | 'durationMs'
    | 'passageCount'
    | 'summaryStatus'
    | 'summaryText'
    | 'resolvedAt'
    | 'resolvedBy'
    | 'resolvedEntityId'
    | 'resolvedToInteractionId'
    | 'resolvedAttachmentId'
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'

  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string

  @Property({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string

  @Property({ name: 'organization_id', type: 'uuid' })
  organizationId!: string

  @Property({ name: 'booking_uid', type: 'text' })
  bookingUid!: string

  @Property({ name: 'transcript_id', type: 'text' })
  transcriptId!: string

  @Property({ name: 'session_id', type: 'text' })
  sessionId!: string

  @Property({ name: 'source', type: 'text', nullable: true })
  source?: string | null

  @Property({ name: 'title', type: 'text' })
  title!: string

  @Property({ name: 'meeting_started_at', type: Date })
  meetingStartedAt!: Date

  @Property({ name: 'meeting_ended_at', type: Date })
  meetingEndedAt!: Date

  @Property({ name: 'organizer_email', type: 'text', nullable: true })
  organizerEmail?: string | null

  @Property({ name: 'organizer_user_id', type: 'text', nullable: true })
  organizerUserId?: string | null

  @Property({ name: 'participants_summary', type: 'jsonb' })
  participantsSummary!: CalcomUnassignedTranscriptParticipant[]

  @Property({ name: 'language', type: 'text', nullable: true })
  language?: string | null

  @Property({ name: 'completeness', type: 'text', nullable: true })
  completeness?: string | null

  @Property({ name: 'duration_ms', type: 'int', nullable: true })
  durationMs?: number | null

  @Property({ name: 'passage_count', type: 'int', nullable: true })
  passageCount?: number | null

  @Property({ name: 'summary_status', type: 'text', nullable: true })
  summaryStatus?: string | null

  @Property({ name: 'summary_text', type: 'text', nullable: true })
  summaryText?: string | null

  @Property({ name: 'payload', type: 'jsonb' })
  payload!: CalcomUnassignedTranscriptPayload

  @Property({ name: 'reason', type: 'text' })
  reason!: CalcomUnassignedTranscriptReason

  @Property({ name: 'status', type: 'text', default: 'pending' })
  status: CalcomUnassignedTranscriptStatus = 'pending'

  @Property({ name: 'resolved_at', type: Date, nullable: true })
  resolvedAt?: Date | null

  @Property({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedBy?: string | null

  @Property({ name: 'resolved_entity_id', type: 'uuid', nullable: true })
  resolvedEntityId?: string | null

  @Property({ name: 'resolved_to_interaction_id', type: 'uuid', nullable: true })
  resolvedToInteractionId?: string | null

  @Property({ name: 'resolved_attachment_id', type: 'uuid', nullable: true })
  resolvedAttachmentId?: string | null

  @Property({ name: 'created_at', type: Date, onCreate: () => new Date() })
  createdAt: Date = new Date()

  @Property({ name: 'updated_at', type: Date, onUpdate: () => new Date() })
  updatedAt: Date = new Date()

  @Property({ name: 'deleted_at', type: Date, nullable: true })
  deletedAt?: Date | null
}

import type { TranslateFn } from '@open-mercato/shared/lib/i18n/context'
import type { StatusBadgeVariant } from '@open-mercato/ui/primitives/status-badge'

export const UNASSIGNED_TRANSCRIPTS_API_PATH = '/api/webhook_calcom/unassigned-transcripts'
export const UNASSIGNED_TRANSCRIPTS_BACKEND_PATH = '/backend/unassigned-transcripts'
export const UNASSIGNED_TRANSCRIPT_RESOURCE_KIND = 'webhook_calcom.unassigned_transcript'

export type TranscriptParticipant = {
  name: string | null
  email: string
}

export type UnassignedTranscriptRow = {
  id: string
  title: string
  source: string | null
  reason: string | null
  status: string | null
  meetingStartedAt: string | null
  meetingEndedAt: string | null
  organizerEmail: string | null
  participants: TranscriptParticipant[]
  resolvedEntityId: string | null
  resolvedToInteractionId: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type UnassignedTranscriptDetail = UnassignedTranscriptRow & {
  summaryText: string | null
  resolvedAt: string | null
  transcriptPreview?: string
  transcriptPreviewTruncated?: boolean
}

export type AssignTranscriptResult = {
  interactionId: string
  attachmentId: string
  resolvedEntityId: string
  assignedToDifferentPerson: boolean
}

export function buildTranscriptDetailHref(id: string): string {
  return `${UNASSIGNED_TRANSCRIPTS_BACKEND_PATH}/${encodeURIComponent(id)}`
}

export function buildPersonHref(personId: string): string {
  return `/backend/customers/people-v2/${encodeURIComponent(personId)}`
}

export function formatTranscriptDateTime(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString()
}

export function formatParticipant(participant: TranscriptParticipant): string {
  const name = participant.name?.trim()
  return name ? `${name} <${participant.email}>` : participant.email
}

export function translateTranscriptSource(t: TranslateFn, source: string | null): string {
  switch (source) {
    case 'booking':
      return t('webhook_calcom.inbox.source.booking', 'Booking')
    case 'ad_hoc':
      return t('webhook_calcom.inbox.source.adHoc', 'Ad-hoc meeting')
    case 'calendar_auto_join':
      return t('webhook_calcom.inbox.source.calendarAutoJoin', 'Calendar auto-join')
    default:
      return t('webhook_calcom.inbox.source.unknown', 'Unknown')
  }
}

export function translateTranscriptReason(t: TranslateFn, reason: string | null): string {
  switch (reason) {
    case 'no_attendees':
      return t('webhook_calcom.inbox.reason.noAttendees', 'No attendees')
    case 'no_matching_attendee':
      return t('webhook_calcom.inbox.reason.noMatchingAttendee', 'No matching person')
    default:
      return t('webhook_calcom.inbox.reason.unknown', 'Unknown')
  }
}

export function translateTranscriptStatus(t: TranslateFn, status: string | null): string {
  return status === 'resolved'
    ? t('webhook_calcom.inbox.status.resolved', 'Resolved')
    : t('webhook_calcom.inbox.status.pending', 'Pending')
}

export function transcriptStatusVariant(status: string | null): StatusBadgeVariant {
  return status === 'resolved' ? 'success' : 'warning'
}

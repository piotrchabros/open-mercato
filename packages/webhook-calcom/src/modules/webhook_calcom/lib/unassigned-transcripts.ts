import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import {
  CalcomUnassignedTranscript,
  type CalcomUnassignedTranscriptParticipant,
  type CalcomUnassignedTranscriptReason,
  type CalcomUnassignedTranscriptStatus,
} from '../data/entities'
import { calcomBookingSchema, calcomNotetakerSchema, type CalcomBooking, type CalcomNotetaker } from './payload'
import {
  normaliseNotetakerTranscript,
  renderSummaryText,
  renderTranscriptText,
  type CalcomTranscriptLabels,
} from './transcript'
import type { CalcomTranslate } from './transcript-sync'

export type UnassignedTranscriptScope = { tenantId: string; organizationId: string }

export type QueueUnassignedTranscriptInput = {
  booking: CalcomBooking
  notetaker: CalcomNotetaker
  organizerUserId: string | null
}

export type UnassignedTranscriptPreview = { text: string; truncated: boolean }

export type UnassignedTranscriptDto = {
  id: string
  bookingUid: string
  transcriptId: string
  sessionId: string
  source: string | null
  title: string
  meetingStartedAt: string
  meetingEndedAt: string
  organizerEmail: string | null
  organizerUserId: string | null
  participants: CalcomUnassignedTranscriptParticipant[]
  language: string | null
  completeness: string | null
  durationMs: number | null
  passageCount: number | null
  summaryStatus: string | null
  summaryText: string | null
  reason: CalcomUnassignedTranscriptReason
  status: CalcomUnassignedTranscriptStatus
  resolvedAt: string | null
  resolvedBy: string | null
  resolvedEntityId: string | null
  resolvedToInteractionId: string | null
  resolvedAttachmentId: string | null
  createdAt: string
  updatedAt: string
  transcriptPreview?: string
  transcriptPreviewTruncated?: boolean
}

const DEFAULT_PREVIEW_MAX_LINES = 200

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function buildLabels(translate: CalcomTranslate): CalcomTranscriptLabels {
  return {
    fileHeader: translate('webhook_calcom.transcript.fileHeader', 'Meeting transcript'),
    summaryHeading: translate('webhook_calcom.transcript.summaryHeading', 'Meeting summary'),
    keyPoints: translate('webhook_calcom.transcript.keyPoints', 'Key points'),
    decisions: translate('webhook_calcom.transcript.decisions', 'Decisions'),
    actionItems: translate('webhook_calcom.transcript.actionItems', 'Action items'),
    transcriptHeading: translate('webhook_calcom.transcript.transcriptHeading', 'Transcript'),
    unknownSpeaker: translate('webhook_calcom.transcript.unknownSpeaker', 'Unknown speaker'),
    unknownSpeakerNumbered: (number: number) =>
      translate('webhook_calcom.transcript.unknownSpeakerNumbered', 'Unknown speaker {number}', { number }),
  }
}

function resolveTitle(booking: CalcomBooking, translate: CalcomTranslate): string {
  return nonEmpty(booking.title) ?? translate('webhook_calcom.interaction.defaultTitle', 'Meeting')
}

function buildParticipants(booking: CalcomBooking): CalcomUnassignedTranscriptParticipant[] {
  return (booking.attendees ?? []).map((attendee) => ({
    name: nonEmpty(attendee.name),
    email: attendee.email,
  }))
}

async function findExisting(
  em: EntityManager,
  scope: UnassignedTranscriptScope,
  transcriptId: string,
): Promise<CalcomUnassignedTranscript | null> {
  return findOneWithDecryption(
    em,
    CalcomUnassignedTranscript,
    { tenantId: scope.tenantId, organizationId: scope.organizationId, transcriptId },
    undefined,
    scope,
  )
}

export async function queueUnassignedCalcomTranscript(
  em: EntityManager,
  scope: UnassignedTranscriptScope,
  input: QueueUnassignedTranscriptInput,
  reason: CalcomUnassignedTranscriptReason,
  translate: CalcomTranslate,
): Promise<{ id: string; duplicate: boolean }> {
  const { booking, notetaker, organizerUserId } = input
  const existing = await findExisting(em, scope, notetaker.transcriptId)
  if (existing) return { id: existing.id, duplicate: true }

  const labels = buildLabels(translate)
  const transcript = normaliseNotetakerTranscript(booking.uid ?? '', notetaker, labels)
  const summaryText = transcript.summary?.status === 'READY' ? renderSummaryText(transcript.summary, labels) : ''
  const startedAt = parseDate(booking.startTime) ?? new Date()
  const endedAt = parseDate(booking.endTime) ?? startedAt

  const row = em.create(CalcomUnassignedTranscript, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    bookingUid: booking.uid ?? '',
    transcriptId: notetaker.transcriptId,
    sessionId: notetaker.sessionId,
    source: booking.source ?? null,
    title: resolveTitle(booking, translate),
    meetingStartedAt: startedAt,
    meetingEndedAt: endedAt,
    organizerEmail: nonEmpty(booking.organizer?.email) ?? nonEmpty(booking.user?.email),
    organizerUserId,
    participantsSummary: buildParticipants(booking),
    language: nonEmpty(notetaker.language),
    completeness: notetaker.completeness ?? null,
    durationMs: notetaker.durationMs ?? null,
    passageCount: notetaker.passages.length,
    summaryStatus: notetaker.summary?.status ?? null,
    summaryText: summaryText.length > 0 ? summaryText : null,
    payload: { booking, notetaker },
    reason,
    status: 'pending',
  })
  em.persist(row)
  await em.flush()
  return { id: row.id, duplicate: false }
}

export function renderUnassignedTranscriptPreview(
  row: Pick<CalcomUnassignedTranscript, 'payload' | 'title' | 'meetingStartedAt' | 'bookingUid'>,
  translate: CalcomTranslate,
  maxLines: number = DEFAULT_PREVIEW_MAX_LINES,
): UnassignedTranscriptPreview {
  const labels = buildLabels(translate)
  const notetaker = calcomNotetakerSchema.parse(row.payload.notetaker)
  const booking = calcomBookingSchema.parse(row.payload.booking)
  const transcript = normaliseNotetakerTranscript(row.bookingUid, notetaker, labels)
  const text = renderTranscriptText(
    transcript,
    { title: row.title, startTime: booking.startTime ?? row.meetingStartedAt.toISOString() },
    labels,
  )
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { text, truncated: false }
  return { text: lines.slice(0, maxLines).join('\n'), truncated: true }
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

export function toUnassignedTranscriptDto(
  row: CalcomUnassignedTranscript,
  opts: { includePreview?: boolean; translate?: CalcomTranslate; maxLines?: number } = {},
): UnassignedTranscriptDto {
  const dto: UnassignedTranscriptDto = {
    id: row.id,
    bookingUid: row.bookingUid,
    transcriptId: row.transcriptId,
    sessionId: row.sessionId,
    source: row.source ?? null,
    title: row.title,
    meetingStartedAt: row.meetingStartedAt.toISOString(),
    meetingEndedAt: row.meetingEndedAt.toISOString(),
    organizerEmail: row.organizerEmail ?? null,
    organizerUserId: row.organizerUserId ?? null,
    participants: row.participantsSummary ?? [],
    language: row.language ?? null,
    completeness: row.completeness ?? null,
    durationMs: row.durationMs ?? null,
    passageCount: row.passageCount ?? null,
    summaryStatus: row.summaryStatus ?? null,
    summaryText: row.summaryText ?? null,
    reason: row.reason,
    status: row.status,
    resolvedAt: toIso(row.resolvedAt),
    resolvedBy: row.resolvedBy ?? null,
    resolvedEntityId: row.resolvedEntityId ?? null,
    resolvedToInteractionId: row.resolvedToInteractionId ?? null,
    resolvedAttachmentId: row.resolvedAttachmentId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
  if (opts.includePreview && opts.translate) {
    const preview = renderUnassignedTranscriptPreview(row, opts.translate, opts.maxLines)
    dto.transcriptPreview = preview.text
    dto.transcriptPreviewTruncated = preview.truncated
  }
  return dto
}

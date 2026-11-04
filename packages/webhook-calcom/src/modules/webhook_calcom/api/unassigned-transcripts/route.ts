import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { createPagedListResponseSchema, defaultOkResponseSchema } from '@open-mercato/shared/lib/openapi/crud'
import { UNASSIGNED_TRANSCRIPT_DISMISS_COMMAND_ID } from '../../commands/unassigned-transcripts'
import { CalcomUnassignedTranscript, type CalcomUnassignedTranscriptParticipant } from '../../data/entities'
import {
  calcomUnassignedTranscriptSources,
  calcomUnassignedTranscriptStatuses,
  unassignedTranscriptListQuerySchema,
  type UnassignedTranscriptListQuery,
} from '../../data/validators'
import { buildWebhookCalcomCrudOpenApi } from '../openapi'

export const UNASSIGNED_TRANSCRIPT_ENTITY_ID = 'webhook_calcom:calcom_unassigned_transcript'

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['webhook_calcom.transcripts.view'] },
  DELETE: { requireAuth: true, requireFeatures: ['webhook_calcom.transcripts.manage'] },
}

export const metadata = routeMetadata

const listFields = [
  'id',
  'organization_id',
  'tenant_id',
  'booking_uid',
  'transcript_id',
  'session_id',
  'source',
  'title',
  'meeting_started_at',
  'meeting_ended_at',
  'organizer_email',
  'organizer_user_id',
  'participants_summary',
  'language',
  'completeness',
  'duration_ms',
  'passage_count',
  'summary_status',
  'reason',
  'status',
  'resolved_at',
  'resolved_by',
  'resolved_entity_id',
  'resolved_to_interaction_id',
  'resolved_attachment_id',
  'created_at',
  'updated_at',
]

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readIsoDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value === 'string' && value.length > 0) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toISOString()
  }
  return null
}

function readParticipants(value: unknown): CalcomUnassignedTranscriptParticipant[] {
  let candidate: unknown = value
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return []
    }
  }
  if (!Array.isArray(candidate)) return []
  return candidate.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const email = readString(record.email)
    if (!email) return []
    return [{ name: readString(record.name), email }]
  })
}

export function toUnassignedTranscriptListItem(item: Record<string, unknown>) {
  return {
    id: String(item.id),
    organizationId: readString(item.organization_id),
    tenantId: readString(item.tenant_id),
    bookingUid: readString(item.booking_uid) ?? '',
    transcriptId: readString(item.transcript_id) ?? '',
    sessionId: readString(item.session_id) ?? '',
    source: readString(item.source),
    title: readString(item.title) ?? '',
    meetingStartedAt: readIsoDate(item.meeting_started_at),
    meetingEndedAt: readIsoDate(item.meeting_ended_at),
    organizerEmail: readString(item.organizer_email),
    organizerUserId: readString(item.organizer_user_id),
    participants: readParticipants(item.participants_summary),
    language: readString(item.language),
    completeness: readString(item.completeness),
    durationMs: readNumber(item.duration_ms),
    passageCount: readNumber(item.passage_count),
    summaryStatus: readString(item.summary_status),
    reason: readString(item.reason),
    status: readString(item.status),
    resolvedAt: readIsoDate(item.resolved_at),
    resolvedBy: readString(item.resolved_by),
    resolvedEntityId: readString(item.resolved_entity_id),
    resolvedToInteractionId: readString(item.resolved_to_interaction_id),
    resolvedAttachmentId: readString(item.resolved_attachment_id),
    createdAt: readIsoDate(item.created_at),
    updatedAt: readIsoDate(item.updated_at),
  }
}

const crud = makeCrudRoute<never, never, UnassignedTranscriptListQuery>({
  metadata: routeMetadata,
  orm: {
    entity: CalcomUnassignedTranscript,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  list: {
    entityId: UNASSIGNED_TRANSCRIPT_ENTITY_ID,
    schema: unassignedTranscriptListQuerySchema,
    fields: listFields,
    sortFieldMap: {
      createdAt: 'created_at',
      meetingStartedAt: 'meeting_started_at',
      updatedAt: 'updated_at',
    },
    defaultSort: { field: 'createdAt', dir: 'desc' },
    tiebreakSortField: 'id',
    buildFilters: (query) => {
      const filters: Record<string, unknown> = { status: { $eq: query.status } }
      if (query.source) filters.source = { $eq: query.source }
      return filters
    },
    transformItem: (item: Record<string, unknown>) => toUnassignedTranscriptListItem(item),
  },
  actions: {
    delete: {
      commandId: UNASSIGNED_TRANSCRIPT_DISMISS_COMMAND_ID,
      response: () => ({ ok: true }),
    },
  },
})

export const { GET, DELETE } = crud

const participantSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
})

const unassignedTranscriptListItemSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid().nullable(),
  tenantId: z.string().uuid().nullable(),
  bookingUid: z.string(),
  transcriptId: z.string(),
  sessionId: z.string(),
  source: z.enum(calcomUnassignedTranscriptSources).nullable(),
  title: z.string(),
  meetingStartedAt: z.string().nullable(),
  meetingEndedAt: z.string().nullable(),
  organizerEmail: z.string().nullable(),
  organizerUserId: z.string().nullable(),
  participants: z.array(participantSchema),
  language: z.string().nullable(),
  completeness: z.string().nullable(),
  durationMs: z.number().nullable(),
  passageCount: z.number().nullable(),
  summaryStatus: z.string().nullable(),
  reason: z.enum(['no_attendees', 'no_matching_attendee']).nullable(),
  status: z.enum(calcomUnassignedTranscriptStatuses).nullable(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedEntityId: z.string().nullable(),
  resolvedToInteractionId: z.string().nullable(),
  resolvedAttachmentId: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
})

export const openApi = buildWebhookCalcomCrudOpenApi({
  resourceName: 'UnassignedTranscript',
  pluralName: 'Unassigned transcripts',
  description:
    'Cal.com meeting transcripts that matched no CRM person. The raw webhook payload is never returned by this endpoint.',
  querySchema: unassignedTranscriptListQuerySchema,
  listResponseSchema: createPagedListResponseSchema(unassignedTranscriptListItemSchema),
  del: {
    schema: z.object({ id: z.string().uuid() }),
    responseSchema: defaultOkResponseSchema,
    description:
      'Dismisses a pending unassigned transcript (soft delete). Honors the optimistic-lock header; returns 409 when the transcript changed or was already handled.',
  },
})

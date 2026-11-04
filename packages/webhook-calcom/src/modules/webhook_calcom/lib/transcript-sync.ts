import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { z } from 'zod'
import type { CommandBus, CommandRuntimeContext } from '@open-mercato/shared/lib/commands'
import type { TranslateParams } from '@open-mercato/shared/lib/i18n/context'
import {
  createAttachmentFromBuffer,
  type CreateAttachmentFromBufferInput,
} from '@open-mercato/core/modules/attachments/lib/createFromBuffer'
import type {
  commentCreateSchema,
  interactionCompleteSchema,
} from '@open-mercato/core/modules/customers/data/validators'
import { isTerminalInteractionStatus } from '@open-mercato/core/modules/customers/lib/interactionStatus'
import type { ExternalIdMappingService } from '@open-mercato/core/modules/data_sync/lib/id-mapping'
import type { IntegrationLogService } from '@open-mercato/core/modules/integrations/lib/log-service'
import type { IntegrationStateService } from '@open-mercato/core/modules/integrations/lib/state-service'
import type { CalcomUnassignedTranscriptReason } from '../data/entities'
import { emitWebhookCalcomEvent, type CalcomUnassignedTranscriptCreatedPayload } from '../events'
import { CALCOM_INTEGRATION_ID } from '../integration'
import {
  createCalcomInteraction,
  resolveCalcomInteraction,
  type CalcomResolvedInteraction,
  type CalcomSyncScope,
} from './booking-sync'
import { buildCalcomCommandContext } from './command-context'
import { CALCOM_ATTACHMENT_ENTITY, CALCOM_INTERACTION_ENTITY, MAX_SUMMARY_COMMENT_CHARS } from './constants'
import type { CalcomCredentials } from './credentials'
import { withCalcomLock } from './locking'
import { extractBookingUid, type CalcomBooking, type CalcomNotetaker } from './payload'
import { excludeStaffAttendees, resolveCalcomCustomers, resolveOrganizerUser } from './people'
import {
  normaliseNotetakerTranscript,
  renderSummaryText,
  renderTranscriptText,
  truncateForComment,
  type CalcomTranscriptLabels,
} from './transcript'
import { queueUnassignedCalcomTranscript } from './unassigned-transcripts'

export type CalcomTranslate = (key: string, fallback: string, params?: TranslateParams) => string

export type CalcomTranscriptSyncInput = {
  booking: CalcomBooking
  notetaker: CalcomNotetaker
  scope: CalcomSyncScope
  credentials: CalcomCredentials
  translate: CalcomTranslate
}

export type CalcomTranscriptSyncAction = 'attached' | 'duplicate' | 'skipped' | 'created_and_attached' | 'queued'

export type CalcomTranscriptSyncOutcome = {
  action: CalcomTranscriptSyncAction
  attachmentId: string | null
  interactionId: string | null
  unassignedTranscriptId?: string
  reason?: string
}

export type CalcomTranscriptProjectionRuntime = {
  em: EntityManager
  commandBus: CommandBus
  commandCtx: CommandRuntimeContext
  mappings: Pick<ExternalIdMappingService, 'lookupLocalId' | 'storeExternalIdMapping'>
  dataEngine: CreateAttachmentFromBufferInput['dataEngine']
  scope: CalcomSyncScope
}

export type CalcomTranscriptProjectionInteraction = Pick<CalcomResolvedInteraction, 'id' | 'entityId' | 'status'>

export type CalcomTranscriptProjectionInput = {
  booking: CalcomBooking
  notetaker: CalcomNotetaker
  translate: CalcomTranslate
}

export type CalcomTranscriptProjection = { attachmentId: string; duplicate: boolean }

type CommentCreateInput = z.input<typeof commentCreateSchema>
type InteractionCompleteInput = z.input<typeof interactionCompleteSchema>

type TranscriptRuntime = CalcomTranscriptProjectionRuntime & {
  input: CalcomTranscriptSyncInput
}

type QueuedTranscript = { id: string; reason: CalcomUnassignedTranscriptReason }

type TranscriptRunResult = { outcome: CalcomTranscriptSyncOutcome; queued: QueuedTranscript | null }

const TRANSCRIPT_TRIGGER = 'RECORDING_TRANSCRIPTION_GENERATED'
const TRANSCRIPT_MIME_TYPE = 'text/plain; charset=utf-8'
const MAX_SLUG_LENGTH = 60
const MAX_ASSIGNMENT_LABEL_LENGTH = 200

export function calcomTranscriptExternalId(uid: string, transcriptId: string): string {
  return `${uid}:transcript:${transcriptId}`
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
  const title = typeof booking.title === 'string' ? booking.title.trim() : ''
  return title.length > 0 ? title : translate('webhook_calcom.interaction.defaultTitle', 'Meeting')
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'meeting'
}

export function buildCalcomTranscriptFileName(booking: CalcomBooking, title: string): string {
  const date = (parseDate(booking.startTime) ?? new Date()).toISOString().slice(0, 10)
  return `transcript-${date}-${slugify(title)}.txt`
}

function resolveOccurredAt(booking: CalcomBooking): string {
  return (parseDate(booking.endTime) ?? new Date()).toISOString()
}

async function addSummaryComment(
  runtime: CalcomTranscriptProjectionRuntime,
  interaction: CalcomTranscriptProjectionInteraction,
  title: string,
  summaryText: string,
  labels: CalcomTranscriptLabels,
): Promise<void> {
  const { scope } = runtime
  const body = truncateForComment(`${labels.summaryHeading}: ${title}\n\n${summaryText}`, MAX_SUMMARY_COMMENT_CHARS)
  const input: CommentCreateInput = {
    entityId: interaction.entityId,
    body,
    organizationId: scope.organizationId,
    tenantId: scope.tenantId,
  }
  await runtime.commandBus.execute<CommentCreateInput, { commentId: string; authorUserId: string | null }>(
    'customers.comments.create',
    { input, ctx: runtime.commandCtx },
  )
}

async function completeInteraction(
  runtime: CalcomTranscriptProjectionRuntime,
  interaction: CalcomTranscriptProjectionInteraction,
  booking: CalcomBooking,
): Promise<void> {
  if (isTerminalInteractionStatus(interaction.status)) return
  const input: InteractionCompleteInput = { id: interaction.id, occurredAt: resolveOccurredAt(booking) }
  await runtime.commandBus.execute<InteractionCompleteInput, { interactionId: string }>(
    'customers.interactions.complete',
    { input, ctx: runtime.commandCtx },
  )
}

export async function projectCalcomTranscript(
  runtime: CalcomTranscriptProjectionRuntime,
  interaction: CalcomTranscriptProjectionInteraction,
  input: CalcomTranscriptProjectionInput,
): Promise<CalcomTranscriptProjection> {
  const { booking, notetaker, translate } = input
  const { scope } = runtime
  const uid = extractBookingUid(booking) ?? ''
  const externalId = calcomTranscriptExternalId(uid, notetaker.transcriptId)
  const existingAttachmentId = await runtime.mappings.lookupLocalId(
    CALCOM_INTEGRATION_ID,
    CALCOM_ATTACHMENT_ENTITY,
    externalId,
    scope,
  )
  if (existingAttachmentId) return { attachmentId: existingAttachmentId, duplicate: true }

  const labels = buildLabels(translate)
  const title = resolveTitle(booking, translate)
  const transcript = normaliseNotetakerTranscript(uid, notetaker, labels)
  const text = renderTranscriptText(transcript, { title, startTime: booking.startTime ?? null }, labels)

  const attachment = await createAttachmentFromBuffer({
    em: runtime.em,
    dataEngine: runtime.dataEngine,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    entityId: 'customers:customer_entity',
    recordId: interaction.entityId,
    additionalAssignments: [
      { type: CALCOM_INTERACTION_ENTITY, id: interaction.id, label: title.slice(0, MAX_ASSIGNMENT_LABEL_LENGTH) },
    ],
    fileName: buildCalcomTranscriptFileName(booking, title),
    mimeType: TRANSCRIPT_MIME_TYPE,
    buffer: Buffer.from(text, 'utf-8'),
  })
  await runtime.mappings.storeExternalIdMapping(
    CALCOM_INTEGRATION_ID,
    CALCOM_ATTACHMENT_ENTITY,
    attachment.id,
    externalId,
    scope,
  )

  if (transcript.summary?.status === 'READY') {
    const summaryText = renderSummaryText(transcript.summary, labels)
    if (summaryText) await addSummaryComment(runtime, interaction, title, summaryText, labels)
  }
  await completeInteraction(runtime, interaction, booking)
  return { attachmentId: attachment.id, duplicate: false }
}

function hasAttendeeEmail(attendees: Array<{ email?: string | null }>): boolean {
  return attendees.some((attendee) => typeof attendee.email === 'string' && attendee.email.trim().length > 0)
}

async function queueTranscript(
  runtime: TranscriptRuntime,
  reason: CalcomUnassignedTranscriptReason,
): Promise<TranscriptRunResult> {
  const { booking, notetaker, scope, translate } = runtime.input
  const organizerEmail = booking.organizer?.email ?? booking.user?.email ?? null
  const organizer = organizerEmail ? await resolveOrganizerUser(runtime.em, scope, organizerEmail) : null
  const queued = await queueUnassignedCalcomTranscript(
    runtime.em,
    scope,
    { booking, notetaker, organizerUserId: organizer?.id ?? null },
    reason,
    translate,
  )
  if (queued.duplicate) {
    return {
      outcome: { action: 'duplicate', attachmentId: null, interactionId: null, unassignedTranscriptId: queued.id, reason },
      queued: null,
    }
  }
  return {
    outcome: { action: 'queued', attachmentId: null, interactionId: null, unassignedTranscriptId: queued.id, reason },
    queued: { id: queued.id, reason },
  }
}

async function createAndAttach(runtime: TranscriptRuntime, uid: string): Promise<TranscriptRunResult> {
  const { booking, notetaker, scope, credentials, translate } = runtime.input
  const attendees = await excludeStaffAttendees(runtime.em, scope, booking.attendees ?? [])
  if (!hasAttendeeEmail(attendees)) return queueTranscript(runtime, 'no_attendees')

  const customers = await resolveCalcomCustomers(
    { em: runtime.em, commandBus: runtime.commandBus, commandCtx: runtime.commandCtx },
    scope,
    attendees,
    credentials.unmatchedAttendeePolicy,
  )
  if (!customers.primaryEntityId) return queueTranscript(runtime, 'no_matching_attendee')

  await createCalcomInteraction(
    {
      em: runtime.em,
      commandBus: runtime.commandBus,
      commandCtx: runtime.commandCtx,
      externalIdMappingService: runtime.mappings,
      scope,
      booking,
      fallbackTitle: translate('webhook_calcom.interaction.defaultTitle', 'Meeting'),
    },
    { keyUid: uid, uids: [uid], entityId: customers.primaryEntityId, linkedEntities: customers.linkedEntities },
  )
  const { interaction } = await resolveCalcomInteraction(
    { em: runtime.em, externalIdMappingService: runtime.mappings },
    scope,
    [uid],
  )
  if (!interaction) throw new Error('[internal] Cal.com interaction missing after create')
  if (interaction.deletedAt) {
    return {
      outcome: { action: 'skipped', attachmentId: null, interactionId: interaction.id, reason: 'soft_deleted' },
      queued: null,
    }
  }
  const projection = await projectCalcomTranscript(runtime, interaction, { booking, notetaker, translate })
  return {
    outcome: {
      action: projection.duplicate ? 'duplicate' : 'created_and_attached',
      attachmentId: projection.attachmentId,
      interactionId: interaction.id,
    },
    queued: null,
  }
}

async function attachTranscript(runtime: TranscriptRuntime, uid: string): Promise<TranscriptRunResult> {
  const { booking, notetaker, scope, translate } = runtime.input
  const { interaction } = await resolveCalcomInteraction(
    { em: runtime.em, externalIdMappingService: runtime.mappings },
    scope,
    [uid],
  )
  if (!interaction) return createAndAttach(runtime, uid)
  if (interaction.deletedAt) {
    return {
      outcome: { action: 'skipped', attachmentId: null, interactionId: interaction.id, reason: 'soft_deleted' },
      queued: null,
    }
  }
  const projection = await projectCalcomTranscript(runtime, interaction, { booking, notetaker, translate })
  return {
    outcome: {
      action: projection.duplicate ? 'duplicate' : 'attached',
      attachmentId: projection.attachmentId,
      interactionId: interaction.id,
    },
    queued: null,
  }
}

async function emitQueuedTranscript(
  scope: CalcomSyncScope,
  transcriptId: string,
  queued: QueuedTranscript,
): Promise<void> {
  const payload: CalcomUnassignedTranscriptCreatedPayload = {
    id: queued.id,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    transcriptId,
    reason: queued.reason,
  }
  await emitWebhookCalcomEvent('webhook_calcom.unassigned_transcript.created', payload, {
    persistent: true,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
}

function resolveDataEngine(container: AwilixContainer): CreateAttachmentFromBufferInput['dataEngine'] {
  try {
    return container.resolve<CreateAttachmentFromBufferInput['dataEngine']>('dataEngine')
  } catch {
    return undefined
  }
}

async function writeOutcomeLog(
  logService: Pick<IntegrationLogService, 'write'>,
  scope: CalcomSyncScope,
  uid: string | null,
  transcriptId: string,
  outcome: CalcomTranscriptSyncOutcome,
): Promise<void> {
  const reasonSuffix = outcome.reason ? ` (${outcome.reason})` : ''
  await logService.write(
    {
      integrationId: CALCOM_INTEGRATION_ID,
      scopeEntityType: outcome.interactionId ? CALCOM_INTERACTION_ENTITY : null,
      scopeEntityId: outcome.interactionId,
      level: 'info',
      message: `Cal.com ${TRANSCRIPT_TRIGGER} webhook ${outcome.action}${reasonSuffix}`,
      code: `calcom.transcript.${outcome.action}`,
      payload: {
        trigger: TRANSCRIPT_TRIGGER,
        bookingUid: uid,
        transcriptId,
        action: outcome.action,
        reason: outcome.reason ?? null,
        interactionId: outcome.interactionId,
        attachmentId: outcome.attachmentId,
        unassignedTranscriptId: outcome.unassignedTranscriptId ?? null,
      },
    },
    scope,
  )
}

export async function attachCalcomTranscript(
  container: AwilixContainer,
  input: CalcomTranscriptSyncInput,
): Promise<CalcomTranscriptSyncOutcome> {
  const { scope, booking, notetaker } = input
  const em = container.resolve('em') as EntityManager
  const stateService = container.resolve('integrationStateService') as Pick<IntegrationStateService, 'isEnabled'>
  const logService = container.resolve('integrationLogService') as Pick<IntegrationLogService, 'write'>
  const uid = extractBookingUid(booking)

  const run = async (): Promise<TranscriptRunResult> => {
    if (!(await stateService.isEnabled(CALCOM_INTEGRATION_ID, scope))) {
      return {
        outcome: { action: 'skipped', attachmentId: null, interactionId: null, reason: 'integration_disabled' },
        queued: null,
      }
    }
    if (!uid) {
      return {
        outcome: { action: 'skipped', attachmentId: null, interactionId: null, reason: 'missing_uid' },
        queued: null,
      }
    }
    const runtime: TranscriptRuntime = {
      em,
      commandBus: container.resolve('commandBus') as CommandBus,
      commandCtx: buildCalcomCommandContext(container, scope),
      mappings: container.resolve('externalIdMappingService') as TranscriptRuntime['mappings'],
      dataEngine: resolveDataEngine(container),
      scope,
      input,
    }
    return withCalcomLock(em, scope, () => attachTranscript(runtime, uid))
  }

  try {
    const { outcome, queued } = await run()
    if (queued) await emitQueuedTranscript(scope, notetaker.transcriptId, queued)
    await writeOutcomeLog(logService, scope, uid, notetaker.transcriptId, outcome)
    return outcome
  } catch (error) {
    await logService.write(
      {
        integrationId: CALCOM_INTEGRATION_ID,
        level: 'error',
        message: `Cal.com ${TRANSCRIPT_TRIGGER} webhook failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        code: 'calcom.transcript.failed',
        payload: { trigger: TRANSCRIPT_TRIGGER, bookingUid: uid, transcriptId: notetaker.transcriptId },
      },
      scope,
    )
    throw error
  }
}

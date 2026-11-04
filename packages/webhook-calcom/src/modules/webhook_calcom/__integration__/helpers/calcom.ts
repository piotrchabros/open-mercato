import { randomUUID } from 'node:crypto'
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test'
import { apiRequest } from '@open-mercato/core/helpers/integration/api'
import { deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { drainIntegrationQueue } from '@open-mercato/core/helpers/integration/queue'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import bookingCreatedFixture from '../../__tests__/fixtures/booking-created.json' with { type: 'json' }
import bookingRescheduledFixture from '../../__tests__/fixtures/booking-rescheduled.json' with { type: 'json' }
import bookingCancelledFixture from '../../__tests__/fixtures/booking-cancelled.json' with { type: 'json' }
import meetingEndedFixture from '../../__tests__/fixtures/meeting-ended.json' with { type: 'json' }
import transcriptGeneratedFixture from '../../__tests__/fixtures/transcript-generated.json' with { type: 'json' }
import transcriptLegacyFixture from '../../__tests__/fixtures/transcript-legacy-daily.json' with { type: 'json' }
import { CALCOM_INTEGRATION_ID } from '../../integration'
import { CALCOM_SIGNATURE_HEADER, computeCalcomSignature } from '../../lib/signature'

const BASE_URL = process.env.BASE_URL?.trim() || null

export const CALCOM_INBOUND_PATH = '/api/webhooks/inbound/calcom'
export const CALCOM_INBOUND_DISPATCH_QUEUE = 'webhook-inbound-dispatch'
export const CALCOM_EVENTS_QUEUE = 'events'
export const CALCOM_TEST_INSTANCE_URL = 'https://cal.example.test'
export const CALCOM_FIXTURE_TITLE = bookingCreatedFixture.payload.title
export const CALCOM_FIXTURE_START_TIME = bookingCreatedFixture.payload.startTime
export const CALCOM_FIXTURE_SUMMARY_OVERVIEW = transcriptGeneratedFixture.payload.notetaker.summary.overview

export const UNASSIGNED_TRANSCRIPTS_PATH = '/api/webhook_calcom/unassigned-transcripts'

const CREDENTIALS_PATH = `/api/integrations/${CALCOM_INTEGRATION_ID}/credentials`
const STATE_PATH = `/api/integrations/${CALCOM_INTEGRATION_ID}/state`
const CALCOM_WEBHOOK_VERSION_HEADER = 'x-cal-webhook-version'
const CALCOM_WEBHOOK_VERSION = '2021-10-20'
const PROBE_TRIGGER = 'PING'
const SYNC_TIMEOUT_MS = 30_000
const SYNC_POLL_INTERVAL_MS = 500
const ENDPOINT_POLL_INTERVALS_MS = [500, 1000, 2000]

type JsonRecord = Record<string, unknown>

export type CalcomEnvelope = {
  triggerEvent: string
  createdAt: string
  payload: JsonRecord
}

export type CalcomAttendeeOverride = { name: string; email: string }

export type CalcomBookingEventInput = {
  uid: string
  attendees: CalcomAttendeeOverride[]
  createdAt?: string
  rescheduleUid?: string
  startTime?: string
  endTime?: string
}

export type CalcomTranscriptEventInput = {
  uid: string
  attendees: CalcomAttendeeOverride[]
  transcriptId: string
}

export type CalcomMeetingTranscriptSource = 'ad_hoc' | 'calendar_auto_join'

export type CalcomMeetingTranscriptEventInput = {
  uid: string
  transcriptId: string
  attendees: CalcomAttendeeOverride[]
  source: CalcomMeetingTranscriptSource
  organizerEmail: string
  title?: string
}

export type CalcomUnmatchedAttendeePolicy = 'create_person' | 'skip'

export type MeetingInteraction = {
  id: string
  entityId: string | null
  status: string
  title: string
  scheduledAt: string | null
  durationMinutes: number | null
  location: string | null
  source: string | null
  linkedEntities: Array<{ id: string; type: string; label?: string | null }> | null
}

export type PersonAttachment = {
  id: string
  fileName: string
  mimeType?: string | null
  assignments?: Array<{ type: string; id: string }>
}

export type PersonComment = {
  id: string
  body: string | null
}

export type UnassignedTranscriptListItem = {
  id: string
  bookingUid: string
  transcriptId: string
  source: string | null
  title: string
  reason: string | null
  status: string | null
  participants: Array<{ name: string | null; email: string }>
  updatedAt: string | null
}

export type UnassignedTranscriptDetail = UnassignedTranscriptListItem & {
  summaryText: string | null
  transcriptPreview?: string
  resolvedEntityId: string | null
  resolvedToInteractionId: string | null
  resolvedAttachmentId: string | null
}

export type PersonListItem = {
  id: string
  display_name: string | null
  primary_email: string | null
  source: string | null
}

function resolveUrl(path: string): string {
  return BASE_URL ? `${BASE_URL}${path}` : path
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function uniqueCalcomSuffix(): string {
  return `${Date.now()}-${randomUUID().slice(0, 8)}`
}

export function calcomTestEmail(slug: string, suffix: string): string {
  return `calcom-qa-${slug}-${suffix}@example.test`
}

export function calcomVideoUrl(uid: string): string {
  return `${CALCOM_TEST_INSTANCE_URL}/video/${uid}`
}

function withAttendees(rows: unknown, attendees: CalcomAttendeeOverride[]): JsonRecord[] {
  const template = Array.isArray(rows) && isRecord(rows[0]) ? rows[0] : {}
  return attendees.map((attendee) => ({ ...template, name: attendee.name, email: attendee.email }))
}

function applyBookingFields(payload: JsonRecord, input: CalcomBookingEventInput): JsonRecord {
  const metadata = isRecord(payload.metadata) ? payload.metadata : {}
  const videoCallData = isRecord(payload.videoCallData) ? payload.videoCallData : {}
  return {
    ...payload,
    uid: input.uid,
    attendees: withAttendees(payload.attendees, input.attendees),
    metadata: { ...metadata, videoCallUrl: calcomVideoUrl(input.uid) },
    videoCallData: { ...videoCallData, url: calcomVideoUrl(input.uid) },
    ...(input.startTime ? { startTime: input.startTime } : {}),
    ...(input.endTime ? { endTime: input.endTime } : {}),
    ...(input.rescheduleUid !== undefined ? { rescheduleUid: input.rescheduleUid } : {}),
  }
}

function buildBookingEvent(fixture: CalcomEnvelope, input: CalcomBookingEventInput): CalcomEnvelope {
  const envelope = cloneJson(fixture)
  return {
    ...envelope,
    createdAt: input.createdAt ?? new Date().toISOString(),
    payload: applyBookingFields(envelope.payload, input),
  }
}

export function buildBookingCreatedEvent(input: CalcomBookingEventInput): CalcomEnvelope {
  return buildBookingEvent(bookingCreatedFixture, input)
}

export function buildBookingRescheduledEvent(input: CalcomBookingEventInput & { rescheduleUid: string }): CalcomEnvelope {
  return buildBookingEvent(bookingRescheduledFixture, input)
}

export function buildBookingCancelledEvent(input: CalcomBookingEventInput): CalcomEnvelope {
  return buildBookingEvent(bookingCancelledFixture, input)
}

export function buildMeetingEndedEvent(input: { uid: string; attendees: CalcomAttendeeOverride[] }): JsonRecord {
  const flat = cloneJson<JsonRecord>(meetingEndedFixture)
  const metadata = isRecord(flat.metadata) ? flat.metadata : {}
  return {
    ...flat,
    uid: input.uid,
    attendees: withAttendees(flat.attendees, input.attendees),
    metadata: { ...metadata, videoCallUrl: calcomVideoUrl(input.uid) },
  }
}

export function buildTranscriptEvent(input: CalcomTranscriptEventInput): CalcomEnvelope {
  const envelope = buildBookingEvent(transcriptGeneratedFixture, { uid: input.uid, attendees: input.attendees })
  const notetaker = isRecord(envelope.payload.notetaker) ? envelope.payload.notetaker : {}
  return {
    ...envelope,
    payload: { ...envelope.payload, notetaker: { ...notetaker, transcriptId: input.transcriptId } },
  }
}

export function buildMeetingTranscriptEvent(input: CalcomMeetingTranscriptEventInput): CalcomEnvelope {
  const envelope = cloneJson<CalcomEnvelope>(transcriptGeneratedFixture)
  const template = envelope.payload
  const organizerTemplate = isRecord(template.organizer) ? template.organizer : {}
  const notetaker = isRecord(template.notetaker) ? template.notetaker : {}
  const videoCallUrl = calcomVideoUrl(input.uid)
  const person = (attendee: CalcomAttendeeOverride): JsonRecord => ({
    name: attendee.name,
    email: attendee.email,
    timeZone: organizerTemplate.timeZone,
    language: organizerTemplate.language,
  })
  return {
    triggerEvent: envelope.triggerEvent,
    createdAt: new Date().toISOString(),
    payload: {
      type: 'notetaker_meeting',
      uid: input.uid,
      bookingId: template.bookingId,
      eventTypeId: null,
      status: template.status,
      title: input.title ?? template.title,
      startTime: template.startTime,
      endTime: template.endTime,
      organizer: person({ name: String(organizerTemplate.name ?? ''), email: input.organizerEmail }),
      attendees: input.attendees.map(person),
      location: videoCallUrl,
      metadata: { videoCallUrl },
      source: input.source,
      notetaker: { ...notetaker, sessionId: randomUUID(), transcriptId: input.transcriptId },
    },
  }
}

export function buildLegacyTranscriptEvent(input: { uid: string; attendees: CalcomAttendeeOverride[] }): CalcomEnvelope {
  return buildBookingEvent(transcriptLegacyFixture, input)
}

export function buildProbeEvent(): CalcomEnvelope {
  return {
    triggerEvent: PROBE_TRIGGER,
    createdAt: new Date().toISOString(),
    payload: { uid: `qa-probe-${randomUUID()}` },
  }
}

export async function postCalcomWebhook(
  request: APIRequestContext,
  body: unknown,
  options: { secret?: string; signature?: string | null } = {},
): Promise<APIResponse> {
  const rawBody = JSON.stringify(body)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [CALCOM_WEBHOOK_VERSION_HEADER]: CALCOM_WEBHOOK_VERSION,
  }
  if (options.signature !== null) {
    const signature = options.signature ?? (options.secret ? computeCalcomSignature(rawBody, options.secret) : null)
    if (signature) headers[CALCOM_SIGNATURE_HEADER] = signature
  }
  return request.post(resolveUrl(CALCOM_INBOUND_PATH), { headers, data: rawBody })
}

export async function waitForCalcomEndpointStatus(
  request: APIRequestContext,
  secret: string,
  expectedStatus: number,
): Promise<void> {
  await drainIntegrationQueue(CALCOM_EVENTS_QUEUE)
  await expect
    .poll(async () => (await postCalcomWebhook(request, buildProbeEvent(), { secret })).status(), {
      message: `Cal.com inbound endpoint should answer ${expectedStatus} for the configured secret`,
      timeout: SYNC_TIMEOUT_MS,
      intervals: ENDPOINT_POLL_INTERVALS_MS,
    })
    .toBe(expectedStatus)
}

export async function setCalcomIntegrationEnabled(
  request: APIRequestContext,
  token: string,
  isEnabled: boolean,
): Promise<void> {
  const response = await apiRequest(request, 'PUT', STATE_PATH, { token, data: { isEnabled } })
  expect(response.status(), `PUT ${STATE_PATH} should succeed`).toBe(200)
}

export async function configureCalcomIntegration(
  request: APIRequestContext,
  token: string,
  input: { secret: string; policy?: CalcomUnmatchedAttendeePolicy },
): Promise<void> {
  const credentials = await apiRequest(request, 'PUT', CREDENTIALS_PATH, {
    token,
    data: {
      credentials: {
        webhookSecret: input.secret,
        instanceUrl: CALCOM_TEST_INSTANCE_URL,
        unmatchedAttendeePolicy: input.policy ?? 'create_person',
      },
    },
  })
  expect(credentials.status(), `PUT ${CREDENTIALS_PATH} should succeed`).toBe(200)
  await setCalcomIntegrationEnabled(request, token, true)
  await waitForCalcomEndpointStatus(request, input.secret, 200)
}

export async function teardownCalcomIntegration(request: APIRequestContext, token: string | null): Promise<void> {
  if (!token) return
  await apiRequest(request, 'PUT', STATE_PATH, { token, data: { isEnabled: false } }).catch(() => undefined)
  await apiRequest(request, 'PUT', CREDENTIALS_PATH, {
    token,
    data: {
      credentials: {
        webhookSecret: `calcom-qa-retired-${randomUUID()}`,
        instanceUrl: CALCOM_TEST_INSTANCE_URL,
        unmatchedAttendeePolicy: 'create_person',
      },
    },
  }).catch(() => undefined)
}

export async function drainCalcomInbound(): Promise<void> {
  await drainIntegrationQueue(CALCOM_INBOUND_DISPATCH_QUEUE)
}

export async function waitForCalcomSync<T>(
  load: () => Promise<T>,
  isSettled: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + SYNC_TIMEOUT_MS
  let latest = await load()
  while (!isSettled(latest)) {
    if (Date.now() > deadline) {
      throw new Error(`[internal] Timed out waiting for Cal.com sync: ${label}. Last value: ${JSON.stringify(latest)}`)
    }
    await drainCalcomInbound()
    await new Promise((resolve) => setTimeout(resolve, SYNC_POLL_INTERVAL_MS))
    latest = await load()
  }
  return latest
}

export async function listMeetingInteractions(
  request: APIRequestContext,
  token: string,
  query: Record<string, string>,
): Promise<MeetingInteraction[]> {
  const params = new URLSearchParams({ interactionType: 'meeting', limit: '100', ...query })
  const response = await apiRequest(request, 'GET', `/api/customers/interactions?${params.toString()}`, { token })
  expect(response.status(), 'interactions list should be readable').toBe(200)
  const body = await readJsonSafe<{ items?: MeetingInteraction[] }>(response)
  return body?.items ?? []
}

export async function waitForMeetingInteractions(
  request: APIRequestContext,
  token: string,
  query: Record<string, string>,
  isSettled: (items: MeetingInteraction[]) => boolean,
  label: string,
): Promise<MeetingInteraction[]> {
  return waitForCalcomSync(() => listMeetingInteractions(request, token, query), isSettled, label)
}

export async function deleteMeetingInteractionsForEntity(
  request: APIRequestContext,
  token: string | null,
  entityId: string | null,
): Promise<void> {
  if (!token || !entityId) return
  const items = await listMeetingInteractions(request, token, { entityId }).catch(() => [])
  for (const item of items) {
    await deleteEntityIfExists(request, token, '/api/customers/interactions', item.id)
  }
}

export async function readPersonById(
  request: APIRequestContext,
  token: string,
  entityId: string,
): Promise<PersonListItem | null> {
  const response = await apiRequest(request, 'GET', `/api/customers/people?id=${encodeURIComponent(entityId)}`, { token })
  expect(response.status(), 'people list should be readable').toBe(200)
  const body = await readJsonSafe<{ items?: PersonListItem[] }>(response)
  return body?.items?.find((item) => item.id === entityId) ?? null
}

export async function listPersonAttachments(
  request: APIRequestContext,
  token: string,
  entityId: string,
): Promise<PersonAttachment[]> {
  const params = new URLSearchParams({ entityId: 'customers:customer_entity', recordId: entityId })
  const response = await apiRequest(request, 'GET', `/api/attachments?${params.toString()}`, { token })
  expect(response.status(), 'attachments list should be readable').toBe(200)
  const body = await readJsonSafe<{ items?: PersonAttachment[] }>(response)
  return body?.items ?? []
}

export async function listPersonComments(
  request: APIRequestContext,
  token: string,
  entityId: string,
): Promise<PersonComment[]> {
  const response = await apiRequest(
    request,
    'GET',
    `/api/customers/comments?entityId=${encodeURIComponent(entityId)}&pageSize=100`,
    { token },
  )
  expect(response.status(), 'comments list should be readable').toBe(200)
  const body = await readJsonSafe<{ items?: PersonComment[] }>(response)
  return body?.items ?? []
}

export async function deletePersonAttachmentsAndComments(
  request: APIRequestContext,
  token: string | null,
  entityId: string | null,
): Promise<void> {
  if (!token || !entityId) return
  const attachments = await listPersonAttachments(request, token, entityId).catch(() => [])
  for (const attachment of attachments) {
    await apiRequest(request, 'DELETE', `/api/attachments?id=${encodeURIComponent(attachment.id)}`, { token }).catch(() => undefined)
  }
  const comments = await listPersonComments(request, token, entityId).catch(() => [])
  for (const comment of comments) {
    await deleteEntityIfExists(request, token, '/api/customers/comments', comment.id)
  }
}

export async function listUnassignedTranscripts(
  request: APIRequestContext,
  token: string,
  query: Record<string, string> = {},
): Promise<UnassignedTranscriptListItem[]> {
  const params = new URLSearchParams({ status: 'pending', pageSize: '100', ...query })
  const response = await apiRequest(request, 'GET', `${UNASSIGNED_TRANSCRIPTS_PATH}?${params.toString()}`, { token })
  expect(response.status(), 'unassigned transcripts list should be readable').toBe(200)
  const body = await readJsonSafe<{ items?: UnassignedTranscriptListItem[] }>(response)
  return body?.items ?? []
}

export async function waitForUnassignedTranscript(
  request: APIRequestContext,
  token: string,
  transcriptId: string,
  label: string,
): Promise<UnassignedTranscriptListItem> {
  const items = await waitForCalcomSync(
    () => listUnassignedTranscripts(request, token),
    (rows) => rows.some((row) => row.transcriptId === transcriptId),
    label,
  )
  return items.find((row) => row.transcriptId === transcriptId) as UnassignedTranscriptListItem
}

export async function readUnassignedTranscript(
  request: APIRequestContext,
  token: string,
  id: string,
): Promise<UnassignedTranscriptDetail | null> {
  const response = await apiRequest(request, 'GET', `${UNASSIGNED_TRANSCRIPTS_PATH}/${encodeURIComponent(id)}`, { token })
  if (response.status() === 404) return null
  expect(response.status(), 'unassigned transcript detail should be readable').toBe(200)
  return readJsonSafe<UnassignedTranscriptDetail>(response)
}

export async function dismissUnassignedTranscript(
  request: APIRequestContext,
  token: string,
  id: string,
  updatedAt: string | null,
): Promise<APIResponse> {
  return apiRequest(request, 'DELETE', `${UNASSIGNED_TRANSCRIPTS_PATH}?id=${encodeURIComponent(id)}`, {
    token,
    headers: buildOptimisticLockHeader(updatedAt),
  })
}

export async function dismissPendingUnassignedTranscripts(
  request: APIRequestContext,
  token: string | null,
  ids: Array<string | null>,
): Promise<void> {
  if (!token) return
  for (const id of ids) {
    if (!id) continue
    const row = await readUnassignedTranscript(request, token, id).catch(() => null)
    if (row?.status !== 'pending') continue
    await dismissUnassignedTranscript(request, token, id, row.updatedAt).catch(() => undefined)
  }
}

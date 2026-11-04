import { z } from 'zod'

const nullableString = z.string().nullish()

export const calcomAttendeeSchema = z
  .object({
    name: nullableString,
    email: z.string(),
    timeZone: nullableString,
    language: z.object({ locale: nullableString }).passthrough().nullish(),
    utcOffset: z.number().nullish(),
  })
  .passthrough()

export const calcomNotetakerPassageSchema = z
  .object({
    index: z.number(),
    speakerKey: z.string(),
    speakerName: nullableString,
    unknownSpeakerNumber: z.number().nullish(),
    startMs: z.number(),
    endMs: z.number(),
    text: z.string(),
  })
  .passthrough()

export const calcomNotetakerSummarySchema = z
  .object({
    status: z.enum(['READY', 'FAILED']),
    language: nullableString,
    overview: nullableString,
    keyPoints: z.array(z.unknown()).nullish(),
    decisions: z.array(z.unknown()).nullish(),
    actionItems: z.array(z.unknown()).nullish(),
    topics: z.array(z.unknown()).nullish(),
  })
  .passthrough()

export const calcomNotetakerSchema = z
  .object({
    version: z.number(),
    sessionId: z.string(),
    transcriptId: z.string(),
    language: nullableString,
    completeness: z.enum(['COMPLETE', 'PARTIAL', 'TRUNCATED']).catch('PARTIAL').nullish(),
    durationMs: z.number().nullish(),
    speakerNamesAvailable: z.boolean().nullish(),
    passages: z.array(calcomNotetakerPassageSchema),
    summary: calcomNotetakerSummarySchema.nullish(),
  })
  .passthrough()

export const calcomBookingSchema = z
  .object({
    uid: nullableString,
    bookingId: z.number().nullish(),
    title: nullableString,
    description: nullableString,
    additionalNotes: nullableString,
    startTime: nullableString,
    endTime: nullableString,
    length: z.number().nullish(),
    organizer: calcomAttendeeSchema.partial().nullish(),
    attendees: z.array(calcomAttendeeSchema).nullish(),
    location: nullableString,
    videoCallData: z.object({ url: nullableString }).passthrough().nullish(),
    metadata: z.object({ videoCallUrl: nullableString }).passthrough().nullish(),
    rescheduleUid: nullableString,
    cancellationReason: nullableString,
    status: nullableString,
    eventTypeId: z.number().nullish(),
    type: nullableString,
    source: z.enum(['booking', 'ad_hoc', 'calendar_auto_join']).catch('booking').nullish(),
    user: z
      .object({
        email: nullableString,
        name: nullableString,
        timeZone: nullableString,
      })
      .passthrough()
      .nullish(),
  })
  .passthrough()

export type CalcomAttendee = z.infer<typeof calcomAttendeeSchema>
export type CalcomBooking = z.infer<typeof calcomBookingSchema>
export type CalcomNotetaker = z.infer<typeof calcomNotetakerSchema>

export type ParsedCalcomWebhook = {
  trigger: string
  createdAt: string | null
  booking: CalcomBooking
  notetaker: CalcomNotetaker | null
}

const TRANSCRIPT_TRIGGER = 'RECORDING_TRANSCRIPTION_GENERATED'
const MEETING_ENDED_TRIGGER = 'MEETING_ENDED'
const MAX_LOCATION_LENGTH = 500

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function normalizeBody(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'string') {
    try {
      return asRecord(JSON.parse(body))
    } catch {
      return null
    }
  }
  return asRecord(body)
}

function readHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key]
  }
  return undefined
}

function readTrigger(body: Record<string, unknown> | null, headers?: Record<string, string>): string | null {
  const fromBody = asNonEmptyString(body?.triggerEvent)
  if (fromBody) return fromBody
  return asNonEmptyString(readHeader(headers, 'x-cal-trigger-event'))
}

function deriveOrganizerFromUser(booking: CalcomBooking): CalcomBooking {
  if (booking.organizer || !booking.user?.email) return booking
  return {
    ...booking,
    organizer: {
      name: booking.user.name ?? null,
      email: booking.user.email,
      timeZone: booking.user.timeZone ?? null,
    },
  }
}

export function parseCalcomWebhook(data: Record<string, unknown>): ParsedCalcomWebhook {
  const trigger = readTrigger(data) ?? 'unknown'
  const envelopePayload = asRecord(data.payload)
  const createdAt = asNonEmptyString(data.createdAt)
  if (envelopePayload) {
    const booking = calcomBookingSchema.parse(envelopePayload)
    const notetakerRaw = envelopePayload.notetaker
    const notetaker = notetakerRaw ? calcomNotetakerSchema.safeParse(notetakerRaw) : null
    return {
      trigger,
      createdAt,
      booking,
      notetaker: notetaker?.success ? notetaker.data : null,
    }
  }
  const { triggerEvent: _triggerEvent, ...flat } = data
  const booking = deriveOrganizerFromUser(calcomBookingSchema.parse(flat))
  return { trigger, createdAt, booking, notetaker: null }
}

export function extractBookingUid(booking: CalcomBooking): string | null {
  return asNonEmptyString(booking.uid)
}

export function resolveMeetingLocation(booking: CalcomBooking): string | null {
  const videoCallUrl = asNonEmptyString(booking.metadata?.videoCallUrl)
  const location = asNonEmptyString(booking.location)
  const candidate =
    videoCallUrl
    ?? (location && !location.startsWith('integrations:') ? location : null)
    ?? asNonEmptyString(booking.videoCallData?.url)
  return candidate ? candidate.slice(0, MAX_LOCATION_LENGTH) : null
}

export function extractCalcomEventType(body: unknown, headers?: Record<string, string>): string {
  return readTrigger(normalizeBody(body), headers) ?? 'unknown'
}

export function extractCalcomMessageId(body: unknown, headers?: Record<string, string>): string | undefined {
  const record = normalizeBody(body)
  if (!record) return undefined
  const trigger = readTrigger(record, headers)
  if (!trigger) return undefined
  const envelopePayload = asRecord(record.payload)
  if (!envelopePayload) {
    const flatUid = asNonEmptyString(record.uid)
    return trigger === MEETING_ENDED_TRIGGER && flatUid ? `calcom:${MEETING_ENDED_TRIGGER}:${flatUid}` : undefined
  }
  if (trigger === TRANSCRIPT_TRIGGER) {
    const transcriptId = asNonEmptyString(asRecord(envelopePayload.notetaker)?.transcriptId)
    if (transcriptId) return `calcom:transcript:${transcriptId}`
  }
  const uid = asNonEmptyString(envelopePayload.uid)
  const createdAt = asNonEmptyString(record.createdAt)
  if (!uid || !createdAt) return undefined
  return `calcom:${trigger}:${uid}:${createdAt}`
}

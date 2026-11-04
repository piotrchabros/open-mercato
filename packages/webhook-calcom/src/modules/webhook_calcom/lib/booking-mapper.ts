import type { z } from 'zod'
import type { interactionCreateSchema } from '@open-mercato/core/modules/customers/data/validators'
import { CALCOM_PERSON_SOURCE, MAX_INTERACTION_BODY_CHARS } from './constants'
import { resolveMeetingLocation, type CalcomBooking } from './payload'

type InteractionCreateInput = z.input<typeof interactionCreateSchema>

const MAX_TITLE_LENGTH = 500
const MAX_PARTICIPANT_NAME_LENGTH = 200
const MAX_PARTICIPANT_EMAIL_LENGTH = 320
const MEETING_INTERACTION_TYPE = 'meeting'
const PLANNED_STATUS = 'planned'

export type CalcomInteractionParticipant = {
  userId?: string
  name?: string
  email?: string
  status?: string
}

export type CalcomLinkedEntity = { id: string; type: 'person'; label: string }

export type CalcomInteractionFields = {
  entityId: string
  interactionType: string
  title: string
  body: string | null
  scheduledAt: string | null
  durationMinutes: number | null
  timezone: string | null
  location: string | null
  participants: CalcomInteractionParticipant[]
  ownerUserId: string | null
  authorUserId: string | null
  source: string
  linkedEntities: CalcomLinkedEntity[]
  status: string
}

type AssignableToCreateInput = Pick<
  InteractionCreateInput,
  keyof CalcomInteractionFields & keyof InteractionCreateInput
>

export const calcomInteractionFieldsAreCreateInput = (
  fields: CalcomInteractionFields,
): AssignableToCreateInput => fields

export type CalcomBookingMapContext = {
  entityId: string
  linkedEntities: CalcomLinkedEntity[]
  ownerUserId: string | null
  organizerParticipant: CalcomInteractionParticipant
  fallbackTitle: string
}

export type CalcomSchedulingFields = Pick<
  CalcomInteractionFields,
  'scheduledAt' | 'durationMinutes' | 'timezone' | 'location' | 'participants'
>

function cleanText(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function resolveDurationMinutes(booking: CalcomBooking): number | null {
  const start = booking.startTime ? new Date(booking.startTime).getTime() : Number.NaN
  const end = booking.endTime ? new Date(booking.endTime).getTime() : Number.NaN
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return Math.round((end - start) / 60000)
  }
  if (typeof booking.length === 'number' && Number.isFinite(booking.length) && booking.length >= 0) {
    return Math.round(booking.length)
  }
  return null
}

function resolveTimezone(booking: CalcomBooking): string | null {
  const candidate = cleanText(booking.organizer?.timeZone)
  if (!candidate || candidate.length > 120 || /^[+-]/.test(candidate)) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format()
    return candidate
  } catch {
    return null
  }
}

function resolveBody(booking: CalcomBooking): string | null {
  const parts = [cleanText(booking.description), cleanText(booking.additionalNotes)].filter(
    (part): part is string => part !== null,
  )
  if (parts.length === 0) return null
  return parts.join('\n\n').slice(0, MAX_INTERACTION_BODY_CHARS).trim() || null
}

function resolveParticipants(
  booking: CalcomBooking,
  organizerParticipant: CalcomInteractionParticipant,
): CalcomInteractionParticipant[] {
  const participants: CalcomInteractionParticipant[] = [organizerParticipant]
  const seen = new Set<string>()
  const organizerEmail = organizerParticipant.email?.toLowerCase()
  if (organizerEmail) seen.add(organizerEmail)
  for (const attendee of booking.attendees ?? []) {
    const email = cleanText(attendee.email)?.slice(0, MAX_PARTICIPANT_EMAIL_LENGTH)
    if (!email) continue
    const key = email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const name = cleanText(attendee.name)?.slice(0, MAX_PARTICIPANT_NAME_LENGTH)
    participants.push(name ? { name, email } : { email })
  }
  return participants
}

export function mapBookingToInteraction(
  booking: CalcomBooking,
  ctx: CalcomBookingMapContext,
): CalcomInteractionFields {
  return {
    entityId: ctx.entityId,
    interactionType: MEETING_INTERACTION_TYPE,
    title: (cleanText(booking.title) ?? ctx.fallbackTitle).slice(0, MAX_TITLE_LENGTH),
    body: resolveBody(booking),
    scheduledAt: toIsoOrNull(booking.startTime),
    durationMinutes: resolveDurationMinutes(booking),
    timezone: resolveTimezone(booking),
    location: resolveMeetingLocation(booking),
    participants: resolveParticipants(booking, ctx.organizerParticipant),
    ownerUserId: ctx.ownerUserId,
    authorUserId: ctx.ownerUserId,
    source: CALCOM_PERSON_SOURCE,
    linkedEntities: ctx.linkedEntities,
    status: PLANNED_STATUS,
  }
}

export function pickSchedulingFields(fields: CalcomInteractionFields): CalcomSchedulingFields {
  return {
    scheduledAt: fields.scheduledAt,
    durationMinutes: fields.durationMinutes,
    timezone: fields.timezone,
    location: fields.location,
    participants: fields.participants,
  }
}

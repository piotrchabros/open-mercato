import bookingCreated from './fixtures/booking-created.json'
import bookingRescheduled from './fixtures/booking-rescheduled.json'
import { mapBookingToInteraction, pickSchedulingFields } from '../lib/booking-mapper'
import { parseCalcomWebhook, type CalcomBooking } from '../lib/payload'

type Body = Record<string, unknown>

const ctx = {
  entityId: '11111111-1111-4111-8111-111111111111',
  linkedEntities: [{ id: '11111111-1111-4111-8111-111111111111', type: 'person' as const, label: 'Anna Kowalska' }],
  ownerUserId: '22222222-2222-4222-8222-222222222222',
  organizerParticipant: { userId: '22222222-2222-4222-8222-222222222222', name: 'Piotr Host', email: 'host@example.com' },
  fallbackTitle: 'Cal.com meeting',
}

function booking(overrides: Partial<CalcomBooking> = {}): CalcomBooking {
  return { ...parseCalcomWebhook(bookingCreated as Body).booking, ...overrides }
}

describe('mapBookingToInteraction', () => {
  it('maps a created booking', () => {
    const fields = mapBookingToInteraction(booking(), ctx)
    expect(fields).toMatchObject({
      entityId: ctx.entityId,
      interactionType: 'meeting',
      title: 'Discovery call between Piotr and Anna',
      body: 'Intro call\n\nPlease share the deck',
      scheduledAt: '2026-11-10T10:00:00.000Z',
      durationMinutes: 30,
      timezone: 'Europe/Warsaw',
      location: 'https://cal.example.com/video/bk-uid-1',
      ownerUserId: ctx.ownerUserId,
      authorUserId: ctx.ownerUserId,
      source: 'calcom',
      status: 'planned',
      linkedEntities: ctx.linkedEntities,
    })
    expect(fields.participants).toEqual([
      ctx.organizerParticipant,
      { name: 'Anna Kowalska', email: 'anna@example.com' },
      { name: 'Ben Nowak', email: 'ben@example.com' },
    ])
  })

  it('maps a rescheduled booking to the new time', () => {
    const parsed = parseCalcomWebhook(bookingRescheduled as Body).booking
    const fields = mapBookingToInteraction(parsed, ctx)
    expect(fields.scheduledAt).toBe('2026-11-12T14:00:00.000Z')
    expect(fields.durationMinutes).toBe(30)
  })

  it('dedupes participants by email, including the organizer', () => {
    const fields = mapBookingToInteraction(
      booking({
        attendees: [
          { name: 'Host', email: 'HOST@example.com' },
          { name: 'Anna', email: 'anna@example.com' },
          { name: 'Anna again', email: 'ANNA@example.com' },
        ],
      }),
      ctx,
    )
    expect(fields.participants.map((participant) => participant.email)).toEqual(['host@example.com', 'anna@example.com'])
  })

  it('truncates title and body and nulls an empty body', () => {
    const long = mapBookingToInteraction(
      booking({ title: 'T'.repeat(900), description: 'a'.repeat(9000), additionalNotes: 'b'.repeat(9000) }),
      ctx,
    )
    expect(long.title).toHaveLength(500)
    expect(long.body).toHaveLength(10000)
    const empty = mapBookingToInteraction(booking({ description: ' ', additionalNotes: null, title: null }), ctx)
    expect(empty.body).toBeNull()
    expect(empty.title).toBe('Cal.com meeting')
  })

  it('uses length when endTime is missing', () => {
    const fields = mapBookingToInteraction(booking({ endTime: null, length: 45 }), ctx)
    expect(fields.durationMinutes).toBe(45)
  })

  it('skips integrations:* location and invalid timezone', () => {
    const fields = mapBookingToInteraction(
      booking({
        location: 'integrations:daily',
        metadata: null,
        videoCallData: null,
        organizer: { name: 'Host', email: 'host@example.com', timeZone: 'Not/AZone' },
      }),
      ctx,
    )
    expect(fields.location).toBeNull()
    expect(fields.timezone).toBeNull()
  })
})

describe('pickSchedulingFields', () => {
  it('returns only the reschedule subset', () => {
    const fields = mapBookingToInteraction(booking(), ctx)
    expect(Object.keys(pickSchedulingFields(fields)).sort()).toEqual(
      ['durationMinutes', 'location', 'participants', 'scheduledAt', 'timezone'],
    )
  })
})

import bookingCreated from './fixtures/booking-created.json'
import bookingRescheduled from './fixtures/booking-rescheduled.json'
import bookingCancelled from './fixtures/booking-cancelled.json'
import meetingEnded from './fixtures/meeting-ended.json'
import transcriptGenerated from './fixtures/transcript-generated.json'
import transcriptLegacy from './fixtures/transcript-legacy-daily.json'
import {
  extractBookingUid,
  extractCalcomEventType,
  extractCalcomMessageId,
  parseCalcomWebhook,
  resolveMeetingLocation,
  type CalcomBooking,
} from '../lib/payload'

type Body = Record<string, unknown>

describe('parseCalcomWebhook', () => {
  it('parses enveloped booking created', () => {
    const parsed = parseCalcomWebhook(bookingCreated as Body)
    expect(parsed.trigger).toBe('BOOKING_CREATED')
    expect(parsed.createdAt).toBe('2026-11-04T09:00:00.000Z')
    expect(parsed.notetaker).toBeNull()
    expect(extractBookingUid(parsed.booking)).toBe('bk-uid-1')
    expect(parsed.booking.attendees?.map((a) => a.email)).toEqual(['anna@example.com', 'ben@example.com'])
    expect(parsed.booking.organizer?.email).toBe('host@example.com')
  })

  it('keeps rescheduleUid and cancellationReason', () => {
    expect(parseCalcomWebhook(bookingRescheduled as Body).booking.rescheduleUid).toBe('bk-uid-1')
    expect(parseCalcomWebhook(bookingCancelled as Body).booking.cancellationReason).toBe('Attendee unavailable')
  })

  it('parses flat MEETING_ENDED and derives organizer from user', () => {
    const parsed = parseCalcomWebhook(meetingEnded as Body)
    expect(parsed.trigger).toBe('MEETING_ENDED')
    expect(extractBookingUid(parsed.booking)).toBe('bk-uid-1')
    expect(parsed.booking.organizer).toEqual({ name: 'Piotr Host', email: 'host@example.com', timeZone: 'Europe/Warsaw' })
    expect(parsed.booking.endTime).toBe('2026-11-10T10:30:00.000Z')
    expect(parsed.booking.attendees).toHaveLength(2)
  })

  it('parses the notetaker block including unknown speakers and summary', () => {
    const parsed = parseCalcomWebhook(transcriptGenerated as Body)
    expect(parsed.notetaker?.transcriptId).toBe('22222222-2222-4222-8222-222222222222')
    expect(parsed.notetaker?.passages).toHaveLength(3)
    expect(parsed.notetaker?.passages[2]).toMatchObject({ speakerName: null, unknownSpeakerNumber: 1 })
    expect(parsed.notetaker?.summary?.status).toBe('READY')
  })

  it.each([
    ['TRUNCATED', 'TRUNCATED'],
    ['PARTIAL', 'PARTIAL'],
    ['COMPLETE', 'COMPLETE'],
    ['SOMETHING_NEW', 'PARTIAL'],
  ])('maps notetaker completeness %s to %s without rejecting the block', (input, expected) => {
    const body = JSON.parse(JSON.stringify(transcriptGenerated))
    body.payload.notetaker.completeness = input
    expect(parseCalcomWebhook(body as Body).notetaker?.completeness).toBe(expected)
  })

  it('returns null notetaker for legacy Daily payloads and for invalid blocks', () => {
    expect(parseCalcomWebhook(transcriptLegacy as Body).notetaker).toBeNull()
    const broken = { triggerEvent: 'RECORDING_TRANSCRIPTION_GENERATED', payload: { uid: 'x', notetaker: { version: 1 } } }
    expect(parseCalcomWebhook(broken).notetaker).toBeNull()
  })
})

describe('notetaker meeting payloads', () => {
  const notetakerMeeting = (source: unknown) => ({
    triggerEvent: 'BOOKING_CREATED',
    createdAt: '2026-11-04T09:00:00.000Z',
    payload: {
      type: 'notetaker_meeting',
      uid: 'nm-uid-1',
      bookingId: 7,
      eventTypeId: null,
      status: 'ACCEPTED',
      title: 'Ad-hoc call',
      startTime: '2026-11-10T10:00:00.000Z',
      endTime: '2026-11-10T10:30:00.000Z',
      organizer: { name: 'Host', email: 'host@example.com', timeZone: 'Europe/Warsaw', language: { locale: 'en' } },
      attendees: [],
      location: null,
      source,
    },
  })

  it('accepts no-event-type bookings with empty attendees', () => {
    const parsed = parseCalcomWebhook(notetakerMeeting('ad_hoc'))
    expect(parsed.booking).toMatchObject({ type: 'notetaker_meeting', eventTypeId: null, attendees: [], source: 'ad_hoc' })
    expect(extractBookingUid(parsed.booking)).toBe('nm-uid-1')
  })

  it.each([
    ['calendar_auto_join', 'calendar_auto_join'],
    ['booking', 'booking'],
    ['something_new', 'booking'],
  ])('maps source %s to %s', (input, expected) => {
    expect(parseCalcomWebhook(notetakerMeeting(input)).booking.source).toBe(expected)
  })

  it('leaves source absent on regular bookings', () => {
    expect(parseCalcomWebhook(bookingCreated as Body).booking.source).toBeUndefined()
    expect(parseCalcomWebhook(notetakerMeeting(null)).booking.source).toBeNull()
  })
})

describe('resolveMeetingLocation', () => {
  const base = (overrides: Partial<CalcomBooking>): CalcomBooking => ({ uid: 'u', ...overrides }) as CalcomBooking

  it('prefers metadata.videoCallUrl', () => {
    expect(resolveMeetingLocation(base({ metadata: { videoCallUrl: 'https://v/1' }, location: 'Office' }))).toBe('https://v/1')
  })
  it('uses location when not an integration', () => {
    expect(resolveMeetingLocation(base({ location: 'Office 5' }))).toBe('Office 5')
  })
  it('falls back to videoCallData.url for integrations locations', () => {
    expect(resolveMeetingLocation(base({ location: 'integrations:daily', videoCallData: { url: 'https://v/2' } }))).toBe('https://v/2')
  })
  it('returns null when nothing usable and caps length', () => {
    expect(resolveMeetingLocation(base({ location: 'integrations:daily' }))).toBeNull()
    expect(resolveMeetingLocation(base({ location: 'x'.repeat(600) }))).toHaveLength(500)
  })
})

describe('extractors', () => {
  it('reads event type from body, string body and header fallback', () => {
    expect(extractCalcomEventType(bookingCreated, {})).toBe('BOOKING_CREATED')
    expect(extractCalcomEventType(meetingEnded, {})).toBe('MEETING_ENDED')
    expect(extractCalcomEventType(JSON.stringify(bookingCreated), {})).toBe('BOOKING_CREATED')
    expect(extractCalcomEventType({}, { 'x-cal-trigger-event': 'BOOKING_PAID' })).toBe('BOOKING_PAID')
    expect(extractCalcomEventType({}, {})).toBe('unknown')
    expect(extractCalcomEventType('not json', {})).toBe('unknown')
  })

  it('builds message ids per shape', () => {
    expect(extractCalcomMessageId(bookingCreated, {})).toBe('calcom:BOOKING_CREATED:bk-uid-1:2026-11-04T09:00:00.000Z')
    expect(extractCalcomMessageId(meetingEnded, {})).toBe('calcom:MEETING_ENDED:bk-uid-1')
    expect(extractCalcomMessageId(transcriptGenerated, {})).toBe('calcom:transcript:22222222-2222-4222-8222-222222222222')
    expect(extractCalcomMessageId(transcriptLegacy, {})).toBe('calcom:RECORDING_TRANSCRIPTION_GENERATED:bk-uid-1:2026-11-10T11:00:00.000Z')
    expect(extractCalcomMessageId({}, {})).toBeUndefined()
  })
})

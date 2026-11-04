import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createPersonFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  INTERACTION_STATUS_CANCELED,
  INTERACTION_STATUS_COMPLETED,
  INTERACTION_STATUS_PLANNED,
} from '@open-mercato/core/modules/customers/lib/interactionStatus'
import {
  CALCOM_FIXTURE_START_TIME,
  CALCOM_FIXTURE_TITLE,
  buildBookingCancelledEvent,
  buildBookingCreatedEvent,
  buildBookingRescheduledEvent,
  buildMeetingEndedEvent,
  calcomTestEmail,
  calcomVideoUrl,
  configureCalcomIntegration,
  deleteMeetingInteractionsForEntity,
  drainCalcomInbound,
  listMeetingInteractions,
  postCalcomWebhook,
  teardownCalcomIntegration,
  uniqueCalcomSuffix,
  waitForMeetingInteractions,
} from './helpers/calcom'

const RESCHEDULED_START_TIME = '2026-11-12T14:00:00.000Z'
const RESCHEDULED_END_TIME = '2026-11-12T14:30:00.000Z'

function toIso(value: string | null): string | null {
  return value ? new Date(value).toISOString() : null
}

/**
 * TC-CALCOM-001: Cal.com booking lifecycle
 *
 * Drives the signed inbound endpoint (POST /api/webhooks/inbound/calcom) through
 * BOOKING_CREATED -> duplicate replay -> BOOKING_RESCHEDULED -> BOOKING_CANCELLED,
 * plus a second booking closed by the flat MEETING_ENDED payload, and asserts the
 * meeting interactions that land on a person matched by attendee email.
 * Source: .ai/specs/2026-11-04-calcom-crm-integration.md (Integration test coverage)
 */
test.describe('TC-CALCOM-001: Cal.com booking lifecycle', () => {
  test('syncs created, rescheduled, cancelled and ended bookings onto a matched person', async ({ request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueCalcomSuffix()
    const secret = `calcom-qa-secret-${suffix}`
    const personEmail = calcomTestEmail('person', suffix)
    const attendees = [
      { name: 'Anna Kowalska', email: personEmail },
      { name: 'Ben Nowak', email: calcomTestEmail('guest', suffix) },
    ]
    const firstUid = `qa-booking-${suffix}-1`
    const rescheduledUid = `qa-booking-${suffix}-2`
    const endedUid = `qa-booking-${suffix}-3`

    let personId: string | null = null
    let configured = false
    try {
      personId = await createPersonFixture(request, token, {
        firstName: 'Anna',
        lastName: 'Kowalska',
        displayName: `Anna Kowalska ${suffix}`,
        primaryEmail: personEmail,
      })
      await configureCalcomIntegration(request, token, { secret })
      configured = true

      const created = buildBookingCreatedEvent({ uid: firstUid, attendees })
      const createdResponse = await postCalcomWebhook(request, created, { secret })
      expect(createdResponse.status(), 'a signed BOOKING_CREATED should be accepted').toBe(200)
      expect(await readJsonSafe(createdResponse)).toEqual({ ok: true })

      const [planned] = await waitForMeetingInteractions(
        request,
        token,
        { entityId: personId },
        (items) => items.length === 1,
        'BOOKING_CREATED should create exactly one meeting interaction',
      )
      expect(planned.status).toBe(INTERACTION_STATUS_PLANNED)
      expect(planned.title).toBe(CALCOM_FIXTURE_TITLE)
      expect(toIso(planned.scheduledAt)).toBe(toIso(CALCOM_FIXTURE_START_TIME))
      expect(planned.durationMinutes).toBe(30)
      expect(planned.location).toBe(calcomVideoUrl(firstUid))
      expect(planned.source).toBe('calcom')

      const replayResponse = await postCalcomWebhook(request, created, { secret })
      expect(replayResponse.status(), 'a replayed delivery should still be acknowledged').toBe(200)
      expect(await readJsonSafe(replayResponse)).toEqual({ ok: true, duplicate: true })
      await drainCalcomInbound()
      expect(
        (await listMeetingInteractions(request, token, { entityId: personId })).length,
        'a replayed BOOKING_CREATED must not create a second interaction',
      ).toBe(1)

      const rescheduled = buildBookingRescheduledEvent({
        uid: rescheduledUid,
        rescheduleUid: firstUid,
        attendees,
        startTime: RESCHEDULED_START_TIME,
        endTime: RESCHEDULED_END_TIME,
      })
      const rescheduledResponse = await postCalcomWebhook(request, rescheduled, { secret })
      expect(rescheduledResponse.status()).toBe(200)
      const [moved] = await waitForMeetingInteractions(
        request,
        token,
        { entityId: personId },
        (items) => items.length === 1 && toIso(items[0].scheduledAt) === RESCHEDULED_START_TIME,
        'BOOKING_RESCHEDULED should move the existing interaction',
      )
      expect(moved.id, 'a reschedule keyed by rescheduleUid must update the same interaction').toBe(planned.id)
      expect(moved.status).toBe(INTERACTION_STATUS_PLANNED)
      expect(moved.location).toBe(calcomVideoUrl(rescheduledUid))

      const cancelled = buildBookingCancelledEvent({ uid: rescheduledUid, attendees })
      const cancelledResponse = await postCalcomWebhook(request, cancelled, { secret })
      expect(cancelledResponse.status()).toBe(200)
      const [canceled] = await waitForMeetingInteractions(
        request,
        token,
        { entityId: personId },
        (items) => items.length === 1 && items[0].status === INTERACTION_STATUS_CANCELED,
        'BOOKING_CANCELLED should cancel the interaction',
      )
      expect(canceled.id).toBe(planned.id)

      const second = buildBookingCreatedEvent({ uid: endedUid, attendees })
      const secondResponse = await postCalcomWebhook(request, second, { secret })
      expect(secondResponse.status()).toBe(200)
      const afterSecond = await waitForMeetingInteractions(
        request,
        token,
        { entityId: personId },
        (items) => items.length === 2,
        'a second BOOKING_CREATED should create a second interaction',
      )
      const secondPlanned = afterSecond.find((item) => item.id !== planned.id)
      expect(secondPlanned?.status).toBe(INTERACTION_STATUS_PLANNED)
      expect(secondPlanned?.location).toBe(calcomVideoUrl(endedUid))

      const ended = buildMeetingEndedEvent({ uid: endedUid, attendees })
      const endedResponse = await postCalcomWebhook(request, ended, { secret })
      expect(endedResponse.status(), 'the flat MEETING_ENDED payload should be accepted').toBe(200)
      const afterEnded = await waitForMeetingInteractions(
        request,
        token,
        { entityId: personId },
        (items) => items.some((item) => item.id === secondPlanned?.id && item.status === INTERACTION_STATUS_COMPLETED),
        'MEETING_ENDED should complete the second interaction',
      )
      expect(afterEnded.find((item) => item.id === planned.id)?.status, 'the cancelled meeting stays cancelled').toBe(
        INTERACTION_STATUS_CANCELED,
      )
    } finally {
      await deleteMeetingInteractionsForEntity(request, token, personId)
      await deleteEntityIfExists(request, token, '/api/customers/people', personId)
      if (configured) await teardownCalcomIntegration(request, token)
    }
  })
})

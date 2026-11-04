import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures'
import { INTERACTION_STATUS_PLANNED } from '@open-mercato/core/modules/customers/lib/interactionStatus'
import { calcomInteractionId } from '../lib/ids'
import {
  buildBookingCreatedEvent,
  calcomTestEmail,
  configureCalcomIntegration,
  deleteMeetingInteractionsForEntity,
  postCalcomWebhook,
  readPersonById,
  teardownCalcomIntegration,
  uniqueCalcomSuffix,
  waitForMeetingInteractions,
} from './helpers/calcom'

const SCHEDULE_WINDOW_BASE_MS = Date.UTC(2031, 0, 1)
const SCHEDULE_WINDOW_SPREAD_MINUTES = 2_000_000
const MINUTE_MS = 60_000

/**
 * Picks a per-run meeting time nobody else schedules at, so the interaction can
 * be located by its exact scheduling window without knowing the person up front.
 */
function uniqueScheduleWindow(): { startTime: string; endTime: string; from: string; to: string } {
  const start = SCHEDULE_WINDOW_BASE_MS + Math.floor(Math.random() * SCHEDULE_WINDOW_SPREAD_MINUTES) * MINUTE_MS
  return {
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + 30 * MINUTE_MS).toISOString(),
    from: new Date(start).toISOString(),
    to: new Date(start + MINUTE_MS - 1).toISOString(),
  }
}

/**
 * TC-CALCOM-003: Cal.com unmatched attendee creates a person
 *
 * With the default `create_person` policy a booking whose attendees match no
 * existing person creates one from the FIRST attendee (source `calcom`) and
 * makes it the meeting's entity; the other unknown attendee stays a plain
 * participant. The interaction id is deterministic (UUIDv5 of tenant, org and
 * booking uid), so the test finds it by id inside a unique scheduling window.
 * Source: .ai/specs/2026-11-04-calcom-crm-integration.md (Integration test coverage)
 */
test.describe('TC-CALCOM-003: Cal.com unmatched attendee', () => {
  test('creates a calcom-sourced person from the first attendee and links the meeting to it', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const { tenantId, organizationId } = getTokenContext(token)
    const suffix = uniqueCalcomSuffix()
    const secret = `calcom-qa-secret-${suffix}`
    const attendeeEmail = calcomTestEmail('unknown', suffix)
    const uid = `qa-booking-${suffix}-unmatched`
    const expectedInteractionId = calcomInteractionId(tenantId, organizationId, uid)
    const window = uniqueScheduleWindow()

    let personId: string | null = null
    let configured = false
    try {
      await configureCalcomIntegration(request, token, { secret, policy: 'create_person' })
      configured = true

      const created = buildBookingCreatedEvent({
        uid,
        attendees: [
          { name: 'Anna Kowalska', email: attendeeEmail },
          { name: 'Ben Nowak', email: calcomTestEmail('guest', suffix) },
        ],
        startTime: window.startTime,
        endTime: window.endTime,
      })
      const response = await postCalcomWebhook(request, created, { secret })
      expect(response.status(), 'a signed BOOKING_CREATED should be accepted').toBe(200)

      const items = await waitForMeetingInteractions(
        request,
        token,
        { from: window.from, to: window.to },
        (candidates) => candidates.some((item) => item.id === expectedInteractionId),
        'BOOKING_CREATED for an unknown attendee should still create the meeting',
      )
      const interaction = items.find((item) => item.id === expectedInteractionId)
      expect(interaction?.status).toBe(INTERACTION_STATUS_PLANNED)
      expect(interaction?.entityId, 'the meeting must be attached to the newly created person').toBeTruthy()
      expect(interaction?.linkedEntities ?? [], 'the second unknown attendee is not turned into a person').toEqual([])
      personId = interaction?.entityId ?? null

      const person = await readPersonById(request, token, personId as string)
      expect(person, 'the created person is readable through the people API').not.toBeNull()
      expect(person?.source).toBe('calcom')
      expect(person?.primary_email).toBe(attendeeEmail)
      expect(person?.display_name).toBe('Anna Kowalska')
    } finally {
      await deleteMeetingInteractionsForEntity(request, token, personId)
      await deleteEntityIfExists(request, token, '/api/customers/people', personId)
      if (configured) await teardownCalcomIntegration(request, token)
    }
  })
})

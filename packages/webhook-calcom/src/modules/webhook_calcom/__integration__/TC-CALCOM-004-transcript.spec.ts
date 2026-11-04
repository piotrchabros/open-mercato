import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { createPersonFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  INTERACTION_STATUS_COMPLETED,
  INTERACTION_STATUS_PLANNED,
} from '@open-mercato/core/modules/customers/lib/interactionStatus'
import {
  CALCOM_FIXTURE_SUMMARY_OVERVIEW,
  buildBookingCreatedEvent,
  buildLegacyTranscriptEvent,
  buildTranscriptEvent,
  calcomTestEmail,
  configureCalcomIntegration,
  deleteMeetingInteractionsForEntity,
  deletePersonAttachmentsAndComments,
  dismissPendingUnassignedTranscripts,
  drainCalcomInbound,
  listMeetingInteractions,
  listPersonAttachments,
  listPersonComments,
  postCalcomWebhook,
  teardownCalcomIntegration,
  uniqueCalcomSuffix,
  waitForCalcomSync,
  waitForMeetingInteractions,
  waitForUnassignedTranscript,
} from './helpers/calcom'

const INTERACTION_ASSIGNMENT_TYPE = 'customers:customer_interaction'
const SUMMARY_COMMENT_PREFIX = 'Meeting summary:'

/**
 * TC-CALCOM-004: Cal.com notetaker transcript
 *
 * RECORDING_TRANSCRIPTION_GENERATED carrying the inline `notetaker` block stores
 * the rendered `.txt` transcript as an attachment on the person (also assigned to
 * the meeting interaction), posts the READY summary as a comment on the person
 * and completes the meeting. A redelivery is deduplicated, an unknown booking whose
 * only attendee is unmatched (policy 'skip') lands in the unassigned inbox without
 * attaching anything to the person (matched unknown bookings: TC-CALCOM-005), and the legacy Daily payload without `notetaker` is a no-op.
 * Source: .ai/specs/2026-11-04-calcom-crm-integration.md (Integration test coverage)
 */
test.describe('TC-CALCOM-004: Cal.com transcript', () => {
  test('attaches the transcript, comments the summary and completes the meeting exactly once', async ({ request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueCalcomSuffix()
    const secret = `calcom-qa-secret-${suffix}`
    const personEmail = calcomTestEmail('person', suffix)
    const attendees = [
      { name: 'Anna Kowalska', email: personEmail },
      { name: 'Ben Nowak', email: calcomTestEmail('guest', suffix) },
    ]
    const uid = `qa-booking-${suffix}-transcript`
    const transcriptId = randomUUID()

    let personId: string | null = null
    let configured = false
    let unknownRowId: string | null = null
    try {
      personId = await createPersonFixture(request, token, {
        firstName: 'Anna',
        lastName: 'Kowalska',
        displayName: `Anna Kowalska ${suffix}`,
        primaryEmail: personEmail,
      })
      await configureCalcomIntegration(request, token, { secret })
      configured = true

      const createdResponse = await postCalcomWebhook(request, buildBookingCreatedEvent({ uid, attendees }), { secret })
      expect(createdResponse.status()).toBe(200)
      const [planned] = await waitForMeetingInteractions(
        request,
        token,
        { entityId: personId },
        (items) => items.length === 1,
        'BOOKING_CREATED should create the meeting the transcript attaches to',
      )
      expect(planned.status).toBe(INTERACTION_STATUS_PLANNED)

      const transcript = buildTranscriptEvent({ uid, attendees, transcriptId })
      const transcriptResponse = await postCalcomWebhook(request, transcript, { secret })
      expect(transcriptResponse.status(), 'a signed transcript delivery should be accepted').toBe(200)
      expect(await readJsonSafe(transcriptResponse)).toEqual({ ok: true })

      const [attachment] = await waitForCalcomSync(
        () => listPersonAttachments(request, token, personId as string),
        (items) => items.length === 1,
        'the transcript should be attached to the person',
      )
      expect(attachment.fileName).toMatch(/^transcript-2026-11-10-.+\.txt$/)
      expect(attachment.mimeType ?? '').toContain('text/plain')
      expect(attachment.assignments ?? []).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: INTERACTION_ASSIGNMENT_TYPE, id: planned.id })]),
      )

      const comments = await waitForCalcomSync(
        () => listPersonComments(request, token, personId as string),
        (items) => items.length === 1,
        'the READY summary should be posted as a comment on the person',
      )
      expect(comments[0].body ?? '').toMatch(new RegExp(`^${SUMMARY_COMMENT_PREFIX}`))
      expect(comments[0].body ?? '').toContain(CALCOM_FIXTURE_SUMMARY_OVERVIEW)

      const [completed] = await waitForMeetingInteractions(
        request,
        token,
        { entityId: personId },
        (items) => items.length === 1 && items[0].status === INTERACTION_STATUS_COMPLETED,
        'a transcript should complete the meeting',
      )
      expect(completed.id).toBe(planned.id)

      const replayResponse = await postCalcomWebhook(request, transcript, { secret })
      expect(replayResponse.status(), 'a redelivered transcript is acknowledged').toBe(200)
      expect(await readJsonSafe(replayResponse)).toEqual({ ok: true, duplicate: true })
      await drainCalcomInbound()
      expect((await listPersonAttachments(request, token, personId)).length, 'redelivery attaches nothing').toBe(1)
      expect((await listPersonComments(request, token, personId)).length, 'redelivery comments nothing').toBe(1)

      await configureCalcomIntegration(request, token, { secret, policy: 'skip' })
      const unknownTranscriptId = randomUUID()
      const unknownBooking = buildTranscriptEvent({
        uid: `${uid}-unknown`,
        attendees: [{ name: 'Unknown Guest', email: calcomTestEmail('unknown', suffix) }],
        transcriptId: unknownTranscriptId,
      })
      const unknownResponse = await postCalcomWebhook(request, unknownBooking, { secret })
      expect(unknownResponse.status(), 'a transcript for an unknown booking is acknowledged').toBe(200)
      expect(await readJsonSafe(unknownResponse)).toEqual({ ok: true })
      const unknownRow = await waitForUnassignedTranscript(
        request,
        token,
        unknownTranscriptId,
        'an unknown booking with only an unmatched attendee should land in the unassigned inbox',
      )
      unknownRowId = unknownRow.id
      await drainCalcomInbound()
      expect((await listPersonAttachments(request, token, personId)).length, 'unknown booking adds no attachment').toBe(1)

      const legacyResponse = await postCalcomWebhook(request, buildLegacyTranscriptEvent({ uid, attendees }), { secret })
      expect(legacyResponse.status(), 'a legacy Daily payload without notetaker is acknowledged').toBe(200)
      await drainCalcomInbound()
      expect((await listPersonAttachments(request, token, personId)).length, 'legacy payload attaches nothing').toBe(1)
      expect((await listPersonComments(request, token, personId)).length, 'legacy payload comments nothing').toBe(1)
      expect((await listMeetingInteractions(request, token, { entityId: personId })).length).toBe(1)
    } finally {
      await dismissPendingUnassignedTranscripts(request, token, [unknownRowId])
      await deletePersonAttachmentsAndComments(request, token, personId)
      await deleteMeetingInteractionsForEntity(request, token, personId)
      await deleteEntityIfExists(request, token, '/api/customers/people', personId)
      if (configured) await teardownCalcomIntegration(request, token)
    }
  })
})

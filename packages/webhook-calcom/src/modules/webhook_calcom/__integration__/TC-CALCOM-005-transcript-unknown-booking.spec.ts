import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { DEFAULT_CREDENTIALS } from '@open-mercato/core/helpers/integration/auth'
import { createPersonFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { INTERACTION_STATUS_COMPLETED } from '@open-mercato/core/modules/customers/lib/interactionStatus'
import {
  CALCOM_FIXTURE_SUMMARY_OVERVIEW,
  buildMeetingTranscriptEvent,
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
 * TC-CALCOM-005: Cal.com transcript for an unknown booking
 *
 * An ad-hoc notetaker meeting (`type: notetaker_meeting`, `eventTypeId: null`)
 * has no prior BOOKING_* event. When an attendee matches a CRM person the
 * transcript creates a completed meeting on that person, attaches the `.txt`
 * (also assigned to the meeting) and posts the READY summary as a comment.
 * Attendees that are CRM users (staff) are ignored: they neither become the
 * meeting's entity nor linked people, and a staff-only meeting lands in the
 * unassigned inbox. A redelivery is deduplicated.
 * Source: .ai/specs/2026-11-04-calcom-crm-integration.md (Integration test coverage)
 */
test.describe('TC-CALCOM-005: Cal.com transcript for an unknown booking', () => {
  test('creates a completed meeting on the matched person and ignores staff attendees', async ({ request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const staffEmail = DEFAULT_CREDENTIALS.admin.email
    const suffix = uniqueCalcomSuffix()
    const secret = `calcom-qa-secret-${suffix}`
    const personEmail = calcomTestEmail('adhoc', suffix)
    const uid = `qa-meeting-${suffix}-adhoc`
    const staffOnlyTranscriptId = randomUUID()

    let personId: string | null = null
    let staffOnlyRowId: string | null = null
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

      const transcript = buildMeetingTranscriptEvent({
        uid,
        transcriptId: randomUUID(),
        attendees: [
          { name: 'Admin Staff', email: staffEmail },
          { name: 'Anna Kowalska', email: personEmail },
        ],
        source: 'ad_hoc',
        organizerEmail: staffEmail,
      })
      const response = await postCalcomWebhook(request, transcript, { secret })
      expect(response.status(), 'a signed ad-hoc transcript delivery should be accepted').toBe(200)
      expect(await readJsonSafe(response)).toEqual({ ok: true })

      const [meeting] = await waitForMeetingInteractions(
        request,
        token,
        { entityId: personId },
        (items) => items.length === 1 && items[0].status === INTERACTION_STATUS_COMPLETED,
        'a transcript for an unknown booking should create a completed meeting on the matched person',
      )
      expect(meeting.entityId).toBe(personId)
      expect(meeting.linkedEntities ?? [], 'the staff attendee must not be linked to the meeting').toEqual([])

      const [attachment] = await waitForCalcomSync(
        () => listPersonAttachments(request, token, personId as string),
        (items) => items.length === 1,
        'the transcript should be attached to the person',
      )
      expect(attachment.fileName).toMatch(/^transcript-2026-11-10-.+\.txt$/)
      expect(attachment.mimeType ?? '').toContain('text/plain')
      expect(attachment.assignments ?? []).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: INTERACTION_ASSIGNMENT_TYPE, id: meeting.id })]),
      )

      const comments = await waitForCalcomSync(
        () => listPersonComments(request, token, personId as string),
        (items) => items.length === 1,
        'the READY summary should be posted as a comment on the person',
      )
      expect(comments[0].body ?? '').toMatch(new RegExp(`^${SUMMARY_COMMENT_PREFIX}`))
      expect(comments[0].body ?? '').toContain(CALCOM_FIXTURE_SUMMARY_OVERVIEW)

      const replayResponse = await postCalcomWebhook(request, transcript, { secret })
      expect(replayResponse.status(), 'a redelivered transcript is acknowledged').toBe(200)
      expect(await readJsonSafe(replayResponse)).toEqual({ ok: true, duplicate: true })
      await drainCalcomInbound()
      expect((await listPersonAttachments(request, token, personId)).length, 'redelivery attaches nothing').toBe(1)
      expect((await listPersonComments(request, token, personId)).length, 'redelivery comments nothing').toBe(1)
      expect((await listMeetingInteractions(request, token, { entityId: personId })).length).toBe(1)

      const staffOnly = buildMeetingTranscriptEvent({
        uid: `${uid}-staff-only`,
        transcriptId: staffOnlyTranscriptId,
        attendees: [{ name: 'Admin Staff', email: staffEmail }],
        source: 'ad_hoc',
        organizerEmail: staffEmail,
      })
      const staffOnlyResponse = await postCalcomWebhook(request, staffOnly, { secret })
      expect(staffOnlyResponse.status(), 'a staff-only transcript delivery should be accepted').toBe(200)
      const row = await waitForUnassignedTranscript(
        request,
        token,
        staffOnlyTranscriptId,
        'a meeting attended only by staff should be queued in the unassigned inbox',
      )
      staffOnlyRowId = row.id
      expect(row.reason, 'staff attendees are dropped, leaving no attendees').toBe('no_attendees')
      expect(row.source).toBe('ad_hoc')
    } finally {
      await dismissPendingUnassignedTranscripts(request, token, [staffOnlyRowId])
      await deletePersonAttachmentsAndComments(request, token, personId)
      await deleteMeetingInteractionsForEntity(request, token, personId)
      await deleteEntityIfExists(request, token, '/api/customers/people', personId)
      if (configured) await teardownCalcomIntegration(request, token)
    }
  })
})

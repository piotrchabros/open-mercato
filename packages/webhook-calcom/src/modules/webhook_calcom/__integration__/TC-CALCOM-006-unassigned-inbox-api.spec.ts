import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { DEFAULT_CREDENTIALS } from '@open-mercato/core/helpers/integration/auth'
import {
  createRoleFixture,
  createUserFixture,
  deleteRoleIfExists,
  deleteUserIfExists,
  setRoleAclFeatures,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { createPersonFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import { getTokenContext, readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { INTERACTION_STATUS_COMPLETED } from '@open-mercato/core/modules/customers/lib/interactionStatus'
import { buildOptimisticLockHeader } from '@open-mercato/ui/backend/utils/optimisticLock'
import {
  CALCOM_FIXTURE_SUMMARY_OVERVIEW,
  UNASSIGNED_TRANSCRIPTS_PATH,
  buildMeetingTranscriptEvent,
  calcomTestEmail,
  configureCalcomIntegration,
  deleteMeetingInteractionsForEntity,
  deletePersonAttachmentsAndComments,
  dismissPendingUnassignedTranscripts,
  dismissUnassignedTranscript,
  drainCalcomInbound,
  listMeetingInteractions,
  listPersonAttachments,
  listUnassignedTranscripts,
  postCalcomWebhook,
  readUnassignedTranscript,
  teardownCalcomIntegration,
  uniqueCalcomSuffix,
  waitForUnassignedTranscript,
} from './helpers/calcom'

const INTERACTION_ASSIGNMENT_TYPE = 'customers:customer_interaction'
const FIXTURE_FIRST_PASSAGE = 'Hi Anna, thanks for joining.'
const STALE_OFFSET_MS = 60_000
const RESTRICTED_USER_PASSWORD = 'Valid1!Pass'

function assignPath(id: string): string {
  return `${UNASSIGNED_TRANSCRIPTS_PATH}/${encodeURIComponent(id)}/assign`
}

function staleVersion(updatedAt: string): string {
  return new Date(Date.parse(updatedAt) - STALE_OFFSET_MS).toISOString()
}

/**
 * TC-CALCOM-006: Cal.com unassigned transcripts inbox API
 *
 * A notetaker meeting with no attendees is queued in the unassigned inbox. The
 * list/detail endpoints require `webhook_calcom.transcripts.view`; the detail
 * renders the transcript preview and summary. Assigning honors the optimistic
 * lock (stale header → 409), lands the meeting and attachment on the chosen
 * person and resolves the row; a second assign is a 409. Dismiss soft-deletes
 * a row, and a redelivery of the same transcript never creates a second row.
 * Source: .ai/specs/2026-11-04-calcom-crm-integration.md (Integration test coverage)
 */
test.describe('TC-CALCOM-006: Cal.com unassigned transcripts inbox API', () => {
  test('lists, guards, assigns and dismisses unassigned transcripts', async ({ request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const { organizationId } = getTokenContext(token)
    const organizerEmail = DEFAULT_CREDENTIALS.admin.email
    const suffix = uniqueCalcomSuffix()
    const secret = `calcom-qa-secret-${suffix}`
    const firstTranscriptId = randomUUID()
    const secondTranscriptId = randomUUID()

    let personId: string | null = null
    let roleId: string | null = null
    let userId: string | null = null
    let firstRowId: string | null = null
    let secondRowId: string | null = null
    let configured = false
    try {
      personId = await createPersonFixture(request, token, {
        firstName: 'Inbox',
        lastName: 'Target',
        displayName: `Inbox Target ${suffix}`,
        primaryEmail: calcomTestEmail('inbox', suffix),
      })
      await configureCalcomIntegration(request, token, { secret })
      configured = true

      const firstEvent = buildMeetingTranscriptEvent({
        uid: `qa-meeting-${suffix}-inbox-1`,
        transcriptId: firstTranscriptId,
        attendees: [],
        source: 'calendar_auto_join',
        organizerEmail,
      })
      const firstResponse = await postCalcomWebhook(request, firstEvent, { secret })
      expect(firstResponse.status(), 'a transcript without attendees should be accepted').toBe(200)
      const firstRow = await waitForUnassignedTranscript(
        request,
        token,
        firstTranscriptId,
        'a transcript without attendees should be queued in the inbox',
      )
      firstRowId = firstRow.id
      expect(firstRow.status).toBe('pending')
      expect(firstRow.reason).toBe('no_attendees')
      expect(firstRow.source).toBe('calendar_auto_join')

      const detail = await readUnassignedTranscript(request, token, firstRow.id)
      expect(detail, 'the queued transcript detail is readable').not.toBeNull()
      expect(detail?.transcriptPreview ?? '').toContain(FIXTURE_FIRST_PASSAGE)
      expect(detail?.summaryText ?? '').toContain(CALCOM_FIXTURE_SUMMARY_OVERVIEW)
      expect(detail?.updatedAt, 'the detail exposes updatedAt for optimistic locking').toBeTruthy()

      const replay = await postCalcomWebhook(request, firstEvent, { secret })
      expect(replay.status(), 'a redelivered transcript is acknowledged').toBe(200)
      expect(await readJsonSafe(replay)).toEqual({ ok: true, duplicate: true })
      await drainCalcomInbound()
      const afterReplay = await listUnassignedTranscripts(request, token)
      expect(
        afterReplay.filter((row) => row.transcriptId === firstTranscriptId).length,
        'a redelivery must not queue a second row',
      ).toBe(1)

      roleId = await createRoleFixture(request, token, { name: `calcom-qa-no-inbox-${suffix}` })
      await setRoleAclFeatures(request, token, {
        roleId,
        features: ['customers.people.view'],
        organizations: [organizationId],
      })
      const restrictedEmail = calcomTestEmail('restricted', suffix)
      userId = await createUserFixture(request, token, {
        email: restrictedEmail,
        password: RESTRICTED_USER_PASSWORD,
        organizationId,
        roles: [roleId],
      })
      const restrictedToken = await getAuthToken(request, restrictedEmail, RESTRICTED_USER_PASSWORD)
      const forbiddenList = await apiRequest(request, 'GET', UNASSIGNED_TRANSCRIPTS_PATH, { token: restrictedToken })
      expect(forbiddenList.status(), 'listing requires webhook_calcom.transcripts.view').toBe(403)
      const forbiddenDetail = await apiRequest(
        request,
        'GET',
        `${UNASSIGNED_TRANSCRIPTS_PATH}/${encodeURIComponent(firstRow.id)}`,
        { token: restrictedToken },
      )
      expect(forbiddenDetail.status(), 'the detail requires webhook_calcom.transcripts.view').toBe(403)

      const updatedAt = detail?.updatedAt as string
      const staleAssign = await apiRequest(request, 'POST', assignPath(firstRow.id), {
        token,
        data: { personId },
        headers: buildOptimisticLockHeader(staleVersion(updatedAt)),
      })
      expect(staleAssign.status(), 'a stale optimistic-lock header is rejected').toBe(409)
      expect((await readUnassignedTranscript(request, token, firstRow.id))?.status).toBe('pending')

      const assign = await apiRequest(request, 'POST', assignPath(firstRow.id), {
        token,
        data: { personId },
        headers: buildOptimisticLockHeader(updatedAt),
      })
      expect(assign.status(), 'assigning with a fresh header succeeds').toBe(200)
      const assigned = await readJsonSafe<{ interactionId?: string; attachmentId?: string; assignedToDifferentPerson?: boolean }>(
        assign,
      )
      expect(assigned?.interactionId).toBeTruthy()
      expect(assigned?.attachmentId).toBeTruthy()
      expect(assigned?.assignedToDifferentPerson).toBe(false)

      const pendingAfterAssign = await listUnassignedTranscripts(request, token)
      expect(pendingAfterAssign.some((row) => row.id === firstRow.id), 'the assigned row leaves the pending list').toBe(false)
      const resolved = await readUnassignedTranscript(request, token, firstRow.id)
      expect(resolved?.status).toBe('resolved')
      expect(resolved?.resolvedEntityId).toBe(personId)
      expect(resolved?.resolvedToInteractionId).toBe(assigned?.interactionId)
      expect(resolved?.resolvedAttachmentId).toBe(assigned?.attachmentId)

      const meetings = await listMeetingInteractions(request, token, { entityId: personId })
      const meeting = meetings.find((item) => item.id === assigned?.interactionId)
      expect(meeting, 'the meeting exists on the person').toBeTruthy()
      expect(meeting?.status).toBe(INTERACTION_STATUS_COMPLETED)
      const attachments = await listPersonAttachments(request, token, personId)
      const attachment = attachments.find((item) => item.id === assigned?.attachmentId)
      expect(attachment, 'the transcript attachment exists on the person').toBeTruthy()
      expect(attachment?.fileName ?? '').toMatch(/\.txt$/)
      expect(attachment?.assignments ?? []).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: INTERACTION_ASSIGNMENT_TYPE, id: assigned?.interactionId }),
        ]),
      )

      const reassign = await apiRequest(request, 'POST', assignPath(firstRow.id), {
        token,
        data: { personId },
        headers: buildOptimisticLockHeader(resolved?.updatedAt ?? null),
      })
      expect(reassign.status(), 'an already handled transcript cannot be assigned again').toBe(409)

      const secondResponse = await postCalcomWebhook(
        request,
        buildMeetingTranscriptEvent({
          uid: `qa-meeting-${suffix}-inbox-2`,
          transcriptId: secondTranscriptId,
          attendees: [],
          source: 'ad_hoc',
          organizerEmail,
        }),
        { secret },
      )
      expect(secondResponse.status()).toBe(200)
      const secondRow = await waitForUnassignedTranscript(
        request,
        token,
        secondTranscriptId,
        'the second transcript should be queued in the inbox',
      )
      secondRowId = secondRow.id
      const dismiss = await dismissUnassignedTranscript(request, token, secondRow.id, secondRow.updatedAt)
      expect(dismiss.status(), 'dismissing with a fresh header succeeds').toBe(200)
      const pendingAfterDismiss = await listUnassignedTranscripts(request, token)
      expect(pendingAfterDismiss.some((row) => row.id === secondRow.id), 'the dismissed row leaves the list').toBe(false)
      expect(await readUnassignedTranscript(request, token, secondRow.id), 'the dismissed row is gone').toBeNull()
    } finally {
      await dismissPendingUnassignedTranscripts(request, token, [firstRowId, secondRowId])
      await deleteUserIfExists(request, token, userId)
      await deleteRoleIfExists(request, token, roleId)
      await deletePersonAttachmentsAndComments(request, token, personId)
      await deleteMeetingInteractionsForEntity(request, token, personId)
      await deleteEntityIfExists(request, token, '/api/customers/people', personId)
      if (configured) await teardownCalcomIntegration(request, token)
    }
  })
})

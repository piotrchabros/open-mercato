import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { DEFAULT_CREDENTIALS, login } from '@open-mercato/core/helpers/integration/auth'
import { createPersonFixture, deleteEntityIfExists } from '@open-mercato/core/helpers/integration/crmFixtures'
import {
  buildMeetingTranscriptEvent,
  calcomTestEmail,
  configureCalcomIntegration,
  deleteMeetingInteractionsForEntity,
  deletePersonAttachmentsAndComments,
  dismissPendingUnassignedTranscripts,
  listPersonAttachments,
  postCalcomWebhook,
  teardownCalcomIntegration,
  uniqueCalcomSuffix,
  waitForCalcomSync,
  waitForUnassignedTranscript,
} from './helpers/calcom'

const INBOX_PATH = '/backend/unassigned-transcripts'
const UI_TIMEOUT_MS = 30_000

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * TC-CALCOM-007: Cal.com unassigned transcripts inbox UI
 *
 * A transcript queued via the webhook shows up in the backend inbox. An admin
 * opens it, assigns it to a person through the Assign dialog and sees the
 * success flash; the transcript then appears in the person's Files tab.
 * Source: .ai/specs/2026-11-04-calcom-crm-integration.md (Integration test coverage)
 */
test.describe('TC-CALCOM-007: Cal.com unassigned transcripts inbox UI', () => {
  test('assigns a queued transcript to a person from the inbox', async ({ page, request }) => {
    test.setTimeout(240_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueCalcomSuffix()
    const secret = `calcom-qa-secret-${suffix}`
    const transcriptId = randomUUID()
    const title = `QA inbox transcript ${suffix}`
    const personName = `Inbox Ui ${suffix}`

    let personId: string | null = null
    let rowId: string | null = null
    let configured = false
    try {
      personId = await createPersonFixture(request, token, {
        firstName: 'Inbox',
        lastName: 'Ui',
        displayName: personName,
        primaryEmail: calcomTestEmail('inbox-ui', suffix),
      })
      await configureCalcomIntegration(request, token, { secret })
      configured = true

      const response = await postCalcomWebhook(
        request,
        buildMeetingTranscriptEvent({
          uid: `qa-meeting-${suffix}-inbox-ui`,
          transcriptId,
          attendees: [],
          source: 'ad_hoc',
          organizerEmail: DEFAULT_CREDENTIALS.admin.email,
          title,
        }),
        { secret },
      )
      expect(response.status()).toBe(200)
      const row = await waitForUnassignedTranscript(request, token, transcriptId, 'the transcript should be queued')
      rowId = row.id

      await login(page, 'admin')
      await page.goto(INBOX_PATH, { waitUntil: 'domcontentloaded' })
      await page.getByRole('link', { name: title, exact: true }).click({ timeout: UI_TIMEOUT_MS })
      await expect(page).toHaveURL(new RegExp(`${escapeRegExp(INBOX_PATH)}/${row.id}`))

      await page.getByRole('button', { name: 'Assign to person', exact: true }).click({ timeout: UI_TIMEOUT_MS })
      const dialog = page.getByRole('dialog').filter({ hasText: 'Assign transcript to a person' })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('textbox', { name: 'Search people…' }).fill(personName)
      await dialog
        .getByRole('button', { name: new RegExp(escapeRegExp(personName)) })
        .first()
        .click({ timeout: UI_TIMEOUT_MS })
      await dialog.getByRole('button', { name: 'Assign', exact: true }).click()
      await expect(page.getByText(/Transcript assigned/).first()).toBeVisible({ timeout: UI_TIMEOUT_MS })

      const [attachment] = await waitForCalcomSync(
        () => listPersonAttachments(request, token, personId as string),
        (items) => items.length === 1,
        'the assigned transcript should be attached to the person',
      )
      await page.goto(`/backend/customers/people-v2/${personId}?tab=files`, { waitUntil: 'domcontentloaded' })
      const section = page.locator('[data-component-handle*="AttachmentsSection"]')
      await expect(section.getByRole('button', { name: attachment.fileName, exact: true })).toBeVisible({
        timeout: UI_TIMEOUT_MS,
      })
    } finally {
      await dismissPendingUnassignedTranscripts(request, token, [rowId])
      await deletePersonAttachmentsAndComments(request, token, personId)
      await deleteMeetingInteractionsForEntity(request, token, personId)
      await deleteEntityIfExists(request, token, '/api/customers/people', personId)
      if (configured) await teardownCalcomIntegration(request, token)
    }
  })
})

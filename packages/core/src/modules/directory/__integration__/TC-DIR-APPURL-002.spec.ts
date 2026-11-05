import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'
import {
  createOrganizationFixture,
  createUserFixture,
  deleteOrganizationIfExists,
  deleteUserIfExists,
} from '@open-mercato/core/helpers/integration/authFixtures'
import { getTokenScope } from '@open-mercato/core/helpers/integration/generalFixtures'
import {
  clearCapturedSystemEmails,
  isChannelSeedingAvailable,
  seedSystemEmailChannel,
  waitForCapturedSystemEmail,
} from '@open-mercato/core/helpers/integration/communicationChannelsFixtures'

export const integrationMeta = {
  dependsOnModules: ['directory', 'auth', 'communication_channels'],
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost']

function resolveAlternateOrigin(baseUrl: string | undefined): { baseOrigin: string; alternate: string } | null {
  if (!baseUrl) return null
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return null
  }
  if (!LOOPBACK_HOSTS.includes(parsed.hostname)) return null
  const alternateHost = parsed.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1'
  const alternateUrl = new URL(parsed.origin)
  alternateUrl.hostname = alternateHost
  return { baseOrigin: parsed.origin, alternate: alternateUrl.origin }
}

async function requestPasswordReset(request: APIRequestContext, email: string): Promise<void> {
  const body = new URLSearchParams()
  body.set('email', email)
  const response = await request.post('/api/auth/reset', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    data: body.toString(),
  })
  expect(response.status()).toBe(200)
}

/**
 * TC-DIR-APPURL-002: Per-organization app URL in transactional emails
 * Covers: PUT /api/directory/organizations (appUrl), POST /api/auth/reset
 *
 * A password reset email carries the organization's own address when one is set, falls back to the
 * deployment default for an organization without one, and reverts to the default as soon as the
 * address is cleared (no restart).
 */
test.describe('TC-DIR-APPURL-002: Per-organization app URL in reset emails', () => {
  test('reset link uses the organization address, the default otherwise, and reverts when cleared', async ({ request }) => {
    const origins = resolveAlternateOrigin(process.env.BASE_URL?.trim())
    test.skip(!origins, 'BASE_URL must be a loopback address to swap the host for the alternate origin.')
    const { baseOrigin, alternate } = origins as { baseOrigin: string; alternate: string }

    const token = await getAuthToken(request, 'superadmin')
    const scope = getTokenScope(token)
    const seedingAvailable = await isChannelSeedingAvailable(request, token)
    test.skip(!seedingAvailable, 'OM_ENABLE_TEST_CHANNEL_SEEDING is not enabled.')

    await seedSystemEmailChannel(request, token)

    const stamp = Date.now()
    const emailA = `qa-appurl-a-${stamp}@example.com`
    const emailB = `qa-appurl-b-${stamp}@example.com`
    let orgAId: string | null = null
    let orgBId: string | null = null
    let userAId: string | null = null
    let userBId: string | null = null

    const expectResetLink = async (email: string, expectedOrigin: string, description: string) => {
      await clearCapturedSystemEmails(request, token)
      await requestPasswordReset(request, email)
      const captured = await waitForCapturedSystemEmail(
        request,
        token,
        (item) => item.metadata?.to === email && item.metadata?.subject === 'Reset your password',
        { description },
      )
      expect(String(captured.content.html ?? '')).toContain(`${expectedOrigin}/reset/`)
    }

    try {
      orgAId = await createOrganizationFixture(request, token, { name: `QA AppUrl A ${stamp}`, tenantId: scope.tenantId })
      orgBId = await createOrganizationFixture(request, token, { name: `QA AppUrl B ${stamp}`, tenantId: scope.tenantId })
      userAId = await createUserFixture(request, token, {
        email: emailA,
        password: 'Valid1!Pass',
        organizationId: orgAId,
        roles: ['employee'],
      })
      userBId = await createUserFixture(request, token, {
        email: emailB,
        password: 'Valid1!Pass',
        organizationId: orgBId,
        roles: ['employee'],
      })

      const setResponse = await apiRequest(request, 'PUT', '/api/directory/organizations', {
        token,
        data: { id: orgAId, appUrl: alternate },
      })
      expect(setResponse.status(), 'PUT appUrl should succeed').toBe(200)

      await expectResetLink(emailA, alternate, 'reset email for organization with app URL')
      await expectResetLink(emailB, baseOrigin, 'reset email for organization without app URL')

      const clearResponse = await apiRequest(request, 'PUT', '/api/directory/organizations', {
        token,
        data: { id: orgAId, appUrl: null },
      })
      expect(clearResponse.status(), 'PUT appUrl null should succeed').toBe(200)

      await expectResetLink(emailA, baseOrigin, 'reset email after clearing app URL')
    } finally {
      if (orgAId) {
        await apiRequest(request, 'PUT', '/api/directory/organizations', {
          token,
          data: { id: orgAId, appUrl: null },
        }).catch(() => undefined)
      }
      await deleteUserIfExists(request, token, userAId)
      await deleteUserIfExists(request, token, userBId)
      await deleteOrganizationIfExists(request, token, orgAId)
      await deleteOrganizationIfExists(request, token, orgBId)
    }
  })
})

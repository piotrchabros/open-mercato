import { expect, test } from '@playwright/test'
import { getAuthToken } from '@open-mercato/core/helpers/integration/api'
import { readJsonSafe } from '@open-mercato/core/helpers/integration/generalFixtures'
import { computeCalcomSignature } from '../lib/signature'
import {
  buildProbeEvent,
  configureCalcomIntegration,
  postCalcomWebhook,
  setCalcomIntegrationEnabled,
  teardownCalcomIntegration,
  uniqueCalcomSuffix,
  waitForCalcomEndpointStatus,
} from './helpers/calcom'

const NO_SECRET_PLACEHOLDER = 'no-secret-provided'

async function expectSignatureRejected(response: Awaited<ReturnType<typeof postCalcomWebhook>>, label: string) {
  expect(response.status(), label).toBe(401)
  const body = await readJsonSafe<{ error?: unknown }>(response)
  expect(typeof body?.error, `${label}: the 401 carries an error message`).toBe('string')
}

/**
 * TC-CALCOM-002: Cal.com signature verification and scope
 *
 * The inbound route resolves the tenant by trying every active calcom endpoint
 * config against the x-cal-signature-256 header. A wrong secret, a signature over
 * a different body, a missing header and Cal.com's literal `no-secret-provided`
 * placeholder are all rejected with 401. Once the integration is disabled the
 * endpoint config is deactivated by the state subscriber, so even a correctly
 * signed delivery is rejected with 401 (the route reports it as a verification
 * failure, not a 404).
 * Source: .ai/specs/2026-11-04-calcom-crm-integration.md (Integration test coverage)
 */
test.describe('TC-CALCOM-002: Cal.com signature and scope', () => {
  test('rejects invalid signatures and deliveries for a disabled integration', async ({ request }) => {
    test.setTimeout(120_000)
    const token = await getAuthToken(request, 'admin')
    const suffix = uniqueCalcomSuffix()
    const secret = `calcom-qa-secret-${suffix}`

    let configured = false
    try {
      await configureCalcomIntegration(request, token, { secret })
      configured = true

      const accepted = await postCalcomWebhook(request, buildProbeEvent(), { secret })
      expect(accepted.status(), 'a correctly signed delivery is accepted').toBe(200)
      expect(await readJsonSafe(accepted)).toEqual({ ok: true })

      await expectSignatureRejected(
        await postCalcomWebhook(request, buildProbeEvent(), { secret: `${secret}-wrong` }),
        'a signature computed with another secret is rejected',
      )
      await expectSignatureRejected(
        await postCalcomWebhook(request, buildProbeEvent(), { signature: computeCalcomSignature('{}', secret) }),
        'a signature over a different body is rejected',
      )
      await expectSignatureRejected(
        await postCalcomWebhook(request, buildProbeEvent(), { signature: null }),
        'a delivery without the signature header is rejected',
      )
      await expectSignatureRejected(
        await postCalcomWebhook(request, buildProbeEvent(), { signature: NO_SECRET_PLACEHOLDER }),
        'the no-secret-provided placeholder is rejected',
      )

      await setCalcomIntegrationEnabled(request, token, false)
      await waitForCalcomEndpointStatus(request, secret, 401)
      await expectSignatureRejected(
        await postCalcomWebhook(request, buildProbeEvent(), { secret }),
        'a correctly signed delivery is rejected once the integration is disabled',
      )
    } finally {
      if (configured) await teardownCalcomIntegration(request, token)
    }
  })
})

import type { IntegrationCredentialWebhookHelp } from '@open-mercato/shared/modules/integrations/types'
import { WEBHOOK_PATH } from './lib/constants'

export const metaLeadAdsWebhookSetupGuide: IntegrationCredentialWebhookHelp = {
  kind: 'webhook_setup',
  title: 'Meta Lead Ads webhook configuration',
  summary: 'Subscribe your Meta app to the Page leadgen field so new Instant Form submissions reach Open Mercato within seconds.',
  endpointPath: WEBHOOK_PATH,
  dashboardPathLabel: 'Meta for Developers -> My Apps -> your app -> Webhooks -> Page',
  steps: [
    'Open your app in Meta for Developers and go to Webhooks, then choose the Page object.',
    `Set the Callback URL to your public Open Mercato URL plus ${WEBHOOK_PATH}.`,
    'Enter the Verify Token you configured for Open Mercato and confirm the subscription.',
    'Subscribe the app to the leadgen field of the Page object.',
    'Connect your Meta account and assign your Pages in the Meta Lead Ads backend page, then send a test lead.',
  ],
  events: ['leadgen'],
  localDevelopment: {
    note: 'For local development, expose your app through a public HTTPS tunnel and use that public URL as the Callback URL in Meta.',
    tunnelCommand: 'ngrok http 3000',
    publicUrlExample: `https://<your-subdomain>.ngrok-free.app${WEBHOOK_PATH}`,
  },
}

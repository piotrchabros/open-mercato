import { buildIntegrationDetailWidgetSpotId, type IntegrationBundle, type IntegrationDefinition } from '@open-mercato/shared/modules/integrations/types'
import { INTEGRATION_ID, META_GRAPH_API_VERSION, META_GRAPH_API_VERSIONS, OAUTH_PROVIDER_KEY } from './lib/constants'
import { metaLeadAdsWebhookSetupGuide } from './webhook-guide'

export const metaLeadAdsDetailWidgetSpotId = buildIntegrationDetailWidgetSpotId(INTEGRATION_ID)

export const integration: IntegrationDefinition = {
  id: INTEGRATION_ID,
  title: 'Meta Lead Ads',
  description:
    'Capture Facebook and Instagram Lead Ads submissions as CRM people, companies and interactions in near real time via the Meta leadgen webhook.',
  category: 'lead_source',
  providerKey: OAUTH_PROVIDER_KEY,
  icon: 'meta',
  docsUrl: 'https://developers.facebook.com/docs/marketing-api/guides/lead-ads',
  package: '@open-mercato/meta-lead-ads',
  version: '0.1.0',
  author: 'Open Mercato Team',
  company: 'Open Mercato',
  license: 'MIT',
  tags: ['meta', 'facebook', 'instagram', 'lead-ads', 'leads', 'webhook'],
  detailPage: {
    widgetSpotId: metaLeadAdsDetailWidgetSpotId,
  },
  apiVersions: META_GRAPH_API_VERSIONS,
  credentials: {
    fields: [
      {
        key: 'appId',
        label: 'Meta App ID',
        type: 'text',
        required: true,
        placeholder: '1234567890123456',
        helpText: 'Meta for Developers -> My Apps -> your app -> Settings -> Basic -> App ID.',
      },
      {
        key: 'appSecret',
        label: 'Meta App Secret',
        type: 'secret',
        required: true,
        helpText: 'Meta for Developers -> your app -> Settings -> Basic -> App Secret. Stored encrypted at rest and used to verify webhook signatures.',
      },
      {
        key: 'verifyToken',
        label: 'Webhook Verify Token',
        type: 'secret',
        required: true,
        helpText: 'Any random string you also enter as the Verify Token when subscribing the webhook in Meta. Stored encrypted at rest.',
        helpDetails: metaLeadAdsWebhookSetupGuide,
      },
      {
        key: 'loginConfigId',
        label: 'Facebook Login for Business Configuration ID',
        type: 'text',
        required: false,
        helpText: 'Optional. Configuration ID used to request the leads_retrieval and pages_* permissions during the connect flow.',
      },
      {
        key: 'defaultCountry',
        label: 'Default phone country (ISO 3166-1 alpha-2)',
        type: 'text',
        required: false,
        placeholder: 'PL',
        helpText: 'Optional. Country used to normalize phone numbers submitted without an international prefix.',
      },
      {
        key: 'graphVersion',
        label: 'Graph API version',
        type: 'text',
        required: false,
        placeholder: META_GRAPH_API_VERSION,
        helpText: `Optional. Meta Graph API version used for calls. Leave blank to use ${META_GRAPH_API_VERSION}.`,
      },
    ],
  },
  healthCheck: { service: 'metaLeadAdsHealthCheck' },
}

export const integrations: IntegrationDefinition[] = [integration]
export const bundles: IntegrationBundle[] = []
export const bundle: IntegrationBundle | undefined = undefined

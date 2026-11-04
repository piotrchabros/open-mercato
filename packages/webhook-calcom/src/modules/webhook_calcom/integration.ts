import type { IntegrationBundle, IntegrationDefinition } from '@open-mercato/shared/modules/integrations/types'

export const CALCOM_INTEGRATION_ID = 'webhook_source_calcom'
export const CALCOM_SOURCE_KEY = 'calcom'

export const integration: IntegrationDefinition = {
  id: CALCOM_INTEGRATION_ID,
  title: 'Cal.com',
  description: 'Receives Cal.com (cal.diy) booking and notetaker transcript webhooks and syncs them into customer meetings.',
  category: 'webhook',
  hub: 'webhook_endpoints',
  providerKey: CALCOM_SOURCE_KEY,
  icon: 'calendar-check',
  package: '@open-mercato/webhook-calcom',
  version: '1.0.0',
  author: 'Open Mercato Team',
  license: 'MIT',
  tags: ['calcom', 'cal.diy', 'webhooks', 'bookings', 'meetings', 'transcripts'],
  credentials: {
    fields: [
      {
        key: 'webhookSecret',
        label: 'Webhook signing secret',
        type: 'secret',
        required: true,
        helpText: 'The secret configured on the Cal.com webhook. Each tenant needs its own secret.',
      },
      {
        key: 'instanceUrl',
        label: 'Cal.com instance URL',
        type: 'url',
        required: true,
        placeholder: 'https://cal.bluebee.marketing',
        helpText: 'Base URL of your Cal.com instance.',
      },
      {
        key: 'unmatchedAttendeePolicy',
        label: 'Unmatched attendee policy',
        type: 'select',
        required: false,
        helpText: 'What to do when no attendee matches an existing person.',
        options: [
          { value: 'create_person', label: 'Create a person from the first attendee' },
          { value: 'skip', label: 'Skip the booking' },
        ],
      },
    ],
  },
  healthCheck: { service: 'calcomHealthCheck' },
}

export const integrations: IntegrationDefinition[] = [integration]
export const bundles: IntegrationBundle[] = []

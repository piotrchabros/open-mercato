export const metadata = {
  id: 'webhook_calcom',
  title: 'Cal.com Webhooks',
  description: 'Inbound Cal.com (cal.diy) webhook source that syncs bookings and meeting transcripts into the CRM.',
  requires: ['integrations', 'webhooks', 'customers', 'attachments', 'notifications'],
}

export { features } from './acl'

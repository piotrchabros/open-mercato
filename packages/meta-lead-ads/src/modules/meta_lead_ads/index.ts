import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'meta_lead_ads',
  title: 'Meta Lead Ads',
  version: '0.1.0',
  description: 'Import Meta (Facebook and Instagram) lead ad submissions into CRM people, companies and deals.',
  author: 'Open Mercato Team',
  license: 'MIT',
  requires: ['customers', 'integrations'],
}

export { features } from './acl'

import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'offer_generator',
  title: 'Offer Generator',
  version: '0.1.0',
  description: 'Generate, refine and share AI-written HTML offers with public links, view tracking and PDF export.',
  author: 'Open Mercato Team',
  license: 'MIT',
  requires: ['customers', 'ai_assistant', 'progress'],
}

export { features } from './acl'

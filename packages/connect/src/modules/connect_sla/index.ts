import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'connect_sla',
  title: 'Connect SLA',
  version: '0.1.0',
  description: 'Business calendars, versioned SLA policies, case clocks, and reconciliation for Mercato Connect.',
  author: 'Open Mercato Team',
  license: 'MIT',
  ejectable: true,
}

export { features } from './acl'

export default metadata

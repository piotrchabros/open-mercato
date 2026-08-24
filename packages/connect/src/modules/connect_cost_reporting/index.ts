import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

export const metadata: ModuleInfo = {
  name: 'connect_cost_reporting',
  title: 'Connect Cost Reporting',
  version: '0.1.0',
  description: 'Exact cost-per-contact reporting over optional Connect source contracts.',
  author: 'Open Mercato Team',
  license: 'MIT',
  ejectable: true,
}

export { features } from './acl'
export default metadata

import type { ModuleInfo } from '@open-mercato/shared/modules/registry'

/**
 * Mercato Connect analytics.
 *
 * Deliberately a separate module from `connect`: Phase 1 owns immutable
 * operational facts and their aggregates, and moving them would break stable
 * routes and ACLs. Analytics owns only composition, cost accounting inputs and
 * its own reporting surface, and reaches Phase 1 data through a scoped DI
 * facade rather than a peer entity import.
 *
 * It stays soft-optional relative to `connect`, `currencies`, `staff` and
 * `communication_channels` — no `requires` declaration, no peer entity import.
 */
export const metadata: ModuleInfo = {
  name: 'connect_analytics',
  title: 'Connect Analytics',
  version: '0.1.0',
  description:
    'Formula-versioned reporting over Mercato Connect operational aggregates, plus auditable organization-scoped cost accounting inputs.',
  author: 'Open Mercato Team',
  license: 'MIT',
  ejectable: true,
}

export { features } from './acl'

export default metadata

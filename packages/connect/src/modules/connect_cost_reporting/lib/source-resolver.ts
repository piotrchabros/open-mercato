import type { ConnectAllocatedCostReader } from '@open-mercato/connect/modules/connect_analytics/lib/allocated-cost-contract'
import type { ConnectContactDenominatorReader } from '@open-mercato/connect/modules/connect/lib/contact-denominator-reader'

type Dependencies = {
  hasRegistration: (key: string) => boolean
  resolveCostReader: () => ConnectAllocatedCostReader
  resolveDenominatorReader: () => ConnectContactDenominatorReader
}

export type ResolvedSource<T> =
  | { status: 'available'; reader: T }
  | { status: 'module_disabled' | 'reader_unavailable' }

function resolveSource<T>(registered: boolean, resolve: () => T): ResolvedSource<T> {
  if (!registered) return { status: 'module_disabled' }
  try {
    const reader = resolve()
    return reader ? { status: 'available', reader } : { status: 'reader_unavailable' }
  } catch {
    return { status: 'reader_unavailable' }
  }
}

export function createCostPerContactSourceResolver(dependencies: Dependencies) {
  return {
    cost: () => resolveSource(
      dependencies.hasRegistration('connectAllocatedCostReader'),
      dependencies.resolveCostReader,
    ),
    denominator: () => resolveSource(
      dependencies.hasRegistration('connectContactDenominatorReader'),
      dependencies.resolveDenominatorReader,
    ),
  }
}

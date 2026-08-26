import { asFunction } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { ConnectAllocatedCostReader } from '@open-mercato/connect/modules/connect_analytics/lib/allocated-cost-contract'
import type { ConnectContactDenominatorReader } from '@open-mercato/connect/modules/connect/lib/contact-denominator-reader'
import { createCostPerContactSourceResolver } from './lib/source-resolver'

export type CostPerContactSourceResolver = ReturnType<typeof createCostPerContactSourceResolver>

export function register(container: AppContainer) {
  container.register({
    connectCostReportingSourceResolver: asFunction(() =>
      createCostPerContactSourceResolver({
        hasRegistration: (key) => container.hasRegistration(key),
        resolveCostReader: () => container.resolve<ConnectAllocatedCostReader>('connectAllocatedCostReader'),
        resolveDenominatorReader: () =>
          container.resolve<ConnectContactDenominatorReader>('connectContactDenominatorReader'),
      }),
    ).scoped(),
  })
}

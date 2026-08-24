import type { EntityManager } from '@mikro-orm/postgresql'
import { asFunction } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { ConnectOperationalMetricsReader } from '@open-mercato/connect/modules/connect/lib/operational-metrics-reader'
import { createConnectAllocatedCostReader } from './lib/allocated-cost-reader'
import { createCostInputCurrencyResolver } from './lib/cost-input-currency'

export type ConnectAnalyticsMetricsSource = ConnectOperationalMetricsReader | null

const OPERATIONAL_READER_KEY = 'connectOperationalMetricsReader'

export function register(container: AppContainer) {
  container.register({
    /**
     * The container runs in Awilix CLASSIC injection mode, which resolves each
     * dependency by parameter *name*. A destructured `({ em })` parameter has
     * no resolvable name and arrives as `undefined` — and a reader handed an
     * undefined EntityManager fails in a way that reads like "no cost data"
     * rather than like a wiring bug. Keep the bare `em` parameter.
     */
    connectAllocatedCostReader: asFunction((em: EntityManager) =>
      createConnectAllocatedCostReader(em),
    ).scoped(),

    costInputCurrencyResolver: asFunction(() =>
      createCostInputCurrencyResolver(container),
    ).scoped(),

    connectAnalyticsMetricsSource: asFunction((): ConnectAnalyticsMetricsSource => {
      const cradle = container as { hasRegistration?: (name: string) => boolean }
      if (typeof cradle.hasRegistration !== 'function' || !cradle.hasRegistration(OPERATIONAL_READER_KEY)) return null
      try {
        return container.resolve(OPERATIONAL_READER_KEY) as ConnectOperationalMetricsReader
      } catch {
        return null
      }
    }).scoped(),
  })
}

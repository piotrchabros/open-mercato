import type { EntityManager } from '@mikro-orm/postgresql'
import { asFunction } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { createConnectCostInputReader } from './lib/cost-input-reader'
import { createCostInputCurrencyResolver } from './lib/cost-input-currency'

export function register(container: AppContainer) {
  container.register({
    /**
     * The container runs in Awilix CLASSIC injection mode, which resolves each
     * dependency by parameter *name*. A destructured `({ em })` parameter has
     * no resolvable name and arrives as `undefined` — and a reader handed an
     * undefined EntityManager fails in a way that reads like "no cost data"
     * rather than like a wiring bug. Keep the bare `em` parameter.
     */
    connectCostInputReader: asFunction((em: EntityManager) =>
      createConnectCostInputReader(em),
    ).scoped(),

    costInputCurrencyResolver: asFunction(() =>
      createCostInputCurrencyResolver(container),
    ).scoped(),
  })
}

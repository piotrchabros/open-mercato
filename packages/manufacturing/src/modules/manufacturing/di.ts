import { asClass } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { StockLedgerService } from './services/stockLedgerService.js'

/**
 * Manufacturing module DI registration.
 *
 * `manufacturingStockProvider` (spec decision i) resolves to the module-owned
 * stock ledger service. Only the `ManufacturingStockProvider` interface + the
 * `manufacturing.stock_movement.created` event are contract surfaces — a future
 * warehouse module can register a different implementation under this same
 * token (extraction path documented in the spec).
 */
export function register(container: AppContainer) {
  container.register({
    manufacturingStockProvider: asClass(StockLedgerService)
      .singleton()
      .inject(() => ({
        em: () => container.resolve('em'),
        dataEngine: container.resolve('dataEngine'),
      })),
  })
}

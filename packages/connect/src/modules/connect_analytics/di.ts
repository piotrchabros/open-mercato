import { asFunction } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { ConnectOperationalMetricsReader } from '@open-mercato/connect/modules/connect/lib/operational-metrics-reader'

/**
 * Analytics resolves Connect's read facade; it never imports a Connect entity
 * and holds no ORM relation to one.
 *
 * The registration answers `null` when Connect is absent instead of throwing or
 * synthesising an empty dataset. That distinction is the whole point: a report
 * of all zeroes and a report that could not be produced look identical to an
 * operator, and only one of them means "no traffic".
 */
export type ConnectAnalyticsMetricsSource = ConnectOperationalMetricsReader | null

const READER_KEY = 'connectOperationalMetricsReader'

export function register(container: AppContainer) {
  container.register({
    connectAnalyticsMetricsSource: asFunction((): ConnectAnalyticsMetricsSource => {
      const cradle = container as { hasRegistration?: (name: string) => boolean }
      if (typeof cradle.hasRegistration !== 'function' || !cradle.hasRegistration(READER_KEY)) return null
      try {
        return container.resolve(READER_KEY) as ConnectOperationalMetricsReader
      } catch {
        return null
      }
    }).scoped(),
  })
}

import type { EntityManager } from '@mikro-orm/postgresql'
import { asFunction, asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { ConnectAgentPresence, ConnectRoutingCapacityCheckpoint } from './data/entities'
import { createConnectRoutingCapacityService } from './lib/reconcile-capacity'

export function register(container: AppContainer) {
  container.register({
    // Entity class registrations (for EntityManager lookups by string).
    ConnectAgentPresence: asValue(ConnectAgentPresence),
    ConnectRoutingCapacityCheckpoint: asValue(ConnectRoutingCapacityCheckpoint),

    // The container runs in Awilix CLASSIC injection mode, which resolves each
    // dependency by parameter name. A destructured `({ em })` parameter has no
    // resolvable name and silently arrives as undefined, which here would look
    // like a reconciler that quietly reconciles nothing.
    connectRoutingCapacityService: asFunction((em: EntityManager) =>
      createConnectRoutingCapacityService({ em, container }),
    ).scoped(),
  })
}

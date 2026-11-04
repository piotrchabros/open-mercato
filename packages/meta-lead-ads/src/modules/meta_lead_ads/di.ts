import { asFunction } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getMetaGraphClient } from './lib/graph-client'
import { createMetaLeadAdsHealthCheck } from './lib/health'

export function register(container: AppContainer): void {
  container.register({
    metaGraphClient: asFunction(() => getMetaGraphClient()).transient(),
    metaLeadAdsHealthCheck: asFunction(({ em }: { em: EntityManager }) =>
      createMetaLeadAdsHealthCheck({ em }),
    ).scoped().proxy(),
  })
}

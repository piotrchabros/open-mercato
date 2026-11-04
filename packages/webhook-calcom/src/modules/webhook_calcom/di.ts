import { asFunction } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { createCalcomHealthCheck } from './lib/health'
import type { CalcomCredentialsService } from './lib/credentials'

export function register(container: AppContainer) {
  container.register({
    calcomHealthCheck: asFunction(
      ({ integrationCredentialsService }: { integrationCredentialsService: CalcomCredentialsService }) =>
        createCalcomHealthCheck({ credentialsService: integrationCredentialsService }),
    ).scoped().proxy(),
  })
}

import { createHash, timingSafeEqual } from 'node:crypto'
import type { AwilixContainer } from 'awilix'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import { findWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import type { IntegrationLogService } from '@open-mercato/core/modules/integrations/lib/log-service'
import { InboundEndpointConfigEntity } from '@open-mercato/webhooks/modules/webhooks/data/entities'
import { upsertInboundEndpointConfig } from '@open-mercato/webhooks/modules/webhooks/lib/inbound-endpoint-config'
import { CALCOM_INTEGRATION_ID, CALCOM_SOURCE_KEY } from '../integration'
import { resolveCalcomCredentials, type CalcomCredentialsService } from './credentials'

type IntegrationStateChecker = {
  isEnabled(integrationId: string, scope: IntegrationScope): Promise<boolean>
}

export type CalcomEndpointSyncResult = {
  active: boolean
  reason?: 'disabled' | 'secret_missing' | 'secret_in_use'
}

function digestSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest()
}

async function isSecretBoundElsewhere(
  em: EntityManager,
  credentialsService: CalcomCredentialsService,
  scope: { tenantId: string; organizationId: string },
  secret: string,
): Promise<boolean> {
  const activeConfigs = await findWithDecryption(
    em,
    InboundEndpointConfigEntity,
    { sourceKey: CALCOM_SOURCE_KEY, isActive: true },
    {},
  )
  const ownDigest = digestSecret(secret)
  for (const config of activeConfigs) {
    if (config.tenantId === scope.tenantId && config.organizationId === scope.organizationId) continue
    const otherCredentials = await resolveCalcomCredentials(credentialsService, {
      tenantId: config.tenantId,
      organizationId: config.organizationId,
    })
    if (!otherCredentials?.webhookSecret) continue
    if (timingSafeEqual(ownDigest, digestSecret(otherCredentials.webhookSecret))) return true
  }
  return false
}

export async function syncCalcomEndpointConfig(
  container: AwilixContainer,
  scope: { tenantId: string; organizationId: string },
): Promise<CalcomEndpointSyncResult> {
  const stateService = container.resolve('integrationStateService') as IntegrationStateChecker
  const credentialsService = container.resolve('integrationCredentialsService') as CalcomCredentialsService
  const em = container.resolve('em') as EntityManager

  const enabled = await stateService.isEnabled(CALCOM_INTEGRATION_ID, scope)
  const credentials = enabled ? await resolveCalcomCredentials(credentialsService, scope) : null
  const secret = credentials?.webhookSecret ?? null

  let result: CalcomEndpointSyncResult
  if (!enabled) {
    result = { active: false, reason: 'disabled' }
  } else if (!secret) {
    result = { active: false, reason: 'secret_missing' }
  } else if (await isSecretBoundElsewhere(em, credentialsService, scope, secret)) {
    result = { active: false, reason: 'secret_in_use' }
  } else {
    result = { active: true }
  }

  await upsertInboundEndpointConfig(em, {
    sourceKey: CALCOM_SOURCE_KEY,
    integrationId: CALCOM_INTEGRATION_ID,
    scope,
    isActive: result.active,
  })

  if (result.reason === 'secret_in_use') {
    const logService = container.resolve('integrationLogService') as Pick<IntegrationLogService, 'write'>
    await logService.write(
      {
        integrationId: CALCOM_INTEGRATION_ID,
        level: 'error',
        code: 'calcom.endpoint.secret_in_use',
        message: 'Cal.com endpoint kept inactive (secret_in_use): the webhook secret is already bound to another organization',
        payload: { tenantId: scope.tenantId, organizationId: scope.organizationId },
      },
      scope,
    )
  }
  return result
}

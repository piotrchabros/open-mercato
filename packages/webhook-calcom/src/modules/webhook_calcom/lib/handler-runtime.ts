import type { AwilixContainer } from 'awilix'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import type { WebhookHandlerPayload } from '@open-mercato/shared/lib/webhooks'
import type { IntegrationLogService } from '@open-mercato/core/modules/integrations/lib/log-service'
import { CALCOM_INTEGRATION_ID } from '../integration'
import type { CalcomSyncScope } from './booking-sync'
import { resolveCalcomCredentials, type CalcomCredentials, type CalcomCredentialsService } from './credentials'
import { parseCalcomWebhook, type ParsedCalcomWebhook } from './payload'
import type { CalcomTranslate } from './transcript-sync'

export type CalcomHandlerRuntime = {
  container: AwilixContainer
  scope: CalcomSyncScope
  parsed: ParsedCalcomWebhook
  translate: CalcomTranslate
}

export function parseCalcomHandlerPayload(payload: WebhookHandlerPayload): ParsedCalcomWebhook {
  return parseCalcomWebhook(payload.data)
}

export async function createCalcomHandlerRuntime(
  payload: WebhookHandlerPayload,
  parsed: ParsedCalcomWebhook = parseCalcomHandlerPayload(payload),
): Promise<CalcomHandlerRuntime> {
  const container = await createRequestContainer()
  const { translate } = await resolveTranslations()
  return {
    container,
    scope: { tenantId: payload.tenantId, organizationId: payload.organizationId },
    parsed,
    translate,
  }
}

export async function resolveCalcomHandlerCredentials(
  runtime: CalcomHandlerRuntime,
  trigger: string,
): Promise<CalcomCredentials | null> {
  const credentialsService = runtime.container.resolve('integrationCredentialsService') as CalcomCredentialsService
  const credentials = await resolveCalcomCredentials(credentialsService, runtime.scope)
  if (credentials) return credentials

  const logService = runtime.container.resolve('integrationLogService') as Pick<IntegrationLogService, 'write'>
  await logService.write(
    {
      integrationId: CALCOM_INTEGRATION_ID,
      level: 'warn',
      message: `Cal.com ${trigger} webhook skipped (credentials_missing)`,
      code: 'calcom.booking.skipped',
      payload: { trigger, action: 'skipped', reason: 'credentials_missing' },
    },
    runtime.scope,
  )
  return null
}

export function resolveCalcomFallbackTitle(translate: CalcomTranslate): string {
  return translate('webhook_calcom.interaction.defaultTitle', 'Meeting')
}

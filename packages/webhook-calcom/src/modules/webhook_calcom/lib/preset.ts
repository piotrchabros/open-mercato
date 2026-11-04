import type { AwilixContainer } from 'awilix'
import { parseBooleanWithDefault } from '@open-mercato/shared/lib/boolean'
import type { IntegrationScope } from '@open-mercato/shared/modules/integrations/types'
import { CALCOM_INTEGRATION_ID } from '../integration'
import { calcomCredentialsSchema } from './credentials'
import { syncCalcomEndpointConfig } from './endpoint-config'

export const CALCOM_ENV_VARS = {
  webhookSecret: 'OM_INTEGRATION_CALCOM_WEBHOOK_SECRET',
  instanceUrl: 'OM_INTEGRATION_CALCOM_INSTANCE_URL',
  unmatchedPolicy: 'OM_INTEGRATION_CALCOM_UNMATCHED_POLICY',
  enabled: 'OM_INTEGRATION_CALCOM_ENABLED',
} as const

export type CalcomPresetOutcome = { status: 'applied' | 'skipped'; reason?: string }

type CalcomPresetCredentialsService = {
  getRaw: (integrationId: string, scope: IntegrationScope) => Promise<Record<string, unknown> | null>
  save: (integrationId: string, credentials: Record<string, unknown>, scope: IntegrationScope) => Promise<void>
}

type CalcomPresetStateService = {
  upsert: (integrationId: string, input: { isEnabled?: boolean }, scope: IntegrationScope) => Promise<unknown>
}

export type ApplyCalcomEnvPresetDeps = {
  container: AwilixContainer
  scope: IntegrationScope
  force?: boolean
  env?: NodeJS.ProcessEnv
}

function readValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim()
  return value ? value : undefined
}

export async function applyCalcomEnvPreset(deps: ApplyCalcomEnvPresetDeps): Promise<CalcomPresetOutcome> {
  const env = deps.env ?? process.env
  const webhookSecret = readValue(env, CALCOM_ENV_VARS.webhookSecret)
  const instanceUrl = readValue(env, CALCOM_ENV_VARS.instanceUrl)

  if (!webhookSecret && !instanceUrl) {
    return { status: 'skipped', reason: 'No Cal.com preset environment variables were provided.' }
  }
  const missing: string[] = []
  if (!webhookSecret) missing.push(CALCOM_ENV_VARS.webhookSecret)
  if (!instanceUrl) missing.push(CALCOM_ENV_VARS.instanceUrl)
  if (missing.length) {
    return { status: 'skipped', reason: `Incomplete Cal.com env preset; missing ${missing.join(', ')}.` }
  }

  const parsed = calcomCredentialsSchema.safeParse({
    webhookSecret,
    instanceUrl,
    unmatchedAttendeePolicy: readValue(env, CALCOM_ENV_VARS.unmatchedPolicy),
  })
  if (!parsed.success) {
    return { status: 'skipped', reason: `Invalid Cal.com env preset; check ${CALCOM_ENV_VARS.instanceUrl}.` }
  }

  const credentialsService = deps.container.resolve('integrationCredentialsService') as CalcomPresetCredentialsService
  const stateService = deps.container.resolve('integrationStateService') as CalcomPresetStateService

  const existing = await credentialsService.getRaw(CALCOM_INTEGRATION_ID, deps.scope)
  if (!existing || deps.force) {
    await credentialsService.save(CALCOM_INTEGRATION_ID, { ...parsed.data }, deps.scope)
  }

  const isEnabled = parseBooleanWithDefault(readValue(env, CALCOM_ENV_VARS.enabled), true)
  await stateService.upsert(CALCOM_INTEGRATION_ID, { isEnabled }, deps.scope)

  await syncCalcomEndpointConfig(deps.container, {
    tenantId: deps.scope.tenantId,
    organizationId: deps.scope.organizationId,
  })

  return { status: 'applied' }
}

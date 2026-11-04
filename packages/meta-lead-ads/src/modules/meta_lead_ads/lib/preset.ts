import { parseBooleanToken } from '@open-mercato/shared/lib/boolean'
import { INTEGRATION_ID, resolveGraphApiVersion, type MetaScope } from './constants'
import type { GraphCallOptions } from './graph-client'

type ServiceContainer = { resolve: <T = unknown>(name: string) => T }

type CredentialsStore = {
  resolve: (integrationId: string, scope: MetaScope) => Promise<Record<string, unknown> | null>
  save: (integrationId: string, credentials: Record<string, unknown>, scope: MetaScope) => Promise<void>
}

type StateStore = {
  upsert: (integrationId: string, input: { isEnabled: boolean }, scope: MetaScope) => Promise<unknown>
}

export type MetaLeadAdsEnvPreset = {
  appId: string | null
  appSecret: string | null
  verifyToken: string | null
  loginConfigId: string | null
  graphVersion: string | null
}

export type MetaAppCredentials = {
  appId: string | null
  appSecret: string | null
  verifyToken: string | null
  loginConfigId: string | null
  defaultCountry: string | null
  graphVersion: string | null
  graphBaseUrl: string | null
  retryDelaysMs: string | null
}

export type ApplyEnvPresetResult = 'applied' | 'skipped_no_env' | 'skipped_existing'

function readEnvValue(raw: string | undefined): string | null {
  const trimmed = raw?.trim()
  return trimmed ? trimmed : null
}

function readStoredString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key]
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function readMetaLeadAdsEnvPreset(env: NodeJS.ProcessEnv = process.env): MetaLeadAdsEnvPreset {
  return {
    appId: readEnvValue(env.OM_META_LEAD_ADS_APP_ID),
    appSecret: readEnvValue(env.OM_META_LEAD_ADS_APP_SECRET),
    verifyToken: readEnvValue(env.OM_META_LEAD_ADS_VERIFY_TOKEN),
    loginConfigId: readEnvValue(env.OM_META_LEAD_ADS_LOGIN_CONFIG_ID),
    graphVersion: readEnvValue(env.OM_META_LEAD_ADS_GRAPH_VERSION),
  }
}

export function isTestOverrideAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' || parseBooleanToken(env.OM_INTEGRATION_TEST) === true
}

export async function resolveAppCredentials(
  container: ServiceContainer,
  scope: MetaScope | null,
): Promise<MetaAppCredentials> {
  const env = readMetaLeadAdsEnvPreset()
  const overridesAllowed = isTestOverrideAllowed()
  let stored: Record<string, unknown> | null = null
  if (scope) {
    const credentialsService = container.resolve<CredentialsStore>('integrationCredentialsService')
    stored = await credentialsService.resolve(INTEGRATION_ID, scope)
  }
  return {
    appId: readStoredString(stored, 'appId') ?? env.appId,
    appSecret: readStoredString(stored, 'appSecret') ?? env.appSecret,
    verifyToken: readStoredString(stored, 'verifyToken') ?? env.verifyToken,
    loginConfigId: readStoredString(stored, 'loginConfigId') ?? env.loginConfigId,
    defaultCountry: readStoredString(stored, 'defaultCountry'),
    graphVersion: readStoredString(stored, 'graphVersion') ?? env.graphVersion,
    graphBaseUrl: overridesAllowed
      ? readStoredString(stored, 'graphBaseUrl') ?? readEnvValue(process.env.OM_META_LEAD_ADS_GRAPH_BASE_URL)
      : null,
    retryDelaysMs: overridesAllowed
      ? readStoredString(stored, 'retryDelaysMs') ?? readEnvValue(process.env.OM_META_LEAD_ADS_RETRY_DELAYS_MS)
      : null,
  }
}

export function graphOptionsFromCredentials(credentials: MetaAppCredentials): GraphCallOptions {
  return {
    graphVersion: resolveGraphApiVersion(credentials.graphVersion),
    baseUrl: credentials.graphBaseUrl,
  }
}

export async function applyMetaLeadAdsEnvPreset(input: {
  container: ServiceContainer
  scope: MetaScope
  force?: boolean
}): Promise<ApplyEnvPresetResult> {
  const preset = readMetaLeadAdsEnvPreset()
  if (!preset.appId || !preset.appSecret) return 'skipped_no_env'

  const credentialsService = input.container.resolve<CredentialsStore>('integrationCredentialsService')
  const existing = await credentialsService.resolve(INTEGRATION_ID, input.scope)
  if (!input.force && (readStoredString(existing, 'appId') || readStoredString(existing, 'appSecret'))) {
    return 'skipped_existing'
  }

  const presetFields: Record<string, string> = {
    appId: preset.appId,
    appSecret: preset.appSecret,
  }
  if (preset.verifyToken) presetFields.verifyToken = preset.verifyToken
  if (preset.loginConfigId) presetFields.loginConfigId = preset.loginConfigId
  if (preset.graphVersion) presetFields.graphVersion = preset.graphVersion

  await credentialsService.save(INTEGRATION_ID, { ...(existing ?? {}), ...presetFields }, input.scope)
  const stateService = input.container.resolve<StateStore>('integrationStateService')
  await stateService.upsert(INTEGRATION_ID, { isEnabled: true }, input.scope)
  return 'applied'
}

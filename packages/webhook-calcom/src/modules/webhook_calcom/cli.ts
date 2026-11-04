import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { applyCalcomEnvPreset, CALCOM_ENV_VARS } from './lib/preset'

const USAGE = [
  'Usage: yarn mercato webhook_calcom configure-from-env --tenant <tenantId> --org <organizationId> [--force]',
  `Required env: ${CALCOM_ENV_VARS.webhookSecret}, ${CALCOM_ENV_VARS.instanceUrl}`,
  `Optional env: ${CALCOM_ENV_VARS.unmatchedPolicy} (create_person | skip), ${CALCOM_ENV_VARS.enabled} (default true)`,
].join('\n')

function parseArgs(rest: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {}

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (!arg || !arg.startsWith('--')) continue

    const [key, inlineValue] = arg.replace(/^--/, '').split('=')
    if (inlineValue !== undefined) {
      args[key] = inlineValue
      continue
    }

    const next = rest[index + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      index += 1
      continue
    }

    args[key] = true
  }

  return args
}

function readScopeArg(args: Record<string, string | boolean>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

const configureFromEnv: ModuleCli = {
  command: 'configure-from-env',
  async run(rest) {
    const args = parseArgs(rest)
    const tenantId = readScopeArg(args, ['tenantId', 'tenant'])
    const organizationId = readScopeArg(args, ['organizationId', 'orgId', 'org'])
    const force = args.force === true

    if (!tenantId || !organizationId) {
      console.log(USAGE)
      process.exitCode = 1
      return
    }

    const container = await createRequestContainer()
    try {
      console.log(`[webhook_calcom] Configuring tenant ${tenantId}, organization ${organizationId}${force ? ' (force)' : ''}.`)

      const result = await applyCalcomEnvPreset({ container, scope: { tenantId, organizationId }, force })

      if (result.status === 'skipped') {
        console.log(`[webhook_calcom] Skipped: ${result.reason}`)
        return
      }
      console.log('[webhook_calcom] Credentials and state applied, inbound endpoint synced.')
    } catch (error) {
      console.error(`[webhook_calcom] ${error instanceof Error ? error.message : 'Failed to apply the env preset'}`)
      process.exitCode = 1
    } finally {
      const disposable = container as unknown as { dispose?: () => Promise<void> }
      if (typeof disposable.dispose === 'function') await disposable.dispose()
    }
  },
}

const commands: ModuleCli[] = [configureFromEnv]

export default commands

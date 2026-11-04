import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { Organization, Tenant } from '@open-mercato/core/modules/directory/data/entities'
import { MetaForm } from './data/entities'
import { backfillSchema } from './data/validators'
import { applyMetaLeadAdsEnvPreset } from './lib/preset'
import { startBackfill } from './lib/backfill'
import { enqueueReconcile } from './lib/queue'
import type { MetaScope } from './lib/constants'

function parseArgs(args: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue

    const key = arg.slice(2)
    if (key.includes('=')) {
      const [name, value] = key.split('=')
      result[name] = value
      continue
    }

    const next = args[i + 1]
    if (next && !next.startsWith('--')) {
      result[key] = next
      i += 1
      continue
    }

    result[key] = true
  }

  return result
}

function printHelp(): void {
  console.log('Usage: yarn mercato meta_lead_ads <command>')
  console.log('')
  console.log('Commands:')
  console.log('  configure-from-env [--tenant <tenantId>] [--force]')
  console.log('  backfill --form <formId> --from <iso> --to <iso>')
  console.log('  reconcile --org <organizationId>')
  console.log('')
  console.log('Env vars for configure-from-env:')
  console.log('  OM_META_LEAD_ADS_APP_ID')
  console.log('  OM_META_LEAD_ADS_APP_SECRET')
}

function readString(value: string | boolean | undefined): string {
  return typeof value === 'string' ? value : ''
}

const configureFromEnvCommand: ModuleCli = {
  command: 'configure-from-env',
  async run(rest) {
    const args = parseArgs(rest)
    const tenantFilter = readString(args.tenant ?? args.tenantId)
    const force = args.force === true
    const container = await createRequestContainer()
    try {
      const em = (container.resolve('em') as EntityManager).fork()
      const tenantIds = tenantFilter
        ? [tenantFilter]
        : (await em.find(Tenant, {})).map((tenant: Tenant) => String(tenant.id))
      const counts = { applied: 0, skipped_no_env: 0, skipped_existing: 0 }
      for (const tenantId of tenantIds) {
        const organizations = await em.find(Organization, { tenant: tenantId })
        for (const organization of organizations) {
          const scope: MetaScope = { tenantId, organizationId: String(organization.id) }
          const result = await applyMetaLeadAdsEnvPreset({ container, scope, force })
          counts[result] += 1
        }
      }
      console.log(
        `[meta_lead_ads] tenants=${tenantIds.length} applied=${counts.applied} skipped_existing=${counts.skipped_existing} skipped_no_env=${counts.skipped_no_env}`,
      )
    } finally {
      await container.dispose()
    }
  },
  help: 'yarn mercato meta_lead_ads help',
}

const backfillCommand: ModuleCli = {
  command: 'backfill',
  async run(rest) {
    const args = parseArgs(rest)
    const parsed = backfillSchema.safeParse({
      formId: readString(args.form),
      from: readString(args.from),
      to: readString(args.to),
    })
    if (!parsed.success) {
      printHelp()
      return
    }
    const container = await createRequestContainer()
    try {
      const em = container.resolve('em') as EntityManager
      const form = await em.fork().findOne(MetaForm, { id: parsed.data.formId, deletedAt: null })
      if (!form) {
        console.error('[meta_lead_ads] Form not found.')
        return
      }
      const scope: MetaScope = { tenantId: form.tenantId, organizationId: form.organizationId }
      const result = await startBackfill({ container, em, scope, userId: null }, parsed.data)
      console.log(`[meta_lead_ads] backfill runId=${result.runId} progressJobId=${result.progressJobId ?? 'none'}`)
    } finally {
      await container.dispose()
    }
  },
  help: 'yarn mercato meta_lead_ads help',
}

const reconcileCommand: ModuleCli = {
  command: 'reconcile',
  async run(rest) {
    const args = parseArgs(rest)
    const organizationId = readString(args.org ?? args.organizationId)
    if (!organizationId) {
      printHelp()
      return
    }
    const container = await createRequestContainer()
    try {
      const em = (container.resolve('em') as EntityManager).fork()
      const organization = await em.findOne(Organization, { id: organizationId })
      if (!organization) {
        console.error('[meta_lead_ads] Organization not found.')
        return
      }
      const tenantId = String(organization.tenant.id)
      const jobId = await enqueueReconcile({ tenantId, organizationId })
      console.log(`[meta_lead_ads] reconcile enqueued jobId=${jobId}`)
    } finally {
      await container.dispose()
    }
  },
  help: 'yarn mercato meta_lead_ads help',
}

const helpCommand: ModuleCli = {
  command: 'help',
  async run() {
    printHelp()
  },
}

export default [configureFromEnvCommand, backfillCommand, reconcileCommand, helpCommand]

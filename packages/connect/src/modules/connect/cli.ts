import { readFile } from 'node:fs/promises'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { z } from 'zod'
import type { ConnectPrincipalClassificationProvisioningService } from './lib/principal-classification-provisioning'
import {
  connectPrincipalClassificationManifestSchema,
  createConnectPrincipalClassificationManifestService,
} from './lib/principal-classification-manifest'

function parseArgs(rest: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token?.startsWith('--')) throw new Error('[internal] connect_principal_invalid_cli_arguments')
    const key = token.slice(2)
    if (key === 'apply') {
      args.apply = true
      continue
    }
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) throw new Error('[internal] connect_principal_invalid_cli_arguments')
    args[key] = value
    index += 1
  }
  return args
}

const reconcileArgsSchema = z.object({
  tenant: z.string().uuid(),
  organization: z.string().uuid(),
  manifest: z.string().min(1),
  apply: z.boolean().optional(),
}).strict()

export function parsePrincipalReconcileArgs(rest: string[]) {
  const [subcommand, ...flags] = rest
  if (subcommand !== 'reconcile') throw new Error('[internal] connect_principal_invalid_cli_arguments')
  return reconcileArgsSchema.parse(parseArgs(flags))
}

export async function runPrincipalReconcile(rest: string[]): Promise<void> {
  const args = parsePrincipalReconcileArgs(rest)
  const tenantId = args.tenant
  const organizationId = args.organization
  const manifestPath = args.manifest
  const manifest = connectPrincipalClassificationManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
  )
  const container = await createRequestContainer()
  try {
    const service = createConnectPrincipalClassificationManifestService({
      em: container.resolve<EntityManager>('em'),
      provisioningService: container.resolve<ConnectPrincipalClassificationProvisioningService>(
        'connectPrincipalClassificationProvisioningService',
      ),
    })
    const result = await service.reconcile({ tenantId, organizationId, manifest, apply: args.apply === true })
    console.log(JSON.stringify({ mode: args.apply === true ? 'apply' : 'dry-run', ...result }))
  } finally {
    await container.dispose()
  }
}

const principalsCommand: ModuleCli = {
  command: 'principals',
  run: runPrincipalReconcile,
}

export default [principalsCommand]

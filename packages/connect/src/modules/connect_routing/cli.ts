import type { ModuleCli } from '@open-mercato/shared/modules/registry'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { reconcileCapacityPayloadSchema } from './data/validators'
import type { ConnectRoutingCapacityService } from './lib/reconcile-capacity'

/**
 * Operator retry for a scope whose backfill did not complete.
 *
 *   yarn mercato connect_routing reconcile-capacity \
 *     --tenant-id <uuid> --organization-id <uuid>
 *
 * Both scopes are required and neither is derived from stored rows: a command
 * that discovered its own scope could widen it after a partial failure, which is
 * precisely when an operator is least able to notice. It runs the same service
 * and the same schema as setup and the worker, so retrying converges rather than
 * taking a second, differently-behaved path.
 */

function parseArgs(rest: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token?.startsWith('--')) throw new Error('[internal] connect_routing_invalid_cli_arguments')
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) throw new Error('[internal] connect_routing_invalid_cli_arguments')
    args[token.slice(2)] = value
    index += 1
  }
  return args
}

export function parseReconcileCapacityArgs(rest: string[]) {
  const args = parseArgs(rest)
  return reconcileCapacityPayloadSchema.parse({
    tenantId: args['tenant-id'],
    organizationId: args['organization-id'],
  })
}

export async function runReconcileCapacity(rest: string[]): Promise<void> {
  const scope = parseReconcileCapacityArgs(rest)
  const container = await createRequestContainer()
  try {
    const service = container.resolve<ConnectRoutingCapacityService>('connectRoutingCapacityService')
    const result = await service.reconcile(scope)
    console.log(JSON.stringify(result))
  } finally {
    await container.dispose()
  }
}

const reconcileCapacityCommand: ModuleCli = {
  command: 'reconcile-capacity',
  run: runReconcileCapacity,
}

export default [reconcileCapacityCommand]

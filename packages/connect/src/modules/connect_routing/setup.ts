import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { CONNECT_ROUTING_QUEUES } from './lib/queue'
import type { ConnectRoutingCapacityService } from './lib/reconcile-capacity'

const logger = createLogger('connect_routing').child({ component: 'setup' })

/**
 * Enable-time capacity backfill.
 *
 * Setup is the only moment where this module can be sure it runs before routing
 * does, so the backfill happens here rather than being left to an operator. It
 * is idempotent by construction: reconciliation recomputes absolute counts, so a
 * rerun after an interrupted initialization converges instead of double-counting.
 *
 * No ACL feature, route or navigation is registered — routing is not active yet
 * and must present no surface until it is.
 */

type QueueLike = { enqueue: (payload: Record<string, unknown>) => Promise<unknown> }
type QueueFactoryLike = { getQueue?: (name: string) => QueueLike | undefined }

export const setup: ModuleSetupConfig = {
  async seedDefaults({ container, organizationId, tenantId }) {
    const cradle = container as { hasRegistration?: (name: string) => boolean }
    if (
      typeof cradle.hasRegistration === 'function' &&
      !cradle.hasRegistration('connectRoutingCapacityService')
    ) {
      logger.warn('routing capacity service unavailable; capacity was not reconciled', {
        tenantId,
        organizationId,
      })
      return
    }
    const service = container.resolve('connectRoutingCapacityService') as ConnectRoutingCapacityService

    try {
      const result = await service.reconcile({
        tenantId,
        organizationId,
        // Only consulted above the foreground threshold. Returning false hands
        // the work back to the caller rather than dropping it: a missing queue
        // must not be the reason an organization starts routing from zero.
        defer: async ({ examined }) => {
          try {
            const factory = container.resolve('queueFactory') as QueueFactoryLike
            const queue = factory?.getQueue?.(CONNECT_ROUTING_QUEUES.capacityReconcile)
            if (!queue) return false
            await queue.enqueue({ tenantId, organizationId })
            return true
          } catch (err) {
            logger.warn('queue unavailable; reconciling capacity synchronously instead', {
              tenantId,
              organizationId,
              examined,
              err,
            })
            return false
          }
        },
      })
      logger.info('routing capacity setup finished', {
        tenantId,
        organizationId,
        outcome: result.outcome,
      })
    } catch (err) {
      // The checkpoint is already durably `failed` at this point, so the scope
      // stays visibly unreconciled and the Phase 3 gate keeps failing closed.
      // Aborting tenant initialization here would be strictly worse.
      logger.warn('routing capacity reconciliation failed; rerun setup or the CLI to converge', {
        tenantId,
        organizationId,
        err,
      })
    }
  },
}

export default setup

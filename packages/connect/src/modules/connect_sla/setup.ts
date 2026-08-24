import { createHash } from 'node:crypto'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { CONNECT_SLA_QUEUES } from './lib/async'

const logger = createLogger('connect_sla').child({ component: 'setup' })

type SchedulerService = {
  register(input: {
    id: string
    name: string
    scopeType: 'organization'
    tenantId: string
    organizationId: string
    scheduleType: 'interval'
    scheduleValue: string
    targetType: 'queue'
    targetQueue: string
    targetPayload: unknown
    sourceType: 'module'
    sourceModule: string
    isEnabled: boolean
    description: string
  }): Promise<void>
}

function scheduleId(key: string): string {
  const hash = createHash('sha256').update(key).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
}

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['connect_sla.*'],
    admin: ['connect_sla.*'],
  },
  async seedDefaults({ container, tenantId, organizationId }) {
    const registrationAware = container as { hasRegistration?: (name: string) => boolean }
    if (!registrationAware.hasRegistration?.('schedulerService')) return
    try {
      const scheduler = container.resolve('schedulerService') as SchedulerService
      await scheduler.register({
        id: scheduleId(`connect_sla:${tenantId}:${organizationId}:deadline-sweep`),
        name: 'Connect SLA deadline sweep',
        description: 'Evaluates due open response and resolution clocks in bounded, idempotent batches.',
        scopeType: 'organization',
        tenantId,
        organizationId,
        scheduleType: 'interval',
        scheduleValue: '60s',
        targetType: 'queue',
        targetQueue: CONNECT_SLA_QUEUES.deadlineSweep,
        targetPayload: { tenantId, organizationId },
        sourceType: 'module',
        sourceModule: 'connect_sla',
        isEnabled: true,
      })
      await scheduler.register({
        id: scheduleId(`connect_sla:${tenantId}:${organizationId}:event-outbox`),
        name: 'Connect SLA event outbox sweep',
        description: 'Publishes durable SLA lifecycle events and retries expired leases.',
        scopeType: 'organization',
        tenantId,
        organizationId,
        scheduleType: 'interval',
        scheduleValue: '60s',
        targetType: 'queue',
        targetQueue: CONNECT_SLA_QUEUES.eventOutbox,
        targetPayload: { tenantId, organizationId },
        sourceType: 'module',
        sourceModule: 'connect_sla',
        isEnabled: true,
      })
    } catch (error) {
      logger.warn('SLA deadline schedule registration failed', { error })
    }
  },
}

export default setup

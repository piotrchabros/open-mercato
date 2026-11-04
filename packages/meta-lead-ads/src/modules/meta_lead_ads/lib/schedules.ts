import crypto from 'node:crypto'
import type { AwilixContainer } from 'awilix'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { MODULE_ID, QUEUES, SCHEDULES, type MetaScope } from './constants'

const logger = createLogger('meta_lead_ads')

export type MetaLeadAdsScheduleKind = 'reconcile' | 'tokenHealth' | 'retentionPurge'

type SchedulerServiceLike = {
  register: (registration: {
    id: string
    name: string
    description?: string
    scopeType: 'organization'
    organizationId: string
    tenantId: string
    scheduleType: 'cron'
    scheduleValue: string
    timezone: string
    targetType: 'queue'
    targetQueue: string
    targetPayload: { scope: MetaScope }
    sourceType: 'module'
    sourceModule: string
    isEnabled: boolean
  }) => Promise<unknown>
}

const SCHEDULE_DEFINITIONS: Array<{ kind: MetaLeadAdsScheduleKind; name: string; description: string }> = [
  {
    kind: 'reconcile',
    name: 'Meta Lead Ads reconciliation',
    description: 'Nightly import of Meta leads missed by webhooks in the last 48 hours.',
  },
  {
    kind: 'tokenHealth',
    name: 'Meta Lead Ads token health',
    description: 'Daily check of Meta connection tokens and Page subscriptions.',
  },
  {
    kind: 'retentionPurge',
    name: 'Meta Lead Ads retention purge',
    description: 'Daily removal of raw Meta lead payloads older than the retention period.',
  },
]

function stableUuidFromString(input: string): string {
  const bytes = crypto.createHash('sha256').update(input).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function stableScheduleId(kind: MetaLeadAdsScheduleKind, organizationId: string): string {
  return stableUuidFromString(`${MODULE_ID}:${kind}:${organizationId}`)
}

export async function registerMetaLeadAdsSchedules(container: AwilixContainer, scope: MetaScope): Promise<boolean> {
  const cradle = container as { hasRegistration?: (name: string) => boolean }
  if (typeof cradle.hasRegistration !== 'function' || !cradle.hasRegistration('schedulerService')) return false
  const schedulerService = container.resolve<SchedulerServiceLike>('schedulerService')
  try {
    for (const definition of SCHEDULE_DEFINITIONS) {
      await schedulerService.register({
        id: stableScheduleId(definition.kind, scope.organizationId),
        name: definition.name,
        description: definition.description,
        scopeType: 'organization',
        organizationId: scope.organizationId,
        tenantId: scope.tenantId,
        scheduleType: 'cron',
        scheduleValue: SCHEDULES[definition.kind],
        timezone: 'UTC',
        targetType: 'queue',
        targetQueue: QUEUES[definition.kind],
        targetPayload: { scope: { tenantId: scope.tenantId, organizationId: scope.organizationId } },
        sourceType: 'module',
        sourceModule: MODULE_ID,
        isEnabled: true,
      })
    }
    return true
  } catch (error) {
    logger.warn('Failed to register Meta Lead Ads schedules', {
      errorName: error instanceof Error ? error.name : 'unknown',
    })
    return false
  }
}

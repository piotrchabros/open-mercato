import { createHash } from 'node:crypto'
import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { CONNECT_QUEUES } from './lib/queue'

const logger = createLogger('connect').child({ component: 'setup' })

/**
 * Connect module setup.
 *
 * Registers the two recovery schedules Connect cannot be correct without. When
 * the scheduler module is absent they are simply not registered — and the
 * capability reporter then answers `recoverySchedulesRegistered: false`, which
 * blocks Contract E from cutting any channel over to Connect. That is the
 * intended coupling: a Connect-managed channel with no recovery would strand
 * receipts after any outage, so it must not be possible to create one.
 */

type SchedulerServiceLike = {
  register: (registration: {
    id: string
    name: string
    scopeType: 'system' | 'organization' | 'tenant'
    organizationId?: string
    tenantId?: string
    scheduleType: 'cron' | 'interval'
    scheduleValue: string
    targetType: 'queue' | 'command'
    targetQueue?: string
    sourceType?: 'user' | 'module'
    sourceModule?: string
    isEnabled?: boolean
    description?: string
  }) => Promise<void>
}

/** Bounded, documented intervals. Recovery is a safety net, not a hot path. */
const OUTBOX_SWEEP_INTERVAL_SECONDS = 60
const RECEIPT_SWEEP_INTERVAL_SECONDS = 300
const OUTBOUND_DISPATCH_SWEEP_INTERVAL_SECONDS = 60
const RECONCILE_SWEEP_INTERVAL_SECONDS = 900
const AUTO_CLOSE_SWEEP_INTERVAL_SECONDS = 3600

/**
 * `scheduled_jobs.id` is a uuid column, so a module-owned schedule's stable key
 * must be hashed into a uuid rather than used verbatim — that is what keeps
 * `register()` an idempotent upsert across re-runs instead of an insert that
 * fails on the second seed.
 */
function stableScheduleUuid(stableKey: string): string {
  const hex = createHash('sha256').update(stableKey).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['connect.*'],
    admin: ['connect.*'],
    // A manager supervises the queue: sees everything in the organization,
    // assigns and closes, and works the unknown-delivery queue.
    manager: [
      'connect.settings.view',
      'connect.inbox.handle',
      'connect.cases.view.all',
      'connect.cases.assign',
      'connect.cases.manage',
      'connect.inbox.recovery.view',
      'connect.inbox.recovery.acknowledge',
    ],
    // A front-line agent handles their own work and claims from the unassigned
    // queue. Deliberately no `cases.view.all`, `assign` or `manage`.
    employee: ['connect.inbox.handle'],
  },

  async seedDefaults({ container, organizationId, tenantId }) {
    const cradle = container as { hasRegistration?: (name: string) => boolean }
    if (typeof cradle.hasRegistration !== 'function' || !cradle.hasRegistration('schedulerService')) {
      // Not an error here: the capability reporter turns this into a refusal at
      // the point where it matters (channel cutover).
      logger.warn('scheduler unavailable; Connect recovery schedules were not registered')
      return
    }
    const schedulerService = container.resolve('schedulerService') as SchedulerServiceLike

    const registrations = [
      {
        key: `connect:${organizationId}:domain-outbox-sweep`,
        name: 'Connect domain outbox sweep',
        queue: CONNECT_QUEUES.domainOutbox,
        seconds: OUTBOX_SWEEP_INTERVAL_SECONDS,
        description:
          'Drains Connect domain events the after-commit wake job did not publish (process crash, lost job).',
      },
      {
        key: `connect:${organizationId}:inbound-receipt-sweep`,
        name: 'Connect inbound receipt sweep',
        queue: CONNECT_QUEUES.inboundReceipts,
        seconds: RECEIPT_SWEEP_INTERVAL_SECONDS,
        description:
          'Recovers inbound receipts left processing by a crash, and dead-letters exhausted ones.',
      },
      {
        key: `connect:${organizationId}:outbound-dispatch-sweep`,
        name: 'Connect outbound dispatch sweep',
        queue: CONNECT_QUEUES.outboundDispatch,
        seconds: OUTBOUND_DISPATCH_SWEEP_INTERVAL_SECONDS,
        description:
          'Submits durable outbound rows the after-commit wake job did not pick up (crash, lost job).',
      },
      {
        key: `connect:${organizationId}:outbound-reconcile-sweep`,
        name: 'Connect outbound reconciliation sweep',
        queue: CONNECT_QUEUES.outboundReconcile,
        seconds: RECONCILE_SWEEP_INTERVAL_SECONDS,
        description:
          'Re-checks deliveries whose outcome is unknown, using the read-only status lookup. Never resends.',
      },
      {
        key: `connect:${organizationId}:case-auto-close-sweep`,
        name: 'Connect case auto-close sweep',
        queue: CONNECT_QUEUES.caseAutoClose,
        seconds: AUTO_CLOSE_SWEEP_INTERVAL_SECONDS,
        description:
          'Closes resolved cases whose quiet window has passed, through the same guarded transition command as an agent.',
      },
    ]

    for (const registration of registrations) {
      try {
        await schedulerService.register({
          id: stableScheduleUuid(registration.key),
          name: registration.name,
          description: registration.description,
          scopeType: 'organization',
          organizationId,
          tenantId,
          scheduleType: 'interval',
          scheduleValue: String(registration.seconds),
          targetType: 'queue',
          targetQueue: registration.queue,
          sourceType: 'module',
          sourceModule: 'connect',
          isEnabled: true,
        })
      } catch (err) {
        // Best-effort, mirroring the other modules: one scheduler failure must
        // not abort tenant initialization for every module after it.
        logger.warn('could not register a Connect recovery schedule', { key: registration.key, err })
      }
    }
  },
}

export default setup

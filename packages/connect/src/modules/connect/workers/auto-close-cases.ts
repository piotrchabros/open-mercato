import type { EntityManager } from '@mikro-orm/postgresql'
import type { JobContext, QueuedJob, WorkerMeta } from '@open-mercato/queue'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ConnectCase, ConnectSettings } from '../data/entities'
import { CONNECT_QUEUES } from '../lib/queue'
import { transitionCase } from '../commands/transition-case'

const logger = createLogger('connect').child({ component: 'auto-close-cases' })

/**
 * Close resolved Cases once their quiet window has passed.
 *
 * It goes through the SAME transition command interactive routes use, with a
 * system actor kind the scheduler constructs from the schedule's own tenant and
 * organization. Two consequences, both deliberate:
 *
 *   - Registered and legacy mutation guards still run, so a guard can veto an
 *     auto-close exactly as it would veto a human one.
 *   - There is no request shape that produces `system:auto_close`, so a browser
 *     caller cannot borrow the principal to close a Case it may not touch.
 *
 * Candidates are re-validated under the Case lock inside the command, so a
 * customer replying between selection and close reopens the Case instead of
 * losing the race.
 */
export const metadata: WorkerMeta = {
  queue: CONNECT_QUEUES.caseAutoClose,
  id: 'connect:auto-close-cases',
  concurrency: 1,
}

export const CONNECT_AUTO_CLOSE_BATCH_SIZE = 100

type HandlerContext = JobContext & {
  resolve: <T = unknown>(name: string) => T
}

const DAY_MS = 24 * 60 * 60 * 1000

export default async function handle(
  _job: QueuedJob<{ tenantId?: string; organizationId?: string }>,
  ctx: HandlerContext,
): Promise<void> {
  const em = (ctx.resolve<EntityManager>('em')).fork()
  const now = new Date()

  const settingsRows = await em.find(ConnectSettings, {})
  for (const settings of settingsRows) {
    const boundary = new Date(now.getTime() - settings.autoCloseAfterDays * DAY_MS)

    const candidates = await em.find(
      ConnectCase,
      {
        tenantId: settings.tenantId,
        organizationId: settings.organizationId,
        status: 'resolved',
        // Strictly older than the boundary: a Case resolved exactly at the
        // boundary is still inside its window.
        resolvedAt: { $lt: boundary },
        deletedAt: null,
        // A merged source is already closed by the merge, so it can never match
        // `resolved` — but the predicate is explicit anyway, so a future status
        // change cannot quietly hand the sweep a Case the command will refuse.
        mergedIntoCaseId: null,
      },
      { orderBy: { resolvedAt: 'asc' }, limit: CONNECT_AUTO_CLOSE_BATCH_SIZE },
    )

    for (const candidate of candidates) {
      const result = await transitionCase(ctx as never, {
        caseId: candidate.id,
        action: 'close',
        actor: {
          userId: null,
          tenantId: settings.tenantId,
          organizationId: settings.organizationId,
          features: [],
          kind: 'system:auto_close',
        },
        reason: 'auto_close',
      })
      if (result.status !== 'transitioned' && result.status !== 'noop') {
        // A guard veto, a reopen that beat us, or a concurrent close. All are
        // normal outcomes for a sweep; none should stop the batch.
        logger.debug('auto-close skipped a case', { caseId: candidate.id, outcome: result.status })
      }
    }
  }
}

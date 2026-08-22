import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  ConnectCase,
  ConnectOutboundAttempt,
  ConnectUnknownDelivery,
  type ConnectAttemptStatus,
} from '../data/entities'
import { statusAfterFirstOutbound } from './case-lifecycle-outbound'
import { stageDomainEvent } from './domain-outbox'

const logger = createLogger('connect').child({ component: 'delivery-outcome-apply' })

/**
 * Apply one Contract A delivery outcome to a Connect attempt.
 *
 * Outcomes arrive out of order, more than once, and sometimes long after the UI
 * has moved on, so this is written to be idempotent and monotonic rather than
 * simply "set the status":
 *
 *   - **Scope + attempt must both match.** `correlationId` alone is only unique
 *     within one tenant+organization+channel, so matching on it would let one
 *     tenant's outcome settle another's attempt.
 *   - **Revisions never regress.** A lower or equal revision is ignored, so a
 *     duplicated event cannot undo a later one.
 *   - **Terminal decisions are final.** A late `unknown` must not un-resolve a
 *     confirmed send, and a `sent` after a `failed` is a conflict to log, not a
 *     silent overwrite.
 */

export type DeliveryOutcomePayload = {
  tenantId: string
  organizationId: string | null
  channelId: string
  correlationId: string
  attemptId: string
  deliveryRevision: number
  providerMessageId?: string
  status: 'sent' | 'failed' | 'unknown'
  reasonCode?: string
  occurredAt: string
}

export type ApplyOutcomeResult =
  | { status: 'applied'; attemptStatus: ConnectAttemptStatus; caseTransitioned: boolean }
  | { status: 'ignored'; reason: 'unknown_attempt' | 'stale_revision' | 'terminal' | 'conflict' }

const TERMINAL: ReadonlySet<ConnectAttemptStatus> = new Set(['sent', 'failed'])

export async function applyDeliveryOutcome(
  em: EntityManager,
  payload: DeliveryOutcomePayload,
  now: Date = new Date(),
): Promise<ApplyOutcomeResult> {
  const attempt = await em.findOne(ConnectOutboundAttempt, {
    id: payload.attemptId,
    tenantId: payload.tenantId,
    hubCorrelationId: payload.correlationId,
  })
  // Requiring BOTH the attempt id and the correlation is what stops an outcome
  // from another scope settling this attempt.
  if (!attempt) return { status: 'ignored', reason: 'unknown_attempt' }

  if (payload.deliveryRevision <= attempt.deliveryRevision) {
    return { status: 'ignored', reason: 'stale_revision' }
  }

  if (TERMINAL.has(attempt.status)) {
    if (attempt.status !== payload.status) {
      // Two different terminal claims about the same send. Neither is applied;
      // this needs a human, not a silent overwrite.
      logger.error('conflicting terminal delivery outcome ignored', {
        attemptId: attempt.id,
        stored: attempt.status,
        incoming: payload.status,
      })
      return { status: 'ignored', reason: 'conflict' }
    }
    return { status: 'ignored', reason: 'terminal' }
  }

  const previousStatus = attempt.status
  attempt.status = payload.status
  attempt.deliveryRevision = payload.deliveryRevision
  attempt.providerMessageId = payload.providerMessageId ?? attempt.providerMessageId ?? null
  attempt.errorReason = payload.reasonCode ?? null
  if (payload.status !== 'unknown') attempt.settledAt = now

  let caseTransitioned = false

  let firstInboundAt: Date | null = null
  let firstConfirmedHumanOutboundAt: Date | null = null

  if (payload.status === 'sent') {
    // Only a CONFIRMED send moves the Case to waiting_customer. A failed or
    // unknown attempt must not, or the queue would show work as handed back to
    // the customer when nothing reached them.
    const target = await em.findOne(ConnectCase, {
      id: attempt.caseId,
      tenantId: attempt.tenantId,
      organizationId: attempt.organizationId,
      deletedAt: null,
    })
    if (target) {
      const next = statusAfterFirstOutbound(target.status)
      if (next !== target.status) {
        target.status = next
        caseTransitioned = true
      }
      firstInboundAt = target.firstInboundAt ?? null
      // Stamped once, on the FIRST confirmed send. Doing it at enqueue would
      // measure how fast an agent typed rather than when the customer heard
      // back, and a later retry would keep resetting it.
      if (!target.firstOutboundSentAt) {
        target.firstOutboundSentAt = now
        firstConfirmedHumanOutboundAt = now
      }
    }
  }

  if (payload.status === 'unknown') {
    // Surface it for a human. Unique per attempt, so repeated unknown outcomes
    // do not pile up duplicate queue rows.
    const existing = await em.findOne(ConnectUnknownDelivery, {
      tenantId: attempt.tenantId,
      attemptId: attempt.id,
    })
    if (existing) {
      existing.lastCheckedAt = now
    } else {
      em.persist(
        em.create(ConnectUnknownDelivery, {
          tenantId: attempt.tenantId,
          organizationId: attempt.organizationId,
          caseId: attempt.caseId,
          attemptId: attempt.id,
          channelId: payload.channelId,
          lastCheckedAt: now,
        }),
      )
    }
  }

  stageDomainEvent(em, {
    tenantId: attempt.tenantId,
    organizationId: attempt.organizationId,
    sourceEventId: `connect.outbound.status_changed:${attempt.id}:${payload.deliveryRevision}`,
    aggregateId: attempt.id,
    aggregateVersion: payload.deliveryRevision,
    eventType: 'connect.outbound.status_changed',
    payload: {
      caseId: attempt.caseId,
      attemptId: attempt.id,
      messageId: attempt.messageId,
      fromStatus: previousStatus,
      status: payload.status,
      deliveryRevision: payload.deliveryRevision,
      // The attempt's own creation day, frozen. Outcome counts cohort by when
      // the attempt was ENQUEUED, so a send confirmed three days later still
      // settles into the bucket whose denominator it belongs to.
      enqueueCohortUtcDate: attempt.createdAt.toISOString().slice(0, 10),
      // Both snapshotted here so first-response aggregation joins no mutable
      // Case table. Non-null only on the first confirmed send.
      firstInboundAt: firstInboundAt ? firstInboundAt.toISOString() : null,
      firstConfirmedHumanOutboundAt: firstConfirmedHumanOutboundAt
        ? firstConfirmedHumanOutboundAt.toISOString()
        : null,
      occurredAt: now.toISOString(),
    },
  })

  await em.flush()
  return { status: 'applied', attemptStatus: attempt.status, caseTransitioned }
}

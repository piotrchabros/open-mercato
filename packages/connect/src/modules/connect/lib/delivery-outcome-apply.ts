import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  ConnectCase,
  ConnectOutboundAttempt,
  ConnectOutboundMessage,
  ConnectUnknownDelivery,
  type ConnectAttemptStatus,
} from '../data/entities'
import { statusAfterFirstOutbound } from './case-lifecycle-outbound'
import { stageDomainEvent } from './domain-outbox'
import { recordDeliveryConfirmed, recordWaitStarted } from './sla-source-facts'

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
  // One transaction for the attempt revision, the Case status, the source facts
  // and the outbox. A partial application here is the worst outcome available:
  // a consumer would see a delivery announced against a Case whose wait never
  // opened, or a first-send stamp with no fact behind it.
  return em.transactional(async (tem) => applyOutcomeInTransaction(tem as EntityManager, payload, now))
}

async function applyOutcomeInTransaction(
  em: EntityManager,
  payload: DeliveryOutcomePayload,
  now: Date,
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
    //
    // Locked because two attempts on the same Case can settle concurrently, and
    // the status transition, the first-send stamp and the wait boundary must
    // all be decided by one of them, not interleaved between both.
    const target = await em.findOne(
      ConnectCase,
      {
        id: attempt.caseId,
        tenantId: attempt.tenantId,
        organizationId: attempt.organizationId,
        deletedAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
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
      //
      // Serialized as a scoped conditional UPDATE ... RETURNING rather than a
      // read-then-write: only the row that actually transitioned NULL → now
      // comes back, so exactly one attempt reports the first send even if the
      // lock is ever weakened or the row is touched by another writer. The
      // legacy column itself stays unqualified — it says "something confirmed",
      // not "a human answered". The evidence fact carries that.
      const stamped = (await em.execute(
        `update "connect_cases"
            set "first_outbound_sent_at" = ?, "updated_at" = ?
          where "id" = ? and "tenant_id" = ? and "organization_id" = ?
            and "deleted_at" is null and "first_outbound_sent_at" is null
        returning "first_outbound_sent_at"`,
        [now, now, target.id, attempt.tenantId, attempt.organizationId],
      )) as unknown[]
      if (Array.isArray(stamped) && stamped.length > 0) {
        firstConfirmedHumanOutboundAt = now
      }

      const message = await em.findOne(ConnectOutboundMessage, {
        id: attempt.messageId,
        tenantId: attempt.tenantId,
        organizationId: attempt.organizationId,
      })
      // The message's OWN round, not the Case's current one: a delivery
      // confirmed after a reopen belongs to the round it was enqueued in.
      const generation = message?.caseGeneration ?? target.slaGeneration
      const factScope = { tenantId: attempt.tenantId, organizationId: attempt.organizationId }

      await recordDeliveryConfirmed(em, {
        ...factScope,
        sourceEventId: `connect.outbound.delivery_confirmed:${attempt.id}:${payload.deliveryRevision}`,
        caseId: attempt.caseId,
        generation,
        outboundMessageId: attempt.messageId,
        attemptId: attempt.id,
        deliveryRevision: payload.deliveryRevision,
        confirmedAt: now,
        responseEvidence: message?.responseEvidence ?? 'unknown',
        responseEvidenceVersion: message?.responseEvidenceVersion ?? 1,
        authorUserId: message?.actorUserId ?? null,
        acceptedByUserId: message?.acceptedByUserId ?? null,
        occurredAt: now,
      })

      // The ball is with the customer only when the Case actually crossed into
      // waiting. A second confirmed reply while already waiting finds the wait
      // open and adds nothing.
      if (caseTransitioned && next === 'waiting_customer') {
        await recordWaitStarted(em, {
          ...factScope,
          sourceEventId: `connect.case.customer_wait_started:${attempt.id}:${payload.deliveryRevision}`,
          caseId: attempt.caseId,
          generation,
          occurredAt: now,
        })
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

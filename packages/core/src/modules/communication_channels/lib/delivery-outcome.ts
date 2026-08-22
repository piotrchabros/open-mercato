import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ChannelDeliveryAttempt } from '../data/entities'
import { emitCommunicationChannelsEvent } from '../events'
import { recordDeliveryOutcome, type DeliveryCorrelationScope } from './delivery-correlation'

const logger = createLogger('communication_channels').child({ component: 'delivery-outcome' })

/**
 * Recording and publishing outbound delivery outcomes (Connect upstream
 * Contract A).
 *
 * `communication_channels.delivery.outcome_recorded` is written ONLY from here,
 * and only by the hub delivery worker. Downstream reconciliation depends on
 * that: if another writer could emit the event, a subscriber could not treat it
 * as authoritative.
 *
 * The event carries identifiers and a status — never recipients, subject, or
 * body — so persistent event storage holds no message content.
 */

export type DeliveryOutcomeStatus = 'sent' | 'failed' | 'unknown'

/**
 * Reason codes the hub itself assigns. Provider-specific reasons pass through
 * as free-form strings; these are the ones downstream logic may match on.
 */
export const DELIVERY_REASON_AUTHORIZATION_REVOKED = 'authorization_revoked'
export const DELIVERY_REASON_RETRIES_EXHAUSTED = 'retries_exhausted'
export const DELIVERY_REASON_PROVIDER_REJECTED = 'provider_rejected'
export const DELIVERY_REASON_INDETERMINATE = 'indeterminate_dispatch'

/**
 * Errors that leave a send genuinely indeterminate.
 *
 * The request reached the network and then failed without a response, so the
 * provider may or may not have accepted it. For an uncorrelated send the hub's
 * long-standing choice is to retry (a duplicate beats a lost message); for a
 * CORRELATED send the caller asked for the opposite guarantee, so these become
 * `unknown` and are reconciled instead of resent.
 */
const INDETERMINATE_DISPATCH_PATTERNS: readonly RegExp[] = [
  /timed?\s?out/i,
  /etimedout/i,
  /econnreset/i,
  /socket hang ?up/i,
  /aborted/i,
  /ehostunreach/i,
  /enetunreach/i,
  /epipe/i,
]

export function isIndeterminateDispatchError(message: string): boolean {
  return INDETERMINATE_DISPATCH_PATTERNS.some((pattern) => pattern.test(message))
}

/**
 * Find the attempt a composed message belongs to.
 *
 * Returns `null` for a message sent without a correlation — the overwhelming
 * majority of existing traffic — so every call site degrades to the
 * pre-contract behaviour rather than requiring one.
 */
export async function findAttemptForMessage(
  em: EntityManager,
  messageId: string,
  scope: { tenantId: string; organizationId: string | null },
): Promise<ChannelDeliveryAttempt | null> {
  return em.findOne(ChannelDeliveryAttempt, {
    messageId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
}

export type PublishDeliveryOutcomeInput = {
  em: EntityManager
  attempt: ChannelDeliveryAttempt
  status: DeliveryOutcomeStatus
  providerMessageId?: string | null
  reasonCode?: string | null
  occurredAt?: Date
}

/**
 * Record an outcome and, if it was applied, publish it.
 *
 * A fenced outcome (the attempt was already terminal) publishes NOTHING: the
 * authoritative statement was made by the earlier write, and emitting a second
 * event for the same attempt would let a subscriber observe a regression that
 * the store itself refused.
 */
export async function publishDeliveryOutcome(
  input: PublishDeliveryOutcomeInput,
): Promise<{ published: boolean; deliveryRevision: number | null }> {
  const { em, attempt } = input
  const scope: DeliveryCorrelationScope = {
    tenantId: attempt.tenantId,
    organizationId: attempt.organizationId ?? null,
    channelId: attempt.channelId,
  }

  const recorded = await recordDeliveryOutcome(em, scope, attempt.attemptId, {
    status: input.status,
    providerMessageId: input.providerMessageId ?? null,
    reasonCode: input.reasonCode ?? null,
    occurredAt: input.occurredAt,
  })
  if (recorded.status !== 'recorded') return { published: false, deliveryRevision: null }

  try {
    await emitCommunicationChannelsEvent(
      'communication_channels.delivery.outcome_recorded',
      {
        tenantId: attempt.tenantId,
        organizationId: attempt.organizationId ?? null,
        channelId: attempt.channelId,
        correlationId: attempt.correlationId,
        attemptId: attempt.attemptId,
        deliveryRevision: recorded.deliveryRevision,
        providerMessageId: recorded.attempt.providerMessageId ?? undefined,
        status: input.status,
        reasonCode: input.reasonCode ?? undefined,
        occurredAt: (recorded.attempt.occurredAt ?? new Date()).toISOString(),
      },
      { persistent: true },
    )
  } catch (err) {
    // The outcome is already durable in `channel_delivery_attempts`, which the
    // status-lookup facade reads. A failed emit costs a notification, not the
    // record, so it must not turn a completed delivery into a worker failure.
    logger.warn('delivery outcome event emit failed', { attemptId: attempt.attemptId, err })
  }

  return { published: true, deliveryRevision: recorded.deliveryRevision }
}

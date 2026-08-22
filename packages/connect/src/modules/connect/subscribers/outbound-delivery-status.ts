import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { applyDeliveryOutcome, type DeliveryOutcomePayload } from '../lib/delivery-outcome-apply'

const logger = createLogger('connect').child({ component: 'outbound-delivery-status' })

/**
 * Consume `communication_channels.delivery.outcome_recorded`.
 *
 * The hub is the only writer of that event, and it is the only thing that knows
 * what the provider did, so this subscriber is how a Connect attempt ever
 * leaves `sending`. It matches on the COMPLETE scope plus the attempt id —
 * `correlationId` alone is only unique within one tenant+organization+channel,
 * so matching on it would let one tenant's outcome settle another's attempt.
 *
 * An outcome for an attempt Connect does not own is silently ignored: the same
 * event serves every consumer of the hub.
 */
export const metadata = {
  event: 'communication_channels.delivery.outcome_recorded',
  persistent: true,
  id: 'connect:outbound-delivery-status',
}

type SubscriberContext = {
  resolve: <T = unknown>(name: string) => T
}

export default async function handler(
  payload: Partial<DeliveryOutcomePayload>,
  ctx: SubscriberContext,
): Promise<void> {
  if (
    typeof payload?.tenantId !== 'string' ||
    typeof payload?.attemptId !== 'string' ||
    typeof payload?.correlationId !== 'string' ||
    typeof payload?.deliveryRevision !== 'number' ||
    (payload.status !== 'sent' && payload.status !== 'failed' && payload.status !== 'unknown')
  ) {
    return
  }

  const em = (ctx.resolve('em') as EntityManager).fork()
  const result = await applyDeliveryOutcome(em, {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId ?? null,
    channelId: payload.channelId ?? '',
    correlationId: payload.correlationId,
    attemptId: payload.attemptId,
    deliveryRevision: payload.deliveryRevision,
    providerMessageId: payload.providerMessageId,
    status: payload.status,
    reasonCode: payload.reasonCode,
    occurredAt: payload.occurredAt ?? new Date().toISOString(),
  })

  if (result.status === 'ignored' && result.reason === 'conflict') {
    logger.error('delivery outcome conflicted with a terminal decision', { attemptId: payload.attemptId })
  }
}

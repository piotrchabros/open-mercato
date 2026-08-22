import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { payloadDate, payloadNumber, payloadString, readEventScope, recordFact, utcDay } from '../lib/metrics-facts'
import type { ConnectFactType } from '../data/entities'

const logger = createLogger('connect').child({ component: 'metrics-inbound' })

/**
 * Record the inbound side of the reconciliation equation.
 *
 * `inbound_claimed` is the denominator; every receipt must eventually produce
 * exactly one terminal fact (`opened`, `attached`, `suppressed` or
 * `dead_lettered`). A day where those do not add up is the signal that
 * something is stuck — which is only true if BOTH halves land on the same
 * cohort, so both use the claim date frozen on the receipt rather than the day
 * the worker happened to run.
 *
 * A reclaim after a crashed attempt is deliberately NOT a second claim: the
 * source key is the receipt's, so the retry deduplicates against the original
 * and the denominator still counts messages, not attempts.
 */
export const metadata = {
  event: 'connect.inbound.claimed',
  persistent: true,
  id: 'connect:metrics-inbound-claimed',
}

type SubscriberContext = { resolve: <T = unknown>(name: string) => T }

export default async function handler(
  payload: Record<string, unknown>,
  ctx: SubscriberContext,
): Promise<void> {
  const scope = readEventScope(payload)
  if (!scope) return
  const claimedAt = payloadDate(payload, 'claimedAt')
  const cohort = payloadString(payload, 'claimCohortUtcDate') ?? (claimedAt ? utcDay(claimedAt) : null)
  if (!cohort || !claimedAt) return

  const em = ctx.resolve('em') as EntityManager
  await recordFact(em, {
    ...scope,
    factType: 'inbound_claimed',
    cohortUtcDate: cohort,
    occurredAt: claimedAt,
    channelId: payloadString(payload, 'channelId'),
  })
}

const DISPOSITION_FACTS: Record<string, ConnectFactType> = {
  opened: 'inbound_opened',
  attached: 'inbound_attached',
  suppressed: 'inbound_suppressed',
  dead_lettered: 'inbound_dead_lettered',
}

/**
 * The terminal half of the same equation.
 *
 * Exported as a named handler and registered by its own subscriber file, so a
 * failure in one half cannot suppress the other — a claim recorded without its
 * disposition shows up as unreconciled, which is exactly the alarm we want.
 */
export async function handleDisposed(
  payload: Record<string, unknown>,
  ctx: SubscriberContext,
): Promise<void> {
  const scope = readEventScope(payload)
  if (!scope) return
  const disposition = payloadString(payload, 'disposition')
  const factType = disposition ? DISPOSITION_FACTS[disposition] : undefined
  if (!factType) {
    logger.warn('unmapped inbound disposition; no fact recorded', { disposition })
    return
  }
  const occurredAt = payloadDate(payload, 'occurredAt') ?? new Date()
  // The receipt's CLAIM day, not today. A dead letter swept at 00:05 belongs to
  // the day its receipt arrived, or that day's equation is permanently short.
  const cohort = payloadString(payload, 'claimCohortUtcDate') ?? utcDay(occurredAt)

  const em = ctx.resolve('em') as EntityManager
  await recordFact(em, {
    ...scope,
    factType,
    cohortUtcDate: cohort,
    occurredAt,
    caseId: payloadString(payload, 'caseId'),
    channelId: payloadString(payload, 'channelId'),
    senderHash: payloadString(payload, 'senderHash'),
    disposition,
    appliedWindowMinutes: payloadNumber(payload, 'appliedWindowMinutes'),
    appliedCountLimit: payloadNumber(payload, 'appliedCountLimit'),
  })
}

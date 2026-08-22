import type { EntityManager } from '@mikro-orm/postgresql'
import { payloadDate, payloadString, readEventScope, recordFact, utcDay } from '../lib/metrics-facts'

/**
 * Projection lag and failures — an OPTIONAL metric family.
 *
 * This subscriber is always registered, because auto-discovery has no
 * conditional path and a subscriber that appears only sometimes is one whose
 * absence nobody notices. It simply records nothing when Customer Projection is
 * not producing events.
 *
 * The consequence is deliberate and carried through to the API: with no
 * samples, projection lag is reported as UNAVAILABLE, never as a lag of zero.
 * Zero would read as "instant", which is the opposite of the truth when the
 * capability is absent.
 */
export const metadata = {
  event: 'connect.projection.status_changed',
  persistent: true,
  id: 'connect:metrics-projection',
}

type SubscriberContext = { resolve: <T = unknown>(name: string) => T }

export default async function handler(
  payload: Record<string, unknown>,
  ctx: SubscriberContext,
): Promise<void> {
  const scope = readEventScope(payload)
  if (!scope) return
  const occurredAt = payloadDate(payload, 'occurredAt') ?? new Date()
  const em = ctx.resolve('em') as EntityManager
  const toStatus = payloadString(payload, 'toStatus')
  const projectionKey = payloadString(payload, 'projectionKey')

  if (toStatus === 'failed') {
    await recordFact(em, {
      ...scope,
      factType: 'projection_failed',
      cohortUtcDate: utcDay(occurredAt),
      occurredAt,
      caseId: payloadString(payload, 'caseId'),
      projectionKey,
    })
    return
  }

  const stagedAt = payloadDate(payload, 'stagedAt')
  const completedAt = payloadDate(payload, 'completedAt')
  if (!stagedAt || !completedAt) return
  const lagMs = completedAt.getTime() - stagedAt.getTime()
  if (lagMs < 0) return

  await recordFact(em, {
    ...scope,
    factType: 'projection_lag_ms',
    cohortUtcDate: utcDay(completedAt),
    occurredAt: completedAt,
    caseId: payloadString(payload, 'caseId'),
    projectionKey,
    value: lagMs,
  })
}

import type { EntityManager } from '@mikro-orm/postgresql'
import { payloadDate, payloadString, readEventScope, recordFact, utcDay } from '../lib/metrics-facts'
import type { ConnectFactType } from '../data/entities'

/**
 * Outbound attempt facts, cohorted by ENQUEUE day.
 *
 * The denominator is "attempts enqueued on DATE", so an outcome confirmed three
 * days later still settles into the bucket whose total it belongs to. Cohorting
 * by outcome day instead would produce days where sent + failed exceeds
 * attempted, which is nonsense an operator cannot act on.
 */
export const metadata = {
  event: 'connect.outbound.attempted',
  persistent: true,
  id: 'connect:metrics-outbound-attempted',
}

type SubscriberContext = { resolve: <T = unknown>(name: string) => T }

export default async function handler(
  payload: Record<string, unknown>,
  ctx: SubscriberContext,
): Promise<void> {
  const scope = readEventScope(payload)
  if (!scope) return
  const occurredAt = payloadDate(payload, 'occurredAt') ?? new Date()
  const cohort = payloadString(payload, 'enqueueCohortUtcDate') ?? utcDay(occurredAt)

  const em = ctx.resolve('em') as EntityManager
  await recordFact(em, {
    ...scope,
    factType: 'outbound_attempted',
    cohortUtcDate: cohort,
    occurredAt,
    caseId: payloadString(payload, 'caseId'),
    attemptId: payloadString(payload, 'attemptId'),
  })
}

const STATUS_FACTS: Record<string, ConnectFactType> = {
  sent: 'outbound_sent',
  failed: 'outbound_failed',
  unknown: 'outbound_unknown',
}

/**
 * Delivery outcomes, plus the first-response measurement.
 *
 * Two facts can come out of one event, and they are deliberately different
 * shapes:
 *
 *   - The status fact keys on `(attempt, revision)`, so a late or reversed
 *     revision produces a NEW fact rather than mutating an old one, and the
 *     aggregate resolves each attempt to its highest revision at rebuild time.
 *   - The first-response duration is emitted only on the first CONFIRMED send,
 *     because the source stamps `firstConfirmedHumanOutboundAt` exactly once. A
 *     replied-but-never-resolved Case therefore enters the percentile cohort
 *     exactly once, which is the case earlier designs got wrong.
 */
export async function handleStatusChanged(
  payload: Record<string, unknown>,
  ctx: SubscriberContext,
): Promise<void> {
  const scope = readEventScope(payload)
  if (!scope) return
  const status = payloadString(payload, 'status')
  const factType = status ? STATUS_FACTS[status] : undefined
  const occurredAt = payloadDate(payload, 'occurredAt') ?? new Date()
  const cohort = payloadString(payload, 'enqueueCohortUtcDate') ?? utcDay(occurredAt)
  const em = ctx.resolve('em') as EntityManager

  if (factType) {
    await recordFact(em, {
      ...scope,
      factType,
      cohortUtcDate: cohort,
      occurredAt,
      caseId: payloadString(payload, 'caseId'),
      attemptId: payloadString(payload, 'attemptId'),
      disposition: status,
    })
  }

  const firstOutboundAt = payloadDate(payload, 'firstConfirmedHumanOutboundAt')
  const firstInboundAt = payloadDate(payload, 'firstInboundAt')
  if (!firstOutboundAt || !firstInboundAt) return
  const seconds = (firstOutboundAt.getTime() - firstInboundAt.getTime()) / 1000
  // A negative interval means the two timestamps disagree about ordering, which
  // would poison a percentile far more than a missing sample does.
  if (seconds < 0) return

  await recordFact(em, {
    ...scope,
    factType: 'first_response_seconds',
    // Cohorted on the RESPONSE day: this measures how the team performed that
    // day, unlike the outcome counters which describe an enqueue cohort.
    cohortUtcDate: utcDay(firstOutboundAt),
    occurredAt: firstOutboundAt,
    caseId: payloadString(payload, 'caseId'),
    attemptId: payloadString(payload, 'attemptId'),
    value: seconds,
  })
}

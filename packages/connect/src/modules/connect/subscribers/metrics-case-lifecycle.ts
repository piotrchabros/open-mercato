import type { EntityManager } from '@mikro-orm/postgresql'
import { payloadDate, payloadString, readEventScope, recordFact, utcDay } from '../lib/metrics-facts'

/**
 * Case lifecycle facts: assignment, resolution and reopen.
 *
 * The resolution event carries `firstInboundAt` and `firstAssignedAt` with it,
 * so the elapsed-time measurement never joins the mutable Case table. That
 * matters because a Case reopened next week would otherwise silently rewrite a
 * timing that was already reported for last week.
 *
 * The measure is deliberately named ELAPSED, not handle time: it is wall-clock
 * and includes waiting on the customer and off-hours. Connect has no
 * presence signal, so anything called "handle time" here would be a claim the
 * data cannot support.
 */
export const metadata = {
  event: 'connect.case.assigned',
  persistent: true,
  id: 'connect:metrics-case-assigned',
}

type SubscriberContext = { resolve: <T = unknown>(name: string) => T }

export default async function handler(
  payload: Record<string, unknown>,
  ctx: SubscriberContext,
): Promise<void> {
  const scope = readEventScope(payload)
  if (!scope) return
  // Only a real pickup counts. An unassign publishes the same event with a null
  // assignee, and counting it would inflate the number of Cases someone took.
  if (!payloadString(payload, 'toAssigneeUserId')) return
  const occurredAt = payloadDate(payload, 'occurredAt') ?? new Date()

  const em = ctx.resolve('em') as EntityManager
  await recordFact(em, {
    ...scope,
    factType: 'case_assigned',
    cohortUtcDate: utcDay(occurredAt),
    occurredAt,
    caseId: payloadString(payload, 'caseId'),
  })
}

export async function handleResolved(
  payload: Record<string, unknown>,
  ctx: SubscriberContext,
): Promise<void> {
  const scope = readEventScope(payload)
  if (!scope) return
  const occurredAt = payloadDate(payload, 'occurredAt') ?? new Date()
  const cohort = utcDay(occurredAt)
  const em = ctx.resolve('em') as EntityManager
  const caseId = payloadString(payload, 'caseId')

  await recordFact(em, {
    ...scope,
    factType: 'case_resolved',
    cohortUtcDate: cohort,
    occurredAt,
    caseId,
  })

  const resolvedAt = payloadDate(payload, 'resolvedAt') ?? occurredAt
  const firstAssignedAt = payloadDate(payload, 'firstAssignedAt')
  // A Case resolved without ever being assigned has no elapsed measurement.
  // Recording zero would put an unearned best case into the percentile; the
  // population is simply smaller, and the API reports the sample count.
  if (!firstAssignedAt) return
  const seconds = (resolvedAt.getTime() - firstAssignedAt.getTime()) / 1000
  if (seconds < 0) return

  await recordFact(em, {
    ...scope,
    factType: 'elapsed_assigned_to_resolution_seconds',
    cohortUtcDate: cohort,
    occurredAt: resolvedAt,
    caseId,
    value: seconds,
  })
}

export async function handleReopened(
  payload: Record<string, unknown>,
  ctx: SubscriberContext,
): Promise<void> {
  const scope = readEventScope(payload)
  if (!scope) return
  const occurredAt = payloadDate(payload, 'occurredAt') ?? new Date()

  const em = ctx.resolve('em') as EntityManager
  await recordFact(em, {
    ...scope,
    factType: 'case_reopened',
    cohortUtcDate: utcDay(occurredAt),
    occurredAt,
    caseId: payloadString(payload, 'caseId'),
  })
}

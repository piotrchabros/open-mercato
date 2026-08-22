import type { EntityManager } from '@mikro-orm/postgresql'
import {
  ConnectMetricDaily,
  ConnectOperationalFact,
  type ConnectFactType,
} from '../data/entities'

/**
 * Deterministic daily aggregation.
 *
 * The whole design rests on one property: an aggregate row is a PURE FUNCTION
 * of the immutable facts for that organization and UTC day. A late event, a
 * fixed bug or a reversed delivery revision is repaired by recomputing, never
 * by patching a counter — so every number on the metrics screen stays traceable
 * to the events that produced it, and a rerun can never double-count.
 */

export type PercentileSummary = {
  p50: number | null
  p90: number | null
  max: number | null
  count: number
}

/**
 * Nearest-rank percentile on the sorted sample.
 *
 * No interpolation: an interpolated p90 over eleven samples invents a value
 * that no Case actually took, and operators reading a response-time number
 * expect it to correspond to a real conversation.
 */
export function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null
  const rank = Math.ceil(fraction * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null
}

export function summarize(values: number[]): PercentileSummary {
  if (values.length === 0) return { p50: null, p90: null, max: null, count: 0 }
  const sorted = [...values].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))
  return {
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1] ?? null,
    count: sorted.length,
  }
}

export type AggregateScope = {
  tenantId: string
  organizationId: string
  utcDate: string
}

type FactLike = {
  factType: ConnectFactType
  channelId?: string | null
  senderHash?: string | null
  attemptId?: string | null
  value?: number | null
  occurredAt: Date
  appliedCountLimit?: number | null
}

export type AggregateTotals = {
  inboundClaimed: number
  casesOpened: number
  casesAttached: number
  inboundSuppressed: number
  inboundDeadLettered: number
  outboundAttempted: number
  outboundSent: number
  outboundFailed: number
  outboundUnknown: number
  unknownMaxAgeSeconds: number | null
  casesAssigned: number
  casesResolved: number
  casesReopened: number
  firstResponse: PercentileSummary
  elapsedResolution: PercentileSummary
  projectionLag: PercentileSummary
  projectionFailed: number
  observedMaxPermittedPerSender: number
  appliedCountLimit: number | null
}

/** The receipts that reached no terminal state. Must be 0 for a complete day. */
export function unreconciledCount(totals: AggregateTotals): number {
  return (
    totals.inboundClaimed -
    totals.casesOpened -
    totals.casesAttached -
    totals.inboundSuppressed -
    totals.inboundDeadLettered
  )
}

const PERMITTED_DISPOSITIONS: ConnectFactType[] = ['inbound_opened', 'inbound_attached']

/**
 * Compute one day's totals from its facts.
 *
 * Pure and synchronous so the arithmetic is testable without a database — the
 * reconciliation equation is the thing most worth pinning down, and it should
 * not need a live Postgres to check.
 */
export function computeTotals(facts: FactLike[], asOf: Date): AggregateTotals {
  const count = (type: ConnectFactType) => facts.filter((fact) => fact.factType === type).length
  const values = (type: ConnectFactType) =>
    facts
      .filter((fact) => fact.factType === type && typeof fact.value === 'number')
      .map((fact) => fact.value as number)

  // An attempt may have several revisions in the same cohort. Each attempt
  // occupies exactly ONE bucket, resolved to its latest outcome — otherwise a
  // send that went queued → unknown → sent would be counted three times and the
  // outcome split would exceed the attempted denominator.
  const latestByAttempt = new Map<string, { type: ConnectFactType; at: number }>()
  for (const fact of facts) {
    if (fact.factType !== 'outbound_sent' && fact.factType !== 'outbound_failed' && fact.factType !== 'outbound_unknown') {
      continue
    }
    if (!fact.attemptId) continue
    const current = latestByAttempt.get(fact.attemptId)
    const at = fact.occurredAt.getTime()
    if (!current || at >= current.at) latestByAttempt.set(fact.attemptId, { type: fact.factType, at })
  }
  const outcomeCount = (type: ConnectFactType) =>
    [...latestByAttempt.values()].filter((entry) => entry.type === type).length

  // The oldest still-unknown attempt. Age is what turns "some sends are
  // unknown" into an actionable alert.
  let unknownMaxAgeSeconds: number | null = null
  for (const [attemptId, entry] of latestByAttempt) {
    if (entry.type !== 'outbound_unknown') continue
    void attemptId
    const seconds = Math.floor((asOf.getTime() - entry.at) / 1000)
    if (unknownMaxAgeSeconds === null || seconds > unknownMaxAgeSeconds) unknownMaxAgeSeconds = seconds
  }

  // The per-sender safety criterion: the largest number of receipts any single
  // (channel, sender) pair was PERMITTED. Suppressed volume is reported
  // separately and never makes this criterion fail — a noisy sender that was
  // correctly throttled is the system working.
  const permittedPerSender = new Map<string, number>()
  let appliedCountLimit: number | null = null
  for (const fact of facts) {
    if (typeof fact.appliedCountLimit === 'number') {
      // The strictest limit in force that day. If settings changed mid-day, the
      // criterion must hold against the tighter of the two, not the looser.
      appliedCountLimit =
        appliedCountLimit === null ? fact.appliedCountLimit : Math.min(appliedCountLimit, fact.appliedCountLimit)
    }
    if (!PERMITTED_DISPOSITIONS.includes(fact.factType)) continue
    if (!fact.senderHash || !fact.channelId) continue
    const key = `${fact.channelId}:${fact.senderHash}`
    permittedPerSender.set(key, (permittedPerSender.get(key) ?? 0) + 1)
  }
  const observedMaxPermittedPerSender = permittedPerSender.size
    ? Math.max(...permittedPerSender.values())
    : 0

  return {
    inboundClaimed: count('inbound_claimed'),
    casesOpened: count('inbound_opened'),
    casesAttached: count('inbound_attached'),
    inboundSuppressed: count('inbound_suppressed'),
    inboundDeadLettered: count('inbound_dead_lettered'),
    outboundAttempted: count('outbound_attempted'),
    outboundSent: outcomeCount('outbound_sent'),
    outboundFailed: outcomeCount('outbound_failed'),
    outboundUnknown: outcomeCount('outbound_unknown'),
    unknownMaxAgeSeconds,
    casesAssigned: count('case_assigned'),
    casesResolved: count('case_resolved'),
    casesReopened: count('case_reopened'),
    firstResponse: summarize(values('first_response_seconds')),
    elapsedResolution: summarize(values('elapsed_assigned_to_resolution_seconds')),
    projectionLag: summarize(values('projection_lag_ms')),
    projectionFailed: count('projection_failed'),
    observedMaxPermittedPerSender,
    appliedCountLimit,
  }
}

/**
 * Recompute and atomically replace one day's aggregate.
 *
 * The existing row is updated in place rather than deleted and re-inserted, so
 * a reader never sees a missing day mid-rebuild — the UI would render that as
 * "not aggregated", which is a different and misleading claim.
 */
export async function rebuildDay(
  em: EntityManager,
  scope: AggregateScope,
  asOf: Date = new Date(),
): Promise<AggregateTotals> {
  const facts = await em.find(ConnectOperationalFact, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    cohortUtcDate: scope.utcDate,
  })
  const totals = computeTotals(facts, asOf)

  const existing = await em.findOne(ConnectMetricDaily, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    utcDate: scope.utcDate,
  })
  const row =
    existing ??
    em.create(ConnectMetricDaily, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      utcDate: scope.utcDate,
      generatedAt: asOf,
    })

  row.inboundClaimed = totals.inboundClaimed
  row.casesOpened = totals.casesOpened
  row.casesAttached = totals.casesAttached
  row.inboundSuppressed = totals.inboundSuppressed
  row.inboundDeadLettered = totals.inboundDeadLettered
  row.outboundAttempted = totals.outboundAttempted
  row.outboundSent = totals.outboundSent
  row.outboundFailed = totals.outboundFailed
  row.outboundUnknown = totals.outboundUnknown
  row.unknownMaxAgeSeconds = totals.unknownMaxAgeSeconds
  row.casesAssigned = totals.casesAssigned
  row.casesResolved = totals.casesResolved
  row.casesReopened = totals.casesReopened
  row.firstResponseP50Seconds = totals.firstResponse.p50
  row.firstResponseP90Seconds = totals.firstResponse.p90
  row.firstResponseSampleCount = totals.firstResponse.count
  row.elapsedResolutionP50Seconds = totals.elapsedResolution.p50
  row.elapsedResolutionP90Seconds = totals.elapsedResolution.p90
  row.elapsedResolutionSampleCount = totals.elapsedResolution.count
  row.projectionLagP50Ms = totals.projectionLag.p50
  row.projectionLagP90Ms = totals.projectionLag.p90
  row.projectionLagMaxMs = totals.projectionLag.max
  row.projectionSampleCount = totals.projectionLag.count
  row.projectionFailed = totals.projectionFailed
  row.observedMaxPermittedPerSender = totals.observedMaxPermittedPerSender
  row.appliedCountLimit = totals.appliedCountLimit
  row.generatedAt = asOf
  row.stale = false

  if (!existing) em.persist(row)
  await em.flush()
  return totals
}

/** Every UTC day in `[from, to]`, inclusive. */
export function enumerateDays(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00.000Z`)
  const end = new Date(`${to}T00:00:00.000Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return []
  const days: string[] = []
  for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 86_400_000)) {
    days.push(cursor.toISOString().slice(0, 10))
  }
  return days
}

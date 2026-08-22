import { createHash } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { ChannelDeliveryAttempt } from '../data/entities'
import { isUniqueViolation } from './pg-errors'

/**
 * Send correlation and idempotency (Connect upstream Contract A).
 *
 * A caller that loses the response to a send has no way to ask an email
 * provider "did that go out?" — there is no idempotent-send key and no reliable
 * status query. Without a hub-side record the only options are to resend
 * (duplicate mail) or to give up (lost mail). This module is that record.
 *
 * The rules it enforces, all of them deliberate:
 *
 *   - The first accepted submission binds `(correlationId → attemptId,
 *     fingerprint)` atomically, via a unique index rather than a read-then-write.
 *   - A resubmission carrying the same attempt and fingerprint is the same
 *     logical send: it returns the existing row and never re-enqueues.
 *   - A resubmission carrying a different attempt or a different fingerprint is
 *     a conflict, never an overwrite. Overwriting would let a caller re-point a
 *     correlation at different recipients or a different body while keeping its
 *     idempotency guarantee.
 */

export type DeliveryCorrelationScope = {
  tenantId: string
  organizationId: string | null
  channelId: string
}

/**
 * Caller-supplied correlation. All three parts are required together: a
 * correlation without an attempt cannot be fenced, and an attempt without a
 * fingerprint cannot detect content substitution.
 */
export type DeliveryCorrelationInput = {
  correlationId: string
  attemptId: string
  fingerprint: string
  /**
   * The authenticated actor this send was accepted under. Persisted so the
   * delivery worker can re-check that authority immediately before invoking the
   * provider.
   */
  actorUserId?: string | null
}

export type BindDeliveryCorrelationResult =
  | { status: 'bound'; attempt: ChannelDeliveryAttempt }
  | { status: 'duplicate'; attempt: ChannelDeliveryAttempt }
  | { status: 'conflict'; reason: 'attempt_mismatch' | 'fingerprint_mismatch' }

/**
 * Canonical content fingerprint.
 *
 * Recipients are lower-cased and sorted so a reordered `to:` list is the same
 * logical send, while any change of address, subject, body or thread produces a
 * different fingerprint and therefore a conflict.
 */
export function computeDeliveryFingerprint(input: {
  to: readonly string[]
  cc?: readonly string[]
  bcc?: readonly string[]
  subject: string
  body: string
  threadRef?: string | null
}): string {
  const normalizeAddresses = (values: readonly string[] | undefined): string[] =>
    [...(values ?? [])].map((value) => value.trim().toLowerCase()).sort()

  const canonical = JSON.stringify({
    to: normalizeAddresses(input.to),
    cc: normalizeAddresses(input.cc),
    bcc: normalizeAddresses(input.bcc),
    subject: input.subject,
    body: input.body,
    threadRef: input.threadRef ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

async function findByCorrelation(
  em: EntityManager,
  scope: DeliveryCorrelationScope,
  correlationId: string,
): Promise<ChannelDeliveryAttempt | null> {
  return em.findOne(ChannelDeliveryAttempt, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    channelId: scope.channelId,
    correlationId,
  })
}

function classifyExisting(
  existing: ChannelDeliveryAttempt,
  input: DeliveryCorrelationInput,
): BindDeliveryCorrelationResult {
  if (existing.attemptId !== input.attemptId) {
    return { status: 'conflict', reason: 'attempt_mismatch' }
  }
  if (existing.fingerprint !== input.fingerprint) {
    return { status: 'conflict', reason: 'fingerprint_mismatch' }
  }
  return { status: 'duplicate', attempt: existing }
}

/**
 * Bind a correlation to an attempt, or report the existing binding.
 *
 * The INSERT races against the unique index rather than reading first: two
 * concurrent submissions of the same correlation must produce exactly one
 * binding, and a read-then-write would let both pass the check.
 */
export async function bindDeliveryCorrelation(
  em: EntityManager,
  scope: DeliveryCorrelationScope,
  input: DeliveryCorrelationInput,
): Promise<BindDeliveryCorrelationResult> {
  const existing = await findByCorrelation(em, scope, input.correlationId)
  if (existing) return classifyExisting(existing, input)

  const attempt = em.create(ChannelDeliveryAttempt, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    channelId: scope.channelId,
    correlationId: input.correlationId,
    attemptId: input.attemptId,
    fingerprint: input.fingerprint,
    actorUserId: input.actorUserId ?? null,
    status: 'pending',
    deliveryRevision: 0,
  })
  em.persist(attempt)
  try {
    await em.flush()
    return { status: 'bound', attempt }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // A concurrent submission won the race. Re-read on a clean fork and apply
    // the same equivalence rules to the winner.
    const winner = await findByCorrelation(em.fork(), scope, input.correlationId)
    if (!winner) throw err
    return classifyExisting(winner, input)
  }
}

/**
 * Statuses that can never be superseded. Once a send is definitively `sent` or
 * `failed`, a later or duplicated outcome must not move it — most importantly,
 * a late `unknown` must not un-resolve a confirmed delivery.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['sent', 'failed'])

export type RecordDeliveryOutcomeInput = {
  status: 'sent' | 'failed' | 'unknown'
  providerMessageId?: string | null
  reasonCode?: string | null
  occurredAt?: Date
}

export type RecordDeliveryOutcomeResult =
  | { status: 'recorded'; attempt: ChannelDeliveryAttempt; deliveryRevision: number }
  | { status: 'fenced'; attempt: ChannelDeliveryAttempt; reason: 'already_terminal' }
  | { status: 'missing' }

/**
 * Record an outcome against an attempt, bumping its monotonic revision.
 *
 * Fenced rather than fail-loud: a duplicated worker run reaching a terminal
 * attempt is normal at-least-once behaviour, and the caller only needs to know
 * that its outcome was not applied.
 */
export async function recordDeliveryOutcome(
  em: EntityManager,
  scope: DeliveryCorrelationScope,
  attemptId: string,
  outcome: RecordDeliveryOutcomeInput,
): Promise<RecordDeliveryOutcomeResult> {
  const attempt = await em.findOne(ChannelDeliveryAttempt, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    channelId: scope.channelId,
    attemptId,
  })
  if (!attempt) return { status: 'missing' }
  if (TERMINAL_STATUSES.has(attempt.status)) {
    return { status: 'fenced', attempt, reason: 'already_terminal' }
  }

  attempt.status = outcome.status
  attempt.deliveryRevision += 1
  attempt.providerMessageId = outcome.providerMessageId ?? attempt.providerMessageId ?? null
  attempt.reasonCode = outcome.reasonCode ?? null
  attempt.occurredAt = outcome.occurredAt ?? new Date()
  await em.flush()

  return { status: 'recorded', attempt, deliveryRevision: attempt.deliveryRevision }
}

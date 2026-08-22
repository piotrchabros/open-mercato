import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectOperationalFact, type ConnectFactType } from '../data/entities'

/**
 * Append one operational fact, idempotently.
 *
 * Publication is at-least-once, so the same event WILL arrive twice. The unique
 * index on `(tenant, organization, sourceKey)` is the arbiter: a read-then-write
 * check would let two concurrent deliveries both decide "not recorded yet" and
 * double-count the day. The loser catches the violation and reports success,
 * because a duplicate delivery is not an error.
 *
 * Facts are append-only. Nothing in this module ever updates or deletes one —
 * an aggregate is repaired by recomputing it from the facts, never by patching
 * a counter, so every number on the metrics screen stays traceable to the event
 * that produced it.
 */

export type RecordFactInput = {
  tenantId: string
  organizationId: string
  factType: ConnectFactType
  /** The publishing event's stable `sourceEventId`. */
  sourceEventId: string
  /** The IMMUTABLE cohort day, chosen by the writer, not by wall-clock now. */
  cohortUtcDate: string
  occurredAt: Date
  caseId?: string | null
  conversationId?: string | null
  attemptId?: string | null
  projectionKey?: string | null
  channelId?: string | null
  senderHash?: string | null
  disposition?: string | null
  value?: number | null
  appliedWindowMinutes?: number | null
  appliedCountLimit?: number | null
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505'
}

export function buildFactSourceKey(sourceEventId: string, factType: ConnectFactType): string {
  return `${sourceEventId}:${factType}`
}

export async function recordFact(em: EntityManager, input: RecordFactInput): Promise<boolean> {
  const fork = em.fork()
  fork.persist(
    fork.create(ConnectOperationalFact, {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      factType: input.factType,
      sourceKey: buildFactSourceKey(input.sourceEventId, input.factType),
      cohortUtcDate: input.cohortUtcDate,
      occurredAt: input.occurredAt,
      caseId: input.caseId ?? null,
      conversationId: input.conversationId ?? null,
      attemptId: input.attemptId ?? null,
      projectionKey: input.projectionKey ?? null,
      channelId: input.channelId ?? null,
      senderHash: input.senderHash ?? null,
      disposition: input.disposition ?? null,
      value: input.value ?? null,
      appliedWindowMinutes: input.appliedWindowMinutes ?? null,
      appliedCountLimit: input.appliedCountLimit ?? null,
    }),
  )
  try {
    await fork.flush()
    return true
  } catch (err) {
    // A concurrent delivery won the insert; the fact exists, which is the
    // outcome we wanted. Anything else is a real failure and must surface so
    // the subscriber retries rather than silently losing the day's arithmetic.
    if (isUniqueViolation(err)) return false
    throw err
  }
}

/** UTC calendar day. Reporting is explicitly UTC, so history is never reinterpreted. */
export function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10)
}

/** Read a required string from an untyped event payload. */
export function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value ? value : null
}

export function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function payloadDate(payload: Record<string, unknown>, key: string): Date | null {
  const raw = payloadString(payload, key)
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * The scope every metrics subscriber requires before doing anything.
 *
 * Both ids, always. A fact with a null organization could never be shown
 * without leaking across the authorization boundary reporting is scoped by, so
 * an event missing one is dropped rather than recorded against the tenant.
 */
export function readEventScope(
  payload: Record<string, unknown>,
): { tenantId: string; organizationId: string; sourceEventId: string } | null {
  const tenantId = payloadString(payload, 'tenantId')
  const organizationId = payloadString(payload, 'organizationId')
  const sourceEventId = payloadString(payload, 'sourceEventId')
  if (!tenantId || !organizationId || !sourceEventId) return null
  return { tenantId, organizationId, sourceEventId }
}

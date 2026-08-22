import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectInboundReceipt, type ConnectReceiptDisposition } from '../data/entities'

/**
 * Inbound receipt claiming — Connect's idempotency boundary.
 *
 * The receipt is claimed by a UNIQUE INSERT **before** any non-idempotent work
 * (classification, counters, Case creation). A read-then-create check would let
 * two concurrent deliveries of the same message both decide "not seen yet" and
 * both open a Case; the database constraint is the only arbiter that cannot
 * race. The loser catches the unique violation, looks up the winner, and
 * reports success — a duplicate delivery is not an error.
 */

export const CONNECT_RECEIPT_LEASE_MS = 5 * 60 * 1000

export type ReceiptScope = {
  tenantId: string
  organizationId: string
  channelId: string
  externalMessageId: string
}

export type ClaimReceiptResult =
  | { status: 'claimed'; receipt: ConnectInboundReceipt }
  | { status: 'duplicate'; receipt: ConnectInboundReceipt }
  | { status: 'reclaimed'; receipt: ConnectInboundReceipt }

/** UTC calendar date, frozen on the receipt so metric cohorts never shift. */
export function claimCohortDate(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return code === '23505'
}

/**
 * Claim the receipt for one inbound event.
 *
 * Three outcomes, all of them normal:
 *   - `claimed` — we are the first; proceed with the work.
 *   - `duplicate` — someone already completed it; return their result.
 *   - `reclaimed` — a previous attempt died mid-flight and its lease expired;
 *     we take over. This is what makes a worker crash recoverable instead of
 *     stranding the message forever in `processing`.
 */
export async function claimInboundReceipt(
  em: EntityManager,
  scope: ReceiptScope,
  sourceEventId: string | null,
  now: Date = new Date(),
): Promise<ClaimReceiptResult> {
  const leaseExpiresAt = new Date(now.getTime() + CONNECT_RECEIPT_LEASE_MS)

  const receipt = em.create(ConnectInboundReceipt, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    channelId: scope.channelId,
    externalMessageId: scope.externalMessageId,
    sourceEventId,
    claimCohortUtcDate: claimCohortDate(now),
    status: 'processing',
    leaseExpiresAt,
    attempts: 1,
    lastAttemptAt: now,
  })
  em.persist(receipt)
  try {
    await em.flush()
    return { status: 'claimed', receipt }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
  }

  // Someone else won the insert. Read the winner on a clean fork — the failed
  // flush left this EntityManager's unit of work in an unusable state.
  const fork = em.fork()
  const winner = await fork.findOne(ConnectInboundReceipt, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    channelId: scope.channelId,
    externalMessageId: scope.externalMessageId,
  })
  if (!winner) {
    // The row vanished between the violation and this read — only possible if
    // something deleted it concurrently. Surface it rather than inventing a
    // second claim path.
    throw new Error('[connect] inbound receipt conflict resolved to no winner')
  }

  if (winner.status === 'completed') return { status: 'duplicate', receipt: winner }

  // Still `processing`. If its lease is alive, the other attempt owns it.
  if (winner.leaseExpiresAt && winner.leaseExpiresAt.getTime() > now.getTime()) {
    return { status: 'duplicate', receipt: winner }
  }

  winner.leaseExpiresAt = leaseExpiresAt
  winner.attempts += 1
  winner.lastAttemptAt = now
  await fork.flush()
  return { status: 'reclaimed', receipt: winner }
}

export type CompleteReceiptInput = {
  disposition: ConnectReceiptDisposition
  caseId?: string | null
  terminalReason?: string | null
}

/**
 * Close a receipt out.
 *
 * The database check constraint enforces the shape (open/attach must name a
 * Case; suppressed/dead-lettered must not), so a wrong disposition fails loudly
 * here rather than producing a receipt that no metric can interpret.
 */
export function completeReceipt(
  receipt: ConnectInboundReceipt,
  input: CompleteReceiptInput,
  now: Date = new Date(),
): void {
  receipt.status = 'completed'
  receipt.disposition = input.disposition
  receipt.caseId = input.caseId ?? null
  receipt.terminalReason = input.terminalReason ?? null
  receipt.leaseExpiresAt = null
  receipt.lastAttemptAt = now
}

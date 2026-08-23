import type { EntityManager } from '@mikro-orm/postgresql'

/**
 * Canonical contact-root count, for a cost-per-contact denominator.
 *
 * The problem it solves: once splitting exists, counting Cases stops being a
 * count of contacts. Splitting one mis-grouped Case into three does not mean
 * three customers got in touch — it means one did, and an operator corrected the
 * grouping. A denominator that grows when a supervisor fixes a mistake makes
 * cost-per-contact go DOWN for doing the right thing.
 *
 * So this counts ROOTS: Cases whose `split_from_case_id` is null. A split child
 * is a re-grouping of contact that was already counted under its parent, and it
 * never increments the denominator.
 *
 * Merge is deliberately out of scope for v1. Two duplicate Cases genuinely were
 * two arrivals, and whether consolidating them should retroactively make them
 * one contact is a reporting policy question, not a Connect one. Answering it
 * here would freeze that policy into a versioned contract before anyone has
 * decided it.
 */

export const CONNECT_CONTACT_DENOMINATOR_CONTRACT_VERSION = 'connect.contact_root_created.v1' as const

/** A year plus a leap day. Longer ranges are a reporting job, not a live read. */
export const CONNECT_DENOMINATOR_MAX_RANGE_DAYS = 366

export type ConnectContactDenominatorInput = Readonly<{
  tenantId: string
  organizationId: string
  /** Inclusive ISO instant. */
  from: string
  /** Exclusive ISO instant. */
  to: string
}>

export type ConnectContactDenominatorResult = Readonly<{
  contractVersion: typeof CONNECT_CONTACT_DENOMINATOR_CONTRACT_VERSION
  generatedAt: string
  count: number
}>

export type ConnectContactDenominatorReader = {
  countCanonicalRoots(input: ConnectContactDenominatorInput): Promise<ConnectContactDenominatorResult>
}

const DAY_MS = 24 * 60 * 60 * 1000

export class ConnectDenominatorRangeError extends Error {
  override name = 'ConnectDenominatorRangeError'
  constructor(readonly reason: 'invalid_range' | 'empty_range' | 'range_too_large') {
    super(`[internal] connect_denominator_${reason}`)
  }
}

export function validateDenominatorRange(from: string, to: string): { from: Date; to: Date } {
  const start = new Date(from)
  const end = new Date(to)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new ConnectDenominatorRangeError('invalid_range')
  }
  // Half-open and non-empty: `[from, from)` selects nothing, and returning 0 for
  // it would look like a real answer rather than a malformed question.
  if (end.getTime() <= start.getTime()) throw new ConnectDenominatorRangeError('empty_range')
  if (end.getTime() - start.getTime() > CONNECT_DENOMINATOR_MAX_RANGE_DAYS * DAY_MS) {
    throw new ConnectDenominatorRangeError('range_too_large')
  }
  return { from: start, to: end }
}

export function createConnectContactDenominatorReader(
  em: EntityManager,
  now: () => Date = () => new Date(),
): ConnectContactDenominatorReader {
  return {
    async countCanonicalRoots(input) {
      const range = validateDenominatorRange(input.from, input.to)
      const forked = em.fork()
      const rows = (await forked.execute(
        `select count(*) as "roots"
           from "connect_cases"
          where "tenant_id" = ?
            and "organization_id" = ?
            and "deleted_at" is null
            and "split_from_case_id" is null
            and "created_at" >= ?
            and "created_at" < ?`,
        [input.tenantId, input.organizationId, range.from, range.to],
      )) as Array<{ roots: string | number }>

      return Object.freeze({
        contractVersion: CONNECT_CONTACT_DENOMINATOR_CONTRACT_VERSION,
        generatedAt: now().toISOString(),
        // A scalar and nothing else. Returning the ids would make this a
        // cross-module enumeration of an organization's Cases, which is not what
        // a denominator needs and not what the caller was authorized for.
        count: Number(rows[0]?.roots ?? 0),
      })
    },
  }
}

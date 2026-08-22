import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectInboundReceipt } from '../../data/entities'
import { CONNECT_RECEIPT_LEASE_MS, claimCohortDate, claimInboundReceipt, completeReceipt } from '../receipt-claim'

/**
 * The receipt is Connect's idempotency boundary. It is claimed by a unique
 * INSERT before any non-idempotent work, because a read-then-create check would
 * let two concurrent deliveries of the same message both decide "not seen yet"
 * and both open a Case.
 */

const SCOPE = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  channelId: '44444444-4444-4444-8444-444444444444',
  externalMessageId: '55555555-5555-4555-8555-555555555555',
}
const NOW = new Date('2026-08-22T12:00:00.000Z')

type Row = Record<string, unknown>

function createEm(existing: Row | null): EntityManager {
  const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' })
  // Only the INSERT flush conflicts; the reclaim path flushes again afterwards
  // and must succeed.
  let flushes = 0
  const em = {
    create: jest.fn((_entity: unknown, data: Row) => ({ id: 'receipt-new', ...data })),
    persist: jest.fn(),
    flush: jest.fn(async () => {
      flushes += 1
      if (existing && flushes === 1) throw uniqueViolation
    }),
    findOne: jest.fn(async (entity: unknown) => (entity === ConnectInboundReceipt ? existing : null)),
  } as unknown as EntityManager
  ;(em as unknown as { fork: () => EntityManager }).fork = () => em
  return em
}

describe('claimCohortDate', () => {
  // Frozen on the receipt so a retry cannot shift a historical metric cohort.
  it('is the UTC calendar date', () => {
    expect(claimCohortDate(new Date('2026-08-22T23:59:59.000Z'))).toBe('2026-08-22')
    expect(claimCohortDate(new Date('2026-08-23T00:00:01.000Z'))).toBe('2026-08-23')
  })
})

describe('claimInboundReceipt', () => {
  it('claims a fresh receipt with a lease', async () => {
    const em = createEm(null)
    const result = await claimInboundReceipt(em, SCOPE, 'event-1', NOW)
    expect(result.status).toBe('claimed')
    expect(result.receipt).toMatchObject({
      status: 'processing',
      attempts: 1,
      claimCohortUtcDate: '2026-08-22',
      sourceEventId: 'event-1',
    })
    expect((result.receipt.leaseExpiresAt as Date).getTime()).toBe(NOW.getTime() + CONNECT_RECEIPT_LEASE_MS)
  })

  // The loser of the insert race resolves the winner and reports success — a
  // duplicate delivery is normal, not an error.
  it('reports a completed winner as a duplicate', async () => {
    const winner = { id: 'receipt-1', status: 'completed', disposition: 'opened', leaseExpiresAt: null, attempts: 1 }
    const result = await claimInboundReceipt(createEm(winner), SCOPE, 'event-1', NOW)
    expect(result).toEqual({ status: 'duplicate', receipt: winner })
  })

  it('defers to a winner whose lease is still alive', async () => {
    const winner = {
      id: 'receipt-1',
      status: 'processing',
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      attempts: 1,
    }
    const result = await claimInboundReceipt(createEm(winner), SCOPE, 'event-1', NOW)
    expect(result.status).toBe('duplicate')
    expect(winner.attempts).toBe(1)
  })

  // Without reclaim, a crash mid-ingest strands the message forever: the claim
  // already told the bus we had it, so it is never redelivered either.
  it('reclaims a receipt whose lease expired', async () => {
    const stranded = {
      id: 'receipt-1',
      status: 'processing',
      leaseExpiresAt: new Date(NOW.getTime() - 60_000),
      attempts: 2,
    }
    const result = await claimInboundReceipt(createEm(stranded), SCOPE, 'event-1', NOW)
    expect(result.status).toBe('reclaimed')
    expect(stranded.attempts).toBe(3)
    expect((stranded.leaseExpiresAt as Date).getTime()).toBe(NOW.getTime() + CONNECT_RECEIPT_LEASE_MS)
  })

  it('rethrows a non-unique failure rather than inventing a second claim path', async () => {
    const em = createEm(null)
    ;(em.flush as jest.Mock).mockRejectedValueOnce(new Error('connection reset'))
    await expect(claimInboundReceipt(em, SCOPE, null, NOW)).rejects.toThrow('connection reset')
  })
})

describe('completeReceipt', () => {
  it.each([
    ['opened', 'case-1'],
    ['attached', 'case-1'],
  ] as const)('records a %s disposition with its Case', (disposition, caseId) => {
    const receipt = { status: 'processing', leaseExpiresAt: new Date() } as never as InstanceType<typeof ConnectInboundReceipt>
    completeReceipt(receipt, { disposition, caseId }, NOW)
    expect(receipt).toMatchObject({ status: 'completed', disposition, caseId, leaseExpiresAt: null })
  })

  it.each(['suppressed', 'dead_lettered'] as const)('records a %s disposition with no Case', (disposition) => {
    const receipt = { status: 'processing' } as never as InstanceType<typeof ConnectInboundReceipt>
    completeReceipt(receipt, { disposition, terminalReason: 'reason' }, NOW)
    expect(receipt).toMatchObject({ status: 'completed', disposition, caseId: null, terminalReason: 'reason' })
  })
})

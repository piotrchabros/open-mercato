import type { EntityManager } from '@mikro-orm/postgresql'
import { ChannelDeliveryAttempt } from '../../data/entities'
import {
  bindDeliveryCorrelation,
  computeDeliveryFingerprint,
  recordDeliveryOutcome,
} from '../delivery-correlation'

/**
 * The correlation record is what lets a caller that lost a send response ask
 * "did it happen?" instead of resending. These tests pin the three properties
 * that make that safe: the binding is immutable, a duplicate never re-enqueues,
 * and a terminal outcome cannot be regressed by a late one.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const CHANNEL = '44444444-4444-4444-8444-444444444444'

const scope = { tenantId: TENANT, organizationId: ORG, channelId: CHANNEL }

type AttemptRow = Partial<ChannelDeliveryAttempt> & { attemptId: string; correlationId: string }

function createEm(rows: AttemptRow[]): EntityManager {
  const em = {
    findOne: jest.fn(async (entity: unknown, where: Record<string, unknown>) => {
      if (entity !== ChannelDeliveryAttempt) return null
      return (
        rows.find((row) => {
          if (row.tenantId !== where.tenantId) return false
          if (row.organizationId !== where.organizationId) return false
          if (row.channelId !== where.channelId) return false
          if (where.correlationId != null) return row.correlationId === where.correlationId
          if (where.attemptId != null) return row.attemptId === where.attemptId
          return false
        }) ?? null
      )
    }),
    create: jest.fn((_entity: unknown, data: AttemptRow) => {
      const row = { id: `attempt-${rows.length + 1}`, ...data }
      return row
    }),
    persist: jest.fn((row: AttemptRow) => {
      rows.push(row)
    }),
    flush: jest.fn(async () => undefined),
  } as unknown as EntityManager
  ;(em as unknown as { fork: () => EntityManager }).fork = () => em
  return em
}

function existingAttempt(overrides: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: 'attempt-existing',
    tenantId: TENANT,
    organizationId: ORG,
    channelId: CHANNEL,
    correlationId: 'corr-1',
    attemptId: 'att-1',
    fingerprint: 'fp-1',
    status: 'pending',
    deliveryRevision: 0,
    ...overrides,
  } as AttemptRow
}

describe('computeDeliveryFingerprint', () => {
  // A reordered or differently-cased recipient list is the same logical send;
  // treating it as a conflict would make idempotency useless in practice.
  it('is stable across recipient order and case', () => {
    const a = computeDeliveryFingerprint({
      to: ['Bob@Example.com', 'alice@example.com'],
      subject: 'Hi',
      body: 'text',
    })
    const b = computeDeliveryFingerprint({
      to: ['alice@example.com', 'bob@example.com'],
      subject: 'Hi',
      body: 'text',
    })
    expect(a).toBe(b)
  })

  it.each([
    ['recipient', { to: ['carol@example.com'], subject: 'Hi', body: 'text' }],
    ['subject', { to: ['alice@example.com'], subject: 'Different', body: 'text' }],
    ['body', { to: ['alice@example.com'], subject: 'Hi', body: 'other' }],
    ['thread', { to: ['alice@example.com'], subject: 'Hi', body: 'text', threadRef: 'thread-9' }],
  ])('changes when the %s changes', (_label, input) => {
    const base = computeDeliveryFingerprint({
      to: ['alice@example.com'],
      subject: 'Hi',
      body: 'text',
    })
    expect(computeDeliveryFingerprint(input as never)).not.toBe(base)
  })

  it('separates cc and bcc from to', () => {
    const withTo = computeDeliveryFingerprint({
      to: ['alice@example.com', 'bob@example.com'],
      subject: 'Hi',
      body: 'text',
    })
    const withCc = computeDeliveryFingerprint({
      to: ['alice@example.com'],
      cc: ['bob@example.com'],
      subject: 'Hi',
      body: 'text',
    })
    expect(withTo).not.toBe(withCc)
  })
})

describe('bindDeliveryCorrelation', () => {
  it('binds a fresh correlation', async () => {
    const rows: AttemptRow[] = []
    const result = await bindDeliveryCorrelation(createEm(rows), scope, {
      correlationId: 'corr-1',
      attemptId: 'att-1',
      fingerprint: 'fp-1',
      actorUserId: 'user-1',
    })
    expect(result.status).toBe('bound')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ attemptId: 'att-1', status: 'pending', actorUserId: 'user-1' })
  })

  it('reports an identical resubmission as a duplicate, creating nothing', async () => {
    const rows = [existingAttempt()]
    const result = await bindDeliveryCorrelation(createEm(rows), scope, {
      correlationId: 'corr-1',
      attemptId: 'att-1',
      fingerprint: 'fp-1',
    })
    expect(result.status).toBe('duplicate')
    expect(rows).toHaveLength(1)
  })

  // Swapping the attempt id would let a caller keep a correlation's idempotency
  // guarantee while pointing it at a different send.
  it('rejects a reused correlation carrying a different attempt', async () => {
    const rows = [existingAttempt()]
    const result = await bindDeliveryCorrelation(createEm(rows), scope, {
      correlationId: 'corr-1',
      attemptId: 'att-2',
      fingerprint: 'fp-1',
    })
    expect(result).toEqual({ status: 'conflict', reason: 'attempt_mismatch' })
    expect(rows[0].attemptId).toBe('att-1')
  })

  it('rejects a resubmission whose content changed', async () => {
    const rows = [existingAttempt()]
    const result = await bindDeliveryCorrelation(createEm(rows), scope, {
      correlationId: 'corr-1',
      attemptId: 'att-1',
      fingerprint: 'fp-2',
    })
    expect(result).toEqual({ status: 'conflict', reason: 'fingerprint_mismatch' })
    expect(rows[0].fingerprint).toBe('fp-1')
  })

  // The same correlation value in two organizations is two independent sends —
  // uniqueness is scoped, not global.
  it('does not see a correlation bound in a sibling organization', async () => {
    const rows = [existingAttempt({ organizationId: '33333333-3333-4333-8333-333333333333' })]
    const result = await bindDeliveryCorrelation(createEm(rows), scope, {
      correlationId: 'corr-1',
      attemptId: 'att-9',
      fingerprint: 'fp-9',
    })
    expect(result.status).toBe('bound')
  })

  it('does not see a correlation bound in another tenant', async () => {
    const rows = [existingAttempt({ tenantId: '99999999-9999-4999-8999-999999999999' })]
    const result = await bindDeliveryCorrelation(createEm(rows), scope, {
      correlationId: 'corr-1',
      attemptId: 'att-9',
      fingerprint: 'fp-9',
    })
    expect(result.status).toBe('bound')
  })

  it('does not see a correlation bound on another channel', async () => {
    const rows = [existingAttempt({ channelId: 'other-channel' })]
    const result = await bindDeliveryCorrelation(createEm(rows), scope, {
      correlationId: 'corr-1',
      attemptId: 'att-9',
      fingerprint: 'fp-9',
    })
    expect(result.status).toBe('bound')
  })
})

describe('recordDeliveryOutcome', () => {
  it('records an outcome and bumps the revision', async () => {
    const rows = [existingAttempt()]
    const result = await recordDeliveryOutcome(createEm(rows), scope, 'att-1', {
      status: 'sent',
      providerMessageId: 'provider-1',
    })
    expect(result).toMatchObject({ status: 'recorded', deliveryRevision: 1 })
    expect(rows[0].status).toBe('sent')
    expect(rows[0].providerMessageId).toBe('provider-1')
  })

  it('lets an unknown outcome be superseded later', async () => {
    const rows = [existingAttempt({ status: 'unknown', deliveryRevision: 1 })]
    const result = await recordDeliveryOutcome(createEm(rows), scope, 'att-1', { status: 'sent' })
    expect(result).toMatchObject({ status: 'recorded', deliveryRevision: 2 })
    expect(rows[0].status).toBe('sent')
  })

  // The critical fence: a late or duplicated outcome must not un-resolve a
  // delivery that was already definitively sent.
  it.each(['sent', 'failed'] as const)('fences a late outcome against a terminal %s', async (terminal) => {
    const rows = [existingAttempt({ status: terminal, deliveryRevision: 3 })]
    const result = await recordDeliveryOutcome(createEm(rows), scope, 'att-1', { status: 'unknown' })
    expect(result).toMatchObject({ status: 'fenced', reason: 'already_terminal' })
    expect(rows[0].status).toBe(terminal)
    expect(rows[0].deliveryRevision).toBe(3)
  })

  it('reports a missing attempt without touching anything', async () => {
    const rows: AttemptRow[] = []
    const result = await recordDeliveryOutcome(createEm(rows), scope, 'att-nope', { status: 'sent' })
    expect(result).toEqual({ status: 'missing' })
  })
})

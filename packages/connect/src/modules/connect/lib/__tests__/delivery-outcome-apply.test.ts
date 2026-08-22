import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectCase, ConnectOutboundAttempt, ConnectUnknownDelivery } from '../../data/entities'
import { applyDeliveryOutcome, type DeliveryOutcomePayload } from '../delivery-outcome-apply'
import { statusAfterFirstOutbound } from '../case-lifecycle-outbound'

/**
 * Outcomes arrive out of order, more than once, and long after the UI moved on.
 * These tests pin that a duplicate cannot undo a later one, that a late
 * `unknown` cannot un-resolve a confirmed send, and that only a CONFIRMED send
 * hands the case back to the customer.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'

type Row = Record<string, unknown>

function createEm(fixture: { attempt?: Row | null; caseRow?: Row | null; unknown?: Row | null }) {
  const created: Row[] = []
  const em = {
    findOne: jest.fn(async (entity: unknown, where: Row) => {
      if (entity === ConnectOutboundAttempt) {
        const attempt = fixture.attempt
        if (!attempt) return null
        return attempt.id === where.id &&
          attempt.tenantId === where.tenantId &&
          attempt.hubCorrelationId === where.hubCorrelationId
          ? attempt
          : null
      }
      if (entity === ConnectCase) return fixture.caseRow ?? null
      if (entity === ConnectUnknownDelivery) return fixture.unknown ?? null
      return null
    }),
    create: jest.fn((_entity: unknown, data: Row) => {
      const row = { id: `row-${created.length + 1}`, ...data }
      created.push(row)
      return row
    }),
    persist: jest.fn(),
    flush: jest.fn(async () => undefined),
  } as unknown as EntityManager
  return { em, created }
}

function attempt(overrides: Row = {}): Row {
  return {
    id: 'attempt-1',
    tenantId: TENANT,
    organizationId: ORG,
    caseId: 'case-1',
    hubCorrelationId: 'corr-1',
    messageId: 'message-1',
    status: 'sending',
    deliveryRevision: 1,
    // The immutable enqueue cohort the outcome event reports, so a send
    // confirmed days later still counts against the day it was queued.
    createdAt: new Date('2026-08-22T08:00:00.000Z'),
    ...overrides,
  }
}

function payload(overrides: Partial<DeliveryOutcomePayload> = {}): DeliveryOutcomePayload {
  return {
    tenantId: TENANT,
    organizationId: ORG,
    channelId: 'channel-1',
    correlationId: 'corr-1',
    attemptId: 'attempt-1',
    deliveryRevision: 2,
    status: 'sent',
    occurredAt: '2026-08-22T10:00:00.000Z',
    ...overrides,
  }
}

describe('statusAfterFirstOutbound', () => {
  it('hands an in-progress case back to the customer', () => {
    expect(statusAfterFirstOutbound('in_progress')).toBe('waiting_customer')
  })

  // A `new` case has not been claimed; advancing it would silently empty the
  // triage queue.
  it.each(['new', 'waiting_customer', 'resolved', 'closed'] as const)('leaves %s alone', (status) => {
    expect(statusAfterFirstOutbound(status)).toBe(status)
  })
})

describe('applyDeliveryOutcome', () => {
  it('settles a sending attempt as sent and moves the case', async () => {
    const row = attempt()
    const caseRow = { id: 'case-1', status: 'in_progress' }
    const { em } = createEm({ attempt: row, caseRow })
    const result = await applyDeliveryOutcome(em, payload({ providerMessageId: 'provider-1' }))
    expect(result).toEqual({ status: 'applied', attemptStatus: 'sent', caseTransitioned: true })
    expect(row.providerMessageId).toBe('provider-1')
    expect(caseRow.status).toBe('waiting_customer')
  })

  // Only a confirmed send moves the case; otherwise the queue shows work as
  // handed over when nothing reached the customer.
  it('does not move the case on a failure', async () => {
    const caseRow = { id: 'case-1', status: 'in_progress' }
    const { em } = createEm({ attempt: attempt(), caseRow })
    const result = await applyDeliveryOutcome(em, payload({ status: 'failed', reasonCode: 'rejected' }))
    expect(result).toMatchObject({ attemptStatus: 'failed', caseTransitioned: false })
    expect(caseRow.status).toBe('in_progress')
  })

  it('requires the correlation to match the attempt', async () => {
    const { em } = createEm({ attempt: attempt({ hubCorrelationId: 'someone-elses' }) })
    const result = await applyDeliveryOutcome(em, payload())
    expect(result).toEqual({ status: 'ignored', reason: 'unknown_attempt' })
  })

  it('ignores a stale or duplicated revision', async () => {
    const row = attempt({ deliveryRevision: 5 })
    const { em } = createEm({ attempt: row })
    const result = await applyDeliveryOutcome(em, payload({ deliveryRevision: 5 }))
    expect(result).toEqual({ status: 'ignored', reason: 'stale_revision' })
    expect(row.status).toBe('sending')
  })

  // The critical fence: a late unknown must not un-resolve a confirmed send.
  it('never regresses a terminal decision', async () => {
    const row = attempt({ status: 'sent', deliveryRevision: 3 })
    const { em } = createEm({ attempt: row })
    const result = await applyDeliveryOutcome(em, payload({ status: 'unknown', deliveryRevision: 9 }))
    expect(result).toEqual({ status: 'ignored', reason: 'conflict' })
    expect(row.status).toBe('sent')
  })

  it('reports a repeated identical terminal outcome as already terminal', async () => {
    const row = attempt({ status: 'sent', deliveryRevision: 3 })
    const { em } = createEm({ attempt: row })
    const result = await applyDeliveryOutcome(em, payload({ status: 'sent', deliveryRevision: 9 }))
    expect(result).toEqual({ status: 'ignored', reason: 'terminal' })
  })

  it('opens a recovery-queue row for an unknown outcome', async () => {
    const { em, created } = createEm({ attempt: attempt() })
    const result = await applyDeliveryOutcome(em, payload({ status: 'unknown' }))
    expect(result).toMatchObject({ attemptStatus: 'unknown' })
    expect(created.some((row) => row.attemptId === 'attempt-1')).toBe(true)
  })

  // Repeated unknown outcomes must not pile up duplicate queue rows.
  it('reuses an existing recovery row', async () => {
    const existing = { id: 'unknown-1', attemptId: 'attempt-1', lastCheckedAt: null as Date | null }
    const { em, created } = createEm({ attempt: attempt(), unknown: existing })
    await applyDeliveryOutcome(em, payload({ status: 'unknown' }))
    expect(existing.lastCheckedAt).toBeInstanceOf(Date)
    expect(created.filter((row) => row.attemptId === 'attempt-1')).toHaveLength(0)
  })
})

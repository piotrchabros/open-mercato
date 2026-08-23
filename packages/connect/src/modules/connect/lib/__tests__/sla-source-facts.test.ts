import type { EntityManager } from '@mikro-orm/postgresql'
import {
  ConnectCaseGenerationFact,
  ConnectCaseWaitFact,
  ConnectDomainOutboxEntry,
  ConnectOutboundDeliveryFact,
} from '../../data/entities'
import {
  CONNECT_SLA_FACT_SCHEMA_VERSION,
  findGenerationStartedAt,
  findOpenWait,
  recordDeliveryConfirmed,
  recordGenerationResolved,
  recordGenerationStarted,
  recordWaitEnded,
  recordWaitStarted,
} from '../sla-source-facts'

/**
 * Boundary discipline is the whole contract: a wait that opens twice, or closes
 * without having opened, produces an interval a consumer cannot interpret. So
 * these tests pin what does NOT get written at least as hard as what does.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const CASE = '33333333-3333-4333-8333-333333333333'
const CHANNEL = '44444444-4444-4444-8444-444444444444'
const SCOPE = { tenantId: TENANT, organizationId: ORG }

type Row = Record<string, unknown>

/**
 * An EntityManager stand-in that keeps rows per entity class, so the
 * check-then-insert guards are exercised against something that can actually
 * answer "does this already exist".
 */
function createEm(seed: { generation?: Row[]; wait?: Row[]; delivery?: Row[] } = {}) {
  const store = new Map<unknown, Row[]>([
    [ConnectCaseGenerationFact, [...(seed.generation ?? [])]],
    [ConnectCaseWaitFact, [...(seed.wait ?? [])]],
    [ConnectOutboundDeliveryFact, [...(seed.delivery ?? [])]],
    [ConnectDomainOutboxEntry, []],
  ])

  function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => row[key] === value)
  }

  // `create` only builds the row; `persist` is what commits it, so a guard that
  // returns before persisting provably leaves the table untouched.
  const em = {
    findOne: jest.fn(async (entity: unknown, where: Row, options?: { orderBy?: Row }) => {
      const rows = (store.get(entity) ?? []).filter((row) => matches(row, where))
      if (rows.length === 0) return null
      if (!options?.orderBy) return rows[0]
      // Newest boundary first, which is what "is a wait open" depends on.
      return [...rows].sort((left, right) => {
        const leftAt = (left.occurredAt as Date).getTime()
        const rightAt = (right.occurredAt as Date).getTime()
        if (leftAt !== rightAt) return rightAt - leftAt
        return String(right.id).localeCompare(String(left.id))
      })[0]
    }),
    create: jest.fn((entity: unknown, data: Row) => ({
      id: `row-${(store.get(entity) ?? []).length + 1}`,
      __entity: entity,
      ...data,
    })),
    persist: jest.fn((row: Row) => {
      store.get((row as { __entity?: unknown }).__entity)?.push(row)
    }),
    flush: jest.fn(async () => undefined),
  } as unknown as EntityManager

  return {
    em,
    rows: (entity: unknown) => store.get(entity) ?? [],
    outbox: () => store.get(ConnectDomainOutboxEntry) ?? [],
  }
}

const AT = new Date('2026-08-23T10:00:00.000Z')
const LATER = new Date('2026-08-23T12:00:00.000Z')

describe('generation facts', () => {
  it('opens round 0 with a start boundary and an announcement', async () => {
    const { em, rows, outbox } = createEm()
    const fact = await recordGenerationStarted(em, {
      ...SCOPE,
      sourceEventId: 'connect.case.generation_started:receipt-1',
      caseId: CASE,
      generation: 0,
      channelId: CHANNEL,
      cause: 'opened',
      occurredAt: AT,
    })

    expect(fact).not.toBeNull()
    expect(rows(ConnectCaseGenerationFact)).toHaveLength(1)
    expect(rows(ConnectCaseGenerationFact)[0]).toMatchObject({
      boundary: 'started',
      cause: 'opened',
      startedAt: AT,
      resolvedAt: null,
      generation: 0,
    })
    expect(outbox()[0]).toMatchObject({ eventType: 'connect.case.generation_started' })
    expect((outbox()[0] as { payload: Row }).payload).toMatchObject({
      schemaVersion: CONNECT_SLA_FACT_SCHEMA_VERSION,
      caseId: CASE,
      generation: 0,
      occurredAt: AT.toISOString(),
    })
  })

  it('skips a replayed write instead of aborting the caller transaction', async () => {
    const { em, rows, outbox } = createEm({
      generation: [
        {
          ...SCOPE,
          id: 'existing',
          sourceEventId: 'connect.case.generation_started:receipt-1',
          caseId: CASE,
          generation: 0,
          boundary: 'started',
          occurredAt: AT,
        },
      ],
    })
    const fact = await recordGenerationStarted(em, {
      ...SCOPE,
      sourceEventId: 'connect.case.generation_started:receipt-1',
      caseId: CASE,
      generation: 0,
      channelId: CHANNEL,
      cause: 'opened',
      occurredAt: LATER,
    })

    expect(fact).toBeNull()
    expect(rows(ConnectCaseGenerationFact)).toHaveLength(1)
    expect(outbox()).toHaveLength(0)
  })

  it('carries the round start onto its resolution boundary', async () => {
    const { em, rows } = createEm({
      generation: [
        {
          ...SCOPE,
          id: 'start',
          sourceEventId: 'start',
          caseId: CASE,
          generation: 1,
          boundary: 'started',
          startedAt: AT,
          occurredAt: AT,
        },
      ],
    })
    const startedAt = await findGenerationStartedAt(em, SCOPE, CASE, 1, new Date(0))
    expect(startedAt).toBe(AT)

    await recordGenerationResolved(em, {
      ...SCOPE,
      sourceEventId: 'connect.case.generation_resolved:case:1',
      caseId: CASE,
      generation: 1,
      channelId: CHANNEL,
      startedAt,
      occurredAt: LATER,
    })
    expect(rows(ConnectCaseGenerationFact)[1]).toMatchObject({
      boundary: 'resolved',
      cause: 'resolved',
      startedAt: AT,
      resolvedAt: LATER,
    })
  })

  it('falls back to the caller default when history predates the fact tables', async () => {
    const { em } = createEm()
    const fallback = new Date('2026-01-01T00:00:00.000Z')
    await expect(findGenerationStartedAt(em, SCOPE, CASE, 0, fallback)).resolves.toBe(fallback)
  })
})

describe('wait facts', () => {
  it('opens a wait and reports it as the open one', async () => {
    const { em, rows } = createEm()
    await recordWaitStarted(em, {
      ...SCOPE,
      sourceEventId: 'connect.case.customer_wait_started:attempt-1:2',
      caseId: CASE,
      generation: 0,
      occurredAt: AT,
    })
    expect(rows(ConnectCaseWaitFact)).toHaveLength(1)
    await expect(findOpenWait(em, SCOPE, CASE, 0)).resolves.toMatchObject({ boundary: 'started' })
  })

  it('does not reopen a wait that is already open', async () => {
    // A second confirmed reply while the customer is already being waited on is
    // not a new interval; counting it as one would double the wait.
    const { em, rows } = createEm()
    await recordWaitStarted(em, {
      ...SCOPE,
      sourceEventId: 'first',
      caseId: CASE,
      generation: 0,
      occurredAt: AT,
    })
    const second = await recordWaitStarted(em, {
      ...SCOPE,
      sourceEventId: 'second',
      caseId: CASE,
      generation: 0,
      occurredAt: LATER,
    })
    expect(second).toBeNull()
    expect(rows(ConnectCaseWaitFact)).toHaveLength(1)
  })

  it('closes an open wait carrying its original start', async () => {
    const { em, rows, outbox } = createEm()
    await recordWaitStarted(em, {
      ...SCOPE,
      sourceEventId: 'start',
      caseId: CASE,
      generation: 0,
      occurredAt: AT,
    })
    await recordWaitEnded(em, {
      ...SCOPE,
      sourceEventId: 'end',
      caseId: CASE,
      generation: 0,
      occurredAt: LATER,
    })
    expect(rows(ConnectCaseWaitFact)[1]).toMatchObject({
      boundary: 'ended',
      startedAt: AT,
      endedAt: LATER,
    })
    expect(outbox().map((entry) => (entry as { eventType: string }).eventType)).toEqual([
      'connect.case.customer_wait_started',
      'connect.case.customer_wait_ended',
    ])
    await expect(findOpenWait(em, SCOPE, CASE, 0)).resolves.toBeNull()
  })

  it('writes nothing when no wait is open', async () => {
    const { em, rows, outbox } = createEm()
    const closed = await recordWaitEnded(em, {
      ...SCOPE,
      sourceEventId: 'end',
      caseId: CASE,
      generation: 0,
      occurredAt: LATER,
    })
    expect(closed).toBeNull()
    expect(rows(ConnectCaseWaitFact)).toHaveLength(0)
    expect(outbox()).toHaveLength(0)
  })

  it('keeps rounds independent', async () => {
    // A wait open on round 0 must not satisfy a close on round 1, or a reopen
    // would silently inherit the previous round's interval.
    const { em } = createEm()
    await recordWaitStarted(em, {
      ...SCOPE,
      sourceEventId: 'start-0',
      caseId: CASE,
      generation: 0,
      occurredAt: AT,
    })
    await expect(findOpenWait(em, SCOPE, CASE, 1)).resolves.toBeNull()
  })
})

describe('delivery facts', () => {
  it('records the enqueue round and the frozen evidence verbatim', async () => {
    const { em, rows, outbox } = createEm()
    await recordDeliveryConfirmed(em, {
      ...SCOPE,
      sourceEventId: 'connect.outbound.delivery_confirmed:attempt-1:2',
      caseId: CASE,
      generation: 3,
      outboundMessageId: 'message-1',
      attemptId: 'attempt-1',
      deliveryRevision: 2,
      confirmedAt: AT,
      responseEvidence: 'human',
      responseEvidenceVersion: 1,
      authorUserId: 'author-1',
      acceptedByUserId: null,
      occurredAt: AT,
    })
    expect(rows(ConnectOutboundDeliveryFact)[0]).toMatchObject({
      generation: 3,
      deliveryRevision: 2,
      responseEvidence: 'human',
      responseEvidenceVersion: 1,
    })
    expect(outbox()[0]).toMatchObject({
      eventType: 'connect.outbound.delivery_confirmed',
      aggregateVersion: 2,
    })
  })

  it('ignores a redelivered outcome for the same attempt revision', async () => {
    const { em, rows } = createEm({
      delivery: [
        {
          ...SCOPE,
          id: 'existing',
          sourceEventId: 'connect.outbound.delivery_confirmed:attempt-1:2',
        },
      ],
    })
    const fact = await recordDeliveryConfirmed(em, {
      ...SCOPE,
      sourceEventId: 'connect.outbound.delivery_confirmed:attempt-1:2',
      caseId: CASE,
      generation: 0,
      outboundMessageId: 'message-1',
      attemptId: 'attempt-1',
      deliveryRevision: 2,
      confirmedAt: AT,
      responseEvidence: 'unknown',
      responseEvidenceVersion: 1,
      authorUserId: null,
      acceptedByUserId: null,
      occurredAt: AT,
    })
    expect(fact).toBeNull()
    expect(rows(ConnectOutboundDeliveryFact)).toHaveLength(1)
  })
})

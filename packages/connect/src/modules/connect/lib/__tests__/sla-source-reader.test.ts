import type { EntityManager } from '@mikro-orm/postgresql'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import {
  CONNECT_SLA_EPOCH_CURSOR,
  createConnectCaseSlaReader,
} from '../sla-source-reader'

/**
 * The reader is the only supported way into the fact tables, so its scoping and
 * paging are load-bearing. These tests pin the two ways it could quietly go
 * wrong: dropping a scope predicate, and coercing a corrupted enum into a value
 * that reads as ordinary missing evidence.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const ORG = '22222222-2222-4222-8222-222222222222'
const OTHER_ID = '33333333-3333-4333-8333-333333333333'
const SCOPE = { tenantId: TENANT, organizationId: ORG }

const THROUGH = { occurredAt: '2026-08-23T12:00:00.000Z', id: OTHER_ID }

type Row = Record<string, unknown>

function createReader(rowsByCall: Row[][]) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let index = 0
  const em = {
    execute: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      return rowsByCall[index++] ?? []
    }),
    findOne: jest.fn(async () => null),
  } as unknown as EntityManager
  const container = { resolve: () => undefined } as unknown as AppContainer
  return { reader: createConnectCaseSlaReader(em, container), calls }
}

function deliveryRow(overrides: Row = {}): Row {
  return {
    id: OTHER_ID,
    case_id: OTHER_ID,
    generation: 1,
    outbound_message_id: OTHER_ID,
    attempt_id: OTHER_ID,
    delivery_revision: 2,
    confirmed_at: new Date('2026-08-23T11:00:00.000Z'),
    response_evidence: 'human',
    response_evidence_version: 1,
    author_user_id: null,
    accepted_by_user_id: null,
    occurred_at: new Date('2026-08-23T11:00:00.000Z'),
    ...overrides,
  }
}

describe('captureHighWatermark', () => {
  it('returns the epoch cursor for a scope with no facts at all', async () => {
    const { reader } = createReader([[]])
    await expect(reader.captureHighWatermark(SCOPE)).resolves.toEqual(CONNECT_SLA_EPOCH_CURSOR)
  })

  it('scopes every branch of the union to tenant and organization', async () => {
    const { reader, calls } = createReader([
      [{ occurred_at: new Date('2026-08-23T09:00:00.000Z'), id: OTHER_ID }],
    ])
    const cursor = await reader.captureHighWatermark(SCOPE)
    expect(cursor).toEqual({ occurredAt: '2026-08-23T09:00:00.000Z', id: OTHER_ID })
    // Three tables, two scope bindings each — a missing pair would mean one
    // table's watermark was read across the whole tenant.
    expect(calls[0]?.params).toEqual([TENANT, ORG, TENANT, ORG, TENANT, ORG])
  })
})

describe('keyset paging', () => {
  it('bounds a page by after and through and asks for one extra row', async () => {
    const { reader, calls } = createReader([[deliveryRow()]])
    const after = { occurredAt: '2026-08-23T08:00:00.000Z', id: OTHER_ID }
    const page = await reader.listConfirmedDeliveries(SCOPE, { after, through: THROUGH, limit: 10 })

    expect(calls[0]?.sql).toContain(`("occurred_at", "id") > (?, ?)`)
    expect(calls[0]?.sql).toContain(`("occurred_at", "id") <= (?, ?)`)
    expect(calls[0]?.sql).toContain(`order by "occurred_at" asc, "id" asc`)
    expect(calls[0]?.params[0]).toBe(TENANT)
    expect(calls[0]?.params[1]).toBe(ORG)
    expect(calls[0]?.params.at(-1)).toBe(11)
    expect(page.nextCursor).toBeNull()
    expect(page.highWatermark).toEqual(THROUGH)
  })

  it('reports a next cursor only when a row beyond the page exists', async () => {
    const { reader } = createReader([[deliveryRow(), deliveryRow({ id: OTHER_ID })]])
    const page = await reader.listConfirmedDeliveries(SCOPE, { through: THROUGH, limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toEqual({ occurredAt: '2026-08-23T11:00:00.000Z', id: OTHER_ID })
  })

  it.each([0, 101, 1.5])('rejects an out-of-range limit of %s', async (limit) => {
    const { reader } = createReader([[]])
    await expect(
      reader.listConfirmedDeliveries(SCOPE, { through: THROUGH, limit }),
    ).rejects.toThrow()
  })

  it('rejects a scope that is not fully qualified', async () => {
    const { reader } = createReader([[]])
    await expect(
      reader.listWaitIntervals({ tenantId: TENANT, organizationId: '' }, { through: THROUGH, limit: 10 }),
    ).rejects.toThrow()
  })
})

describe('malformed rows', () => {
  it('fails internally rather than coercing an unknown evidence value', async () => {
    // Coercing it to `unknown` would make a corrupted write indistinguishable
    // from an honestly unverifiable send.
    const { reader } = createReader([[deliveryRow({ response_evidence: 'definitely_human' })]])
    await expect(
      reader.listConfirmedDeliveries(SCOPE, { through: THROUGH, limit: 10 }),
    ).rejects.toThrow('[internal] connect_sla_reader_malformed_response_evidence')
  })

  it('fails internally on an unreadable timestamp', async () => {
    const { reader } = createReader([[deliveryRow({ confirmed_at: 'not-a-date' })]])
    await expect(
      reader.listConfirmedDeliveries(SCOPE, { through: THROUGH, limit: 10 }),
    ).rejects.toThrow('[internal] connect_sla_reader_malformed_confirmed_at')
  })
})

describe('canReadCase', () => {
  it('denies a Case that is not in the caller scope', async () => {
    const { reader } = createReader([])
    await expect(reader.canReadCase({ ...SCOPE, userId: OTHER_ID }, OTHER_ID)).resolves.toBe(false)
  })

  it('denies a malformed identifier without querying', async () => {
    const { reader } = createReader([])
    await expect(reader.canReadCase({ ...SCOPE, userId: OTHER_ID }, 'not-a-uuid')).resolves.toBe(false)
  })
})

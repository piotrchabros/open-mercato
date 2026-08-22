import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectOperationalFact } from '../../data/entities'
import { buildFactSourceKey, readEventScope, recordFact, utcDay } from '../metrics-facts'

/**
 * Publication is at-least-once, so the same event will arrive twice. These
 * tests pin the two things that keeps honest: the unique source key, and the
 * refusal to record a fact whose organization is unknown.
 */

const SCOPE = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  sourceEventId: 'connect.inbound.claimed:receipt-1',
}

function createEm(options: { conflict?: boolean; otherError?: boolean } = {}) {
  const created: Array<Record<string, unknown>> = []
  const em = {
    create: jest.fn((_entity: unknown, data: Record<string, unknown>) => {
      created.push(data)
      return { id: 'fact-1', ...data }
    }),
    persist: jest.fn(),
    flush: jest.fn(async () => {
      if (options.conflict) throw Object.assign(new Error('duplicate key'), { code: '23505' })
      if (options.otherError) throw Object.assign(new Error('connection lost'), { code: '08006' })
    }),
    fork: () => em,
  } as unknown as EntityManager & { fork: () => EntityManager }
  return { em, created }
}

describe('buildFactSourceKey', () => {
  it('separates two facts derived from the same event', () => {
    // One delivery-outcome event produces both a status fact and a duration
    // fact; a shared key would let the second reject the first as a duplicate.
    expect(buildFactSourceKey('e1', 'outbound_sent')).not.toBe(buildFactSourceKey('e1', 'first_response_seconds'))
  })

  it('is stable for the same event and fact type', () => {
    expect(buildFactSourceKey('e1', 'outbound_sent')).toBe(buildFactSourceKey('e1', 'outbound_sent'))
  })
})

describe('recordFact', () => {
  it('appends a fact keyed on the publishing event', async () => {
    const { em, created } = createEm()
    const recorded = await recordFact(em, {
      ...SCOPE,
      factType: 'inbound_claimed',
      cohortUtcDate: '2026-08-22',
      occurredAt: new Date('2026-08-22T10:00:00.000Z'),
      channelId: 'channel-1',
    })
    expect(recorded).toBe(true)
    expect(created[0]).toMatchObject({
      factType: 'inbound_claimed',
      sourceKey: 'connect.inbound.claimed:receipt-1:inbound_claimed',
      cohortUtcDate: '2026-08-22',
    })
  })

  it('reports a redelivery as a no-op rather than double-counting', async () => {
    const { em } = createEm({ conflict: true })
    await expect(
      recordFact(em, {
        ...SCOPE,
        factType: 'inbound_claimed',
        cohortUtcDate: '2026-08-22',
        occurredAt: new Date(),
      }),
    ).resolves.toBe(false)
  })

  it('rethrows a real failure so the subscriber retries', async () => {
    // Swallowing this would silently lose a day's arithmetic.
    const { em } = createEm({ otherError: true })
    await expect(
      recordFact(em, {
        ...SCOPE,
        factType: 'inbound_claimed',
        cohortUtcDate: '2026-08-22',
        occurredAt: new Date(),
      }),
    ).rejects.toThrow('connection lost')
  })

  it('never persists a raw handle or body field', async () => {
    const { em, created } = createEm()
    await recordFact(em, {
      ...SCOPE,
      factType: 'inbound_suppressed',
      cohortUtcDate: '2026-08-22',
      occurredAt: new Date(),
      senderHash: 'blind-index-only',
    })
    const keys = Object.keys(created[0]!)
    expect(keys).toContain('senderHash')
    expect(keys.some((key) => /handle|body|subject|email/i.test(key))).toBe(false)
    void ConnectOperationalFact
  })
})

describe('readEventScope', () => {
  it('requires tenant, organization and the stable source id', () => {
    expect(readEventScope({ ...SCOPE })).toEqual(SCOPE)
  })

  it('drops an event with no organization rather than charging it to the tenant', () => {
    // A fact with a null organization could never be shown without crossing the
    // boundary reporting is authorized by.
    expect(readEventScope({ tenantId: SCOPE.tenantId, sourceEventId: 'e1' })).toBeNull()
  })

  it('drops an event with no stable source id, since it could not be deduplicated', () => {
    expect(readEventScope({ tenantId: SCOPE.tenantId, organizationId: SCOPE.organizationId })).toBeNull()
  })
})

describe('utcDay', () => {
  it('is the UTC calendar date, so history is never reinterpreted by a timezone change', () => {
    expect(utcDay(new Date('2026-08-22T23:59:59.000Z'))).toBe('2026-08-22')
    expect(utcDay(new Date('2026-08-23T00:00:01.000Z'))).toBe('2026-08-23')
  })
})

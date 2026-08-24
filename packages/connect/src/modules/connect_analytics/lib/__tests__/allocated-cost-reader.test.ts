import type { EntityManager } from '@mikro-orm/postgresql'
import { AllocatedCostReaderError } from '../allocated-cost-contract'
import { createConnectAllocatedCostReader } from '../allocated-cost-reader'

const REQUEST = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  periodStart: new Date('2026-03-10T00:00:00.000Z'),
  periodEnd: new Date('2026-03-20T00:00:00.000Z'),
  currencyCode: 'EUR',
}

function entityManagerReturning(rows: unknown[]): { em: EntityManager; execute: jest.Mock } {
  const execute = jest.fn().mockResolvedValue(rows)
  const em = {
    getConnection: () => ({ execute }),
  } as unknown as EntityManager
  return { em, execute }
}

describe('connectAllocatedCostReader', () => {
  it('allocates full and partial overlaps exactly and sorts nonzero totals by type', async () => {
    const { em, execute } = entityManagerReturning([
      {
        period_start: '2026-03-10T00:00:00.000Z',
        period_end: '2026-03-20T00:00:00.000Z',
        cost_type: 'ai',
        amount_minor: '100',
      },
      {
        period_start: '2026-03-05T00:00:00.000Z',
        period_end: '2026-03-15T00:00:00.000Z',
        cost_type: 'agent',
        amount_minor: '99',
      },
      {
        period_start: '2026-03-15T00:00:00.000Z',
        period_end: '2026-03-25T00:00:00.000Z',
        cost_type: 'agent',
        amount_minor: '99',
      },
    ])

    const result = await createConnectAllocatedCostReader(em).summarizeAllocated(REQUEST)

    expect(result).toMatchObject({
      contractVersion: 'connect_analytics.allocated_cost.v1',
      currencyCode: 'EUR',
      matchedInputCount: 3,
      byType: [
        { type: 'agent', allocatedMinor: { numerator: '99', denominator: '1' } },
        { type: 'ai', allocatedMinor: { numerator: '100', denominator: '1' } },
      ],
    })
    expect(Date.parse(result.generatedAt)).not.toBeNaN()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toContain('select period_start, period_end, cost_type, amount_minor')
    expect(execute.mock.calls[0]?.[0]).not.toMatch(/description|provider_|user_id|channel_id|created_by|\bid\b/)
    expect(execute.mock.calls[0]?.[1]).toEqual([
      REQUEST.tenantId,
      REQUEST.organizationId,
      REQUEST.currencyCode,
      REQUEST.periodEnd,
      REQUEST.periodStart,
    ])
  })

  it('keeps millisecond allocation and large amounts exact', async () => {
    const { em } = entityManagerReturning([{
      period_start: '2026-03-10T00:00:00.000Z',
      period_end: '2026-03-10T00:00:00.003Z',
      cost_type: 'channel',
      amount_minor: '9223372036854775807',
    }])

    const result = await createConnectAllocatedCostReader(em).summarizeAllocated({
      ...REQUEST,
      periodStart: new Date('2026-03-10T00:00:00.001Z'),
      periodEnd: new Date('2026-03-10T00:00:00.003Z'),
    })

    expect(result.byType).toEqual([{
      type: 'channel',
      allocatedMinor: { numerator: '18446744073709551614', denominator: '3' },
    }])
  })

  it('returns a strict empty summary when no inputs match', async () => {
    const { em } = entityManagerReturning([])
    await expect(createConnectAllocatedCostReader(em).summarizeAllocated(REQUEST)).resolves.toMatchObject({
      matchedInputCount: 0,
      byType: [],
    })
  })

  it.each([
    ['invalid_scope', { tenantId: '' }],
    ['invalid_scope', { organizationId: '' }],
    ['invalid_currency', { currencyCode: 'eur' }],
    ['invalid_range', { periodEnd: REQUEST.periodStart }],
    ['range_too_large', { periodEnd: new Date('2027-03-12T00:00:00.001Z') }],
  ] as const)('rejects %s inputs with a typed error', async (code, override) => {
    const { em } = entityManagerReturning([])
    const promise = createConnectAllocatedCostReader(em).summarizeAllocated({ ...REQUEST, ...override })
    await expect(promise).rejects.toMatchObject<Partial<AllocatedCostReaderError>>({ code })
  })
})

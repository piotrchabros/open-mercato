import type { EntityManager } from '@mikro-orm/postgresql'
import {
  COST_INPUT_READER_MAX_ROWS,
  CostInputResultTooLargeError,
  createConnectCostInputReader,
} from '../cost-input-reader'
import { CostInput } from '../../data/entities'

const TENANT_ID = '11111111-1111-4111-8111-111111111111'
const ORGANIZATION_ID = '22222222-2222-4222-8222-222222222222'

const REQUEST = {
  tenantId: TENANT_ID,
  organizationId: ORGANIZATION_ID,
  periodStart: new Date('2026-03-01T00:00:00.000Z'),
  periodEnd: new Date('2026-04-01T00:00:00.000Z'),
  currencyCode: 'EUR',
}

function row(overrides: Partial<CostInput> = {}) {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    periodStart: new Date('2026-03-01T00:00:00.000Z'),
    periodEnd: new Date('2026-04-01T00:00:00.000Z'),
    costType: 'channel',
    amountMinor: '125000',
    currencyCode: 'EUR',
    description: 'never leaves the module',
    userId: '44444444-4444-4444-8444-444444444444',
    channelId: null,
    providerInvoiceRef: 'inv-1',
    providerLineRef: 'line-1',
    createdByUserId: '55555555-5555-4555-8555-555555555555',
    ...overrides,
  } as unknown as CostInput
}

function emReturning(rows: CostInput[]): { em: EntityManager; find: jest.Mock } {
  const find = jest.fn().mockResolvedValue(rows)
  return { em: { find } as unknown as EntityManager, find }
}

describe('connectCostInputReader', () => {
  it('filters on both scopes, exact currency, live rows and half-open overlap', async () => {
    const { em, find } = emReturning([])
    await createConnectCostInputReader(em).listOverlapping(REQUEST)

    const [entity, where, options] = find.mock.calls[0]
    expect(entity).toBe(CostInput)
    expect(where).toEqual({
      tenantId: TENANT_ID,
      organizationId: ORGANIZATION_ID,
      currencyCode: 'EUR',
      deletedAt: null,
      periodStart: { $lt: REQUEST.periodEnd },
      periodEnd: { $gt: REQUEST.periodStart },
    })
    expect(options.orderBy).toEqual([{ periodStart: 'asc' }, { id: 'asc' }])
  })

  it('never selects the encrypted description or any identity column', async () => {
    const { em, find } = emReturning([])
    await createConnectCostInputReader(em).listOverlapping(REQUEST)

    const fields: string[] = find.mock.calls[0][2].fields
    expect(fields).toEqual(['id', 'periodStart', 'periodEnd', 'costType', 'amountMinor', 'currencyCode'])
    for (const forbidden of ['description', 'userId', 'channelId', 'providerInvoiceRef', 'createdByUserId']) {
      expect(fields).not.toContain(forbidden)
    }
  })

  it('returns only the five sanctioned fields even if the row carries more', async () => {
    const { em } = emReturning([row()])
    const [result] = await createConnectCostInputReader(em).listOverlapping(REQUEST)

    expect(Object.keys(result).sort()).toEqual(
      ['amountMinor', 'costType', 'currencyCode', 'periodEnd', 'periodStart'],
    )
  })

  it('returns amountMinor as a canonical string', async () => {
    const { em } = emReturning([row({ amountMinor: '9223372036854775807' } as Partial<CostInput>)])
    const [result] = await createConnectCostInputReader(em).listOverlapping(REQUEST)

    expect(result.amountMinor).toBe('9223372036854775807')
    expect(typeof result.amountMinor).toBe('string')
  })

  it('rejects rather than truncating past the published row bound', async () => {
    const rows = Array.from({ length: COST_INPUT_READER_MAX_ROWS + 1 }, () => row())
    const { em } = emReturning(rows)

    await expect(createConnectCostInputReader(em).listOverlapping(REQUEST))
      .rejects.toBeInstanceOf(CostInputResultTooLargeError)
  })

  it('asks for one row more than the bound so the overflow is detectable', async () => {
    const { em, find } = emReturning([])
    await createConnectCostInputReader(em).listOverlapping(REQUEST)

    expect(find.mock.calls[0][2].limit).toBe(COST_INPUT_READER_MAX_ROWS + 1)
  })

  it.each([
    ['an empty range', { periodEnd: new Date('2026-03-01T00:00:00.000Z') }],
    ['an inverted range', { periodStart: new Date('2026-04-01T00:00:00.000Z'), periodEnd: new Date('2026-03-01T00:00:00.000Z') }],
    ['a range beyond 366 days', { periodStart: new Date('2026-01-01T00:00:00.000Z'), periodEnd: new Date('2027-01-03T00:00:00.000Z') }],
    ['a lowercase currency', { currencyCode: 'eur' }],
    ['a non-uuid tenant', { tenantId: 'not-a-uuid' }],
  ])('rejects %s before querying', async (_label, overrides) => {
    const { em, find } = emReturning([])

    await expect(createConnectCostInputReader(em).listOverlapping({ ...REQUEST, ...overrides })).rejects.toThrow()
    expect(find).not.toHaveBeenCalled()
  })
})

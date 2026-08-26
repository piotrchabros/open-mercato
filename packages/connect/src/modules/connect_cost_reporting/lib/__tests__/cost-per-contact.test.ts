import { composeCostPerContactReport, roundRational } from '../cost-per-contact'

const generatedAt = '2026-08-24T00:00:00.000Z'

describe('cost per contact composer', () => {
  it.each([
    [{ numerator: 1n, denominator: 2n }, 1n],
    [{ numerator: 1n, denominator: 3n }, 0n],
    [{ numerator: 5n, denominator: 2n }, 3n],
    [{ numerator: 10n, denominator: 4n }, 3n],
  ] as const)('rounds exact rationals half-up', (value, expected) => {
    expect(roundRational(value)).toBe(expected)
  })

  it('rounds buckets and authoritative grand total independently', () => {
    const report = composeCostPerContactReport({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-09-01T00:00:00.000Z',
      cost: {
        contractVersion: 'connect_analytics.allocated_cost.v1',
        generatedAt,
        currencyCode: 'PLN',
        matchedInputCount: 3,
        byType: [
          { type: 'agent', allocatedMinor: { numerator: '1', denominator: '2' } },
          { type: 'channel', allocatedMinor: { numerator: '1', denominator: '2' } },
          { type: 'ai', allocatedMinor: { numerator: '1', denominator: '2' } },
        ],
      },
      denominator: {
        contractVersion: 'connect.contact_root_created.v1',
        generatedAt,
        count: 2,
      },
    })

    expect(report.totals).toEqual({ agentMinor: '1', channelMinor: '1', aiMinor: '1', totalMinor: '2' })
    expect(report.costPerContactMinor).toBe('1')
  })

  it('returns null rather than zero when the denominator is zero', () => {
    const report = composeCostPerContactReport({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-09-01T00:00:00.000Z',
      cost: {
        contractVersion: 'connect_analytics.allocated_cost.v1',
        generatedAt,
        currencyCode: 'EUR',
        matchedInputCount: 0,
        byType: [],
      },
      denominator: { contractVersion: 'connect.contact_root_created.v1', generatedAt, count: 0 },
    })

    expect(report.costPerContactMinor).toBeNull()
    expect(report.totals.totalMinor).toBe('0')
  })

  it('rejects duplicate source buckets', () => {
    expect(() => composeCostPerContactReport({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-09-01T00:00:00.000Z',
      cost: {
        contractVersion: 'connect_analytics.allocated_cost.v1', generatedAt, currencyCode: 'USD', matchedInputCount: 2,
        byType: [
          { type: 'agent', allocatedMinor: { numerator: '1', denominator: '1' } },
          { type: 'agent', allocatedMinor: { numerator: '2', denominator: '1' } },
        ],
      },
      denominator: { contractVersion: 'connect.contact_root_created.v1', generatedAt, count: 1 },
    })).toThrow()
  })
})

import {
  computeTotals,
  enumerateDays,
  percentile,
  summarize,
  unreconciledCount,
} from '../metrics-aggregate'
import type { ConnectFactType } from '../../data/entities'

/**
 * The arithmetic is the product here. Earlier designs shipped counters whose
 * numerators and denominators did not describe the same population, so these
 * tests pin the reconciliation equation, the enqueue-cohort outcome rule, and
 * the refusal to report an empty percentile as zero.
 */

const NOW = new Date('2026-08-23T12:00:00.000Z')

type Fact = {
  factType: ConnectFactType
  channelId?: string | null
  senderHash?: string | null
  attemptId?: string | null
  value?: number | null
  occurredAt: Date
  appliedCountLimit?: number | null
}

function fact(factType: ConnectFactType, overrides: Partial<Fact> = {}): Fact {
  return { factType, occurredAt: NOW, ...overrides }
}

describe('percentile', () => {
  it('uses nearest rank, so every reported value is one a real case took', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(sorted, 0.5)).toBe(5)
    expect(percentile(sorted, 0.9)).toBe(9)
  })

  it('is null on an empty population rather than zero', () => {
    expect(percentile([], 0.5)).toBeNull()
  })

  it('handles a single sample', () => {
    expect(percentile([42], 0.9)).toBe(42)
  })
})

describe('summarize', () => {
  it('reports the sample count so a p90 over three points is visible as such', () => {
    expect(summarize([5, 1, 3])).toEqual({ p50: 3, p90: 5, max: 5, count: 3 })
  })

  it('is entirely null for an empty population', () => {
    expect(summarize([])).toEqual({ p50: null, p90: null, max: null, count: 0 })
  })
})

describe('reconciliation', () => {
  it('balances when every claim reached a terminal disposition', () => {
    const totals = computeTotals(
      [
        fact('inbound_claimed'),
        fact('inbound_claimed'),
        fact('inbound_claimed'),
        fact('inbound_opened'),
        fact('inbound_attached'),
        fact('inbound_suppressed'),
      ],
      NOW,
    )
    expect(unreconciledCount(totals)).toBe(0)
  })

  it('counts a claim with no disposition as unreconciled', () => {
    const totals = computeTotals([fact('inbound_claimed'), fact('inbound_claimed'), fact('inbound_opened')], NOW)
    expect(unreconciledCount(totals)).toBe(1)
  })

  it('treats a dead letter as reconciled, not as a gap', () => {
    const totals = computeTotals([fact('inbound_claimed'), fact('inbound_dead_lettered')], NOW)
    expect(unreconciledCount(totals)).toBe(0)
    expect(totals.inboundDeadLettered).toBe(1)
  })
})

describe('outbound outcome buckets', () => {
  it('gives each attempt exactly one bucket, resolved to its latest revision', () => {
    // queued → unknown → sent for ONE attempt must not appear as three outcomes,
    // or the split would exceed the attempted denominator.
    const totals = computeTotals(
      [
        fact('outbound_attempted', { attemptId: 'a1' }),
        fact('outbound_unknown', { attemptId: 'a1', occurredAt: new Date('2026-08-23T10:00:00.000Z') }),
        fact('outbound_sent', { attemptId: 'a1', occurredAt: new Date('2026-08-23T11:00:00.000Z') }),
      ],
      NOW,
    )
    expect(totals.outboundAttempted).toBe(1)
    expect(totals.outboundSent).toBe(1)
    expect(totals.outboundUnknown).toBe(0)
  })

  it('never folds an unknown outcome into sent or failed', () => {
    const totals = computeTotals(
      [
        fact('outbound_attempted', { attemptId: 'a1' }),
        fact('outbound_unknown', { attemptId: 'a1' }),
      ],
      NOW,
    )
    expect(totals.outboundUnknown).toBe(1)
    expect(totals.outboundSent).toBe(0)
    expect(totals.outboundFailed).toBe(0)
  })

  it('reports the age of the oldest still-unknown attempt', () => {
    // Age is what turns "some sends are unknown" into an actionable alert.
    const totals = computeTotals(
      [fact('outbound_unknown', { attemptId: 'a1', occurredAt: new Date('2026-08-23T11:00:00.000Z') })],
      NOW,
    )
    expect(totals.unknownMaxAgeSeconds).toBe(3600)
  })

  it('leaves the unknown age null when nothing is unknown', () => {
    const totals = computeTotals([fact('outbound_sent', { attemptId: 'a1' })], NOW)
    expect(totals.unknownMaxAgeSeconds).toBeNull()
  })
})

describe('per-sender suppression criterion', () => {
  it('counts only PERMITTED receipts per (channel, sender) pair', () => {
    const totals = computeTotals(
      [
        fact('inbound_opened', { channelId: 'c1', senderHash: 'h1', appliedCountLimit: 3 }),
        fact('inbound_attached', { channelId: 'c1', senderHash: 'h1', appliedCountLimit: 3 }),
        // Suppressed volume never makes the criterion fail: a noisy sender that
        // was correctly throttled is the system working.
        fact('inbound_suppressed', { channelId: 'c1', senderHash: 'h1', appliedCountLimit: 3 }),
        fact('inbound_suppressed', { channelId: 'c1', senderHash: 'h1', appliedCountLimit: 3 }),
      ],
      NOW,
    )
    expect(totals.observedMaxPermittedPerSender).toBe(2)
    expect(totals.appliedCountLimit).toBe(3)
    expect(totals.observedMaxPermittedPerSender <= (totals.appliedCountLimit ?? 0)).toBe(true)
  })

  it('separates senders and channels rather than summing them', () => {
    const totals = computeTotals(
      [
        fact('inbound_opened', { channelId: 'c1', senderHash: 'h1' }),
        fact('inbound_opened', { channelId: 'c1', senderHash: 'h2' }),
        fact('inbound_opened', { channelId: 'c2', senderHash: 'h1' }),
      ],
      NOW,
    )
    expect(totals.observedMaxPermittedPerSender).toBe(1)
  })

  it('holds the criterion against the STRICTEST limit in force that day', () => {
    // A mid-day loosening must not retroactively excuse a breach of the tighter
    // setting that was actually applied earlier.
    const totals = computeTotals(
      [
        fact('inbound_opened', { channelId: 'c1', senderHash: 'h1', appliedCountLimit: 5 }),
        fact('inbound_opened', { channelId: 'c1', senderHash: 'h1', appliedCountLimit: 2 }),
      ],
      NOW,
    )
    expect(totals.appliedCountLimit).toBe(2)
  })

  it('is zero when no permitted receipt carried a sender hash', () => {
    const totals = computeTotals([fact('inbound_claimed')], NOW)
    expect(totals.observedMaxPermittedPerSender).toBe(0)
    expect(totals.appliedCountLimit).toBeNull()
  })
})

describe('duration populations', () => {
  it('summarizes first response and elapsed resolution independently', () => {
    const totals = computeTotals(
      [
        fact('first_response_seconds', { value: 120 }),
        fact('first_response_seconds', { value: 600 }),
        fact('elapsed_assigned_to_resolution_seconds', { value: 7200 }),
      ],
      NOW,
    )
    expect(totals.firstResponse.count).toBe(2)
    expect(totals.elapsedResolution.count).toBe(1)
    expect(totals.firstResponse.p50).toBe(120)
  })

  it('reports an absent projection family as an empty population, not zero lag', () => {
    const totals = computeTotals([fact('inbound_claimed')], NOW)
    expect(totals.projectionLag).toEqual({ p50: null, p90: null, max: null, count: 0 })
  })

  it('counts projection failures separately from lag samples', () => {
    const totals = computeTotals(
      [fact('projection_lag_ms', { value: 900 }), fact('projection_failed')],
      NOW,
    )
    expect(totals.projectionLag.count).toBe(1)
    expect(totals.projectionFailed).toBe(1)
  })
})

describe('enumerateDays', () => {
  it('is inclusive at both ends', () => {
    expect(enumerateDays('2026-08-21', '2026-08-23')).toEqual(['2026-08-21', '2026-08-22', '2026-08-23'])
  })

  it('returns a single day for an equal range', () => {
    expect(enumerateDays('2026-08-21', '2026-08-21')).toEqual(['2026-08-21'])
  })

  it('is empty for an inverted or malformed range', () => {
    expect(enumerateDays('2026-08-23', '2026-08-21')).toEqual([])
    expect(enumerateDays('nonsense', '2026-08-21')).toEqual([])
  })
})

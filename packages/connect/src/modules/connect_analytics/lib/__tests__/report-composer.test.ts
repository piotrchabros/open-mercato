import type { ConnectOperationalMetricDay } from '@open-mercato/connect/modules/connect/lib/operational-metrics-reader'
import {
  CONNECT_ANALYTICS_OPERATIONAL_FORMULA_VERSION,
  composeOperationalReport,
  countUtcDays,
  emptyOperationalReport,
  operationalReportSchema,
  resolveOperationalRange,
  sumOperationalTotals,
} from '../report-composer'

function day(overrides: Partial<ConnectOperationalMetricDay> = {}): ConnectOperationalMetricDay {
  return {
    utcDate: '2026-08-01',
    inboundClaimed: 10,
    casesOpened: 4,
    casesAttached: 3,
    inboundSuppressed: 2,
    inboundDeadLettered: 1,
    unreconciled: 0,
    outboundAttempted: 6,
    outboundSent: 5,
    outboundFailed: 1,
    outboundUnknown: 0,
    unknownMaxAgeSeconds: null,
    casesAssigned: 4,
    casesResolved: 3,
    casesReopened: 1,
    firstResponse: { p50: 45, p90: 300, sampleCount: 12 },
    elapsedAssignedToResolution: null,
    projectionLag: null,
    suppression: { observedMaxPermittedPerSender: 3, appliedCountLimit: 5, withinLimit: true },
    generatedAt: '2026-08-02T03:00:00.000Z',
    stale: false,
    ...overrides,
  }
}

describe('resolveOperationalRange', () => {
  it('rejects an inverted range', () => {
    expect(resolveOperationalRange({ from: '2026-08-10', to: '2026-08-01', todayUtc: '2026-08-23' }))
      .toEqual({ kind: 'invalid_range' })
  })

  it('rejects a range longer than 92 days', () => {
    expect(resolveOperationalRange({ from: '2026-01-01', to: '2026-04-03', todayUtc: '2026-08-23' }))
      .toEqual({ kind: 'range_too_large' })
    expect(resolveOperationalRange({ from: '2026-01-01', to: '2026-04-02', todayUtc: '2026-08-23' }).kind)
      .toBe('ok')
  })

  it('clamps to yesterday so a partial UTC day is never reported', () => {
    expect(resolveOperationalRange({ from: '2026-08-01', to: '2026-08-30', todayUtc: '2026-08-23' }))
      .toEqual({ kind: 'ok', to: '2026-08-22', requestedDays: 22 })
  })

  it('returns no complete days when the clamp leaves nothing behind', () => {
    expect(resolveOperationalRange({ from: '2026-08-23', to: '2026-08-23', todayUtc: '2026-08-23' }))
      .toEqual({ kind: 'no_complete_days', to: '2026-08-22' })
  })

  it('counts days inclusively', () => {
    expect(countUtcDays('2026-08-01', '2026-08-01')).toBe(1)
    expect(countUtcDays('2026-08-01', '2026-08-03')).toBe(3)
  })
})

describe('composeOperationalReport', () => {
  it('stamps the formula version and the available capability', () => {
    const report = composeOperationalReport({
      from: '2026-08-01',
      to: '2026-08-01',
      requestedDays: 1,
      days: [day()],
    })
    expect(report.formulaVersion).toBe(CONNECT_ANALYTICS_OPERATIONAL_FORMULA_VERSION)
    expect(report.operationalMetrics).toEqual({ capability: 'available' })
    expect(operationalReportSchema.parse(report)).toEqual(report)
  })

  it('counts aggregated days, not calendar days, so a gap stays visible', () => {
    const report = composeOperationalReport({
      from: '2026-08-01',
      to: '2026-08-03',
      requestedDays: 3,
      days: [day({ utcDate: '2026-08-01' }), day({ utcDate: '2026-08-03' })],
    })
    expect(report.requestedDays).toBe(3)
    expect(report.completeDays).toBe(2)
    expect(report.days.map((entry) => entry.utcDate)).toEqual(['2026-08-01', '2026-08-03'])
  })

  it('orders days ascending regardless of source order', () => {
    const report = composeOperationalReport({
      from: '2026-08-01',
      to: '2026-08-03',
      requestedDays: 3,
      days: [day({ utcDate: '2026-08-03' }), day({ utcDate: '2026-08-01' })],
    })
    expect(report.days.map((entry) => entry.utcDate)).toEqual(['2026-08-01', '2026-08-03'])
  })

  it('never averages daily percentiles into a range percentile', () => {
    const report = composeOperationalReport({
      from: '2026-08-01',
      to: '2026-08-02',
      requestedDays: 2,
      days: [
        day({ utcDate: '2026-08-01', firstResponse: { p50: 10, p90: 20, sampleCount: 1 } }),
        day({ utcDate: '2026-08-02', firstResponse: { p50: 1000, p90: 2000, sampleCount: 99 } }),
      ],
    })
    expect(Object.keys(report.totals ?? {})).not.toContain('firstResponse')
    expect(JSON.stringify(report.totals)).not.toContain('p50')
    expect(JSON.stringify(report.totals)).not.toContain('p90')
  })

  it('sums counters across the range', () => {
    const totals = sumOperationalTotals([
      day({ utcDate: '2026-08-01' }),
      day({ utcDate: '2026-08-02', inboundClaimed: 5, casesOpened: 5, unreconciled: -5 }),
    ])
    expect(totals?.inboundClaimed).toBe(15)
    expect(totals?.casesOpened).toBe(9)
    expect(totals?.unreconciled).toBe(-5)
  })

  it('leaves totals null when nothing was aggregated', () => {
    const report = emptyOperationalReport({ from: '2026-08-23', to: '2026-08-22' })
    expect(report.totals).toBeNull()
    expect(report.days).toEqual([])
    expect(report.completeDays).toBe(0)
    expect(report.requestedDays).toBe(0)
    expect(operationalReportSchema.parse(report)).toEqual(report)
  })

  it('rejects an envelope carrying an unexpected field', () => {
    const report = composeOperationalReport({
      from: '2026-08-01',
      to: '2026-08-01',
      requestedDays: 1,
      days: [day()],
    })
    expect(() => operationalReportSchema.parse({ ...report, customerId: 'cus_1' })).toThrow()
  })
})

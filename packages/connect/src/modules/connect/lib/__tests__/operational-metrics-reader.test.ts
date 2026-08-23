import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectMetricDaily } from '../../data/entities'
import {
  connectOperationalMetricDaySchema,
  createConnectOperationalMetricsReader,
  toConnectOperationalMetricDay,
} from '../operational-metrics-reader'

function metricRow(overrides: Partial<ConnectMetricDaily> = {}): ConnectMetricDaily {
  const row = new ConnectMetricDaily()
  row.id = 'row-id'
  row.tenantId = 'tenant-1'
  row.organizationId = 'org-1'
  row.utcDate = '2026-08-01'
  row.inboundClaimed = 10
  row.casesOpened = 4
  row.casesAttached = 3
  row.inboundSuppressed = 2
  row.inboundDeadLettered = 1
  row.outboundAttempted = 6
  row.outboundSent = 5
  row.outboundFailed = 1
  row.outboundUnknown = 0
  row.casesAssigned = 4
  row.casesResolved = 3
  row.casesReopened = 1
  row.observedMaxPermittedPerSender = 3
  row.generatedAt = new Date('2026-08-02T03:00:00.000Z')
  row.stale = false
  return Object.assign(row, overrides)
}

describe('toConnectOperationalMetricDay', () => {
  it('publishes the reconciliation equation as a signed difference', () => {
    const day = toConnectOperationalMetricDay(metricRow())
    expect(day.unreconciled).toBe(0)

    const stuck = toConnectOperationalMetricDay(metricRow({ casesOpened: 1 }))
    expect(stuck.unreconciled).toBe(3)
  })

  it('reports an empty percentile population as unavailable, never as zero', () => {
    const day = toConnectOperationalMetricDay(metricRow())
    expect(day.firstResponse).toBeNull()
    expect(day.elapsedAssignedToResolution).toBeNull()
    expect(day.projectionLag).toBeNull()
  })

  it('carries percentiles with the population that produced them', () => {
    const day = toConnectOperationalMetricDay(
      metricRow({
        firstResponseP50Seconds: 45,
        firstResponseP90Seconds: 300,
        firstResponseSampleCount: 12,
        elapsedResolutionP50Seconds: 3600,
        elapsedResolutionP90Seconds: 7200,
        elapsedResolutionSampleCount: 5,
        projectionLagP50Ms: 120,
        projectionLagP90Ms: 480,
        projectionLagMaxMs: 900,
        projectionSampleCount: 7,
        projectionFailed: 1,
      }),
    )
    expect(day.firstResponse).toEqual({ p50: 45, p90: 300, sampleCount: 12 })
    expect(day.elapsedAssignedToResolution).toEqual({ p50: 3600, p90: 7200, sampleCount: 5 })
    expect(day.projectionLag).toEqual({ p50Ms: 120, p90Ms: 480, maxMs: 900, sampleCount: 7, failed: 1 })
  })

  it('evaluates the suppression criterion and leaves it null without an applied limit', () => {
    expect(toConnectOperationalMetricDay(metricRow()).suppression).toEqual({
      observedMaxPermittedPerSender: 3,
      appliedCountLimit: null,
      withinLimit: null,
    })
    expect(
      toConnectOperationalMetricDay(metricRow({ appliedCountLimit: 5 })).suppression.withinLimit,
    ).toBe(true)
    expect(
      toConnectOperationalMetricDay(metricRow({ appliedCountLimit: 2 })).suppression.withinLimit,
    ).toBe(false)
  })

  it('emits only aggregate fields — no identifier, sender or scope leaks into the DTO', () => {
    const day = toConnectOperationalMetricDay(metricRow())
    expect(connectOperationalMetricDaySchema.parse(day)).toEqual(day)
    for (const forbidden of ['id', 'tenantId', 'organizationId', 'senderHash', 'handle', 'customerId', 'caseId']) {
      expect(Object.prototype.hasOwnProperty.call(day, forbidden)).toBe(false)
    }
  })
})

describe('createConnectOperationalMetricsReader', () => {
  it('scopes by tenant and organization and applies the range verbatim', async () => {
    const find = jest.fn().mockResolvedValue([metricRow({ utcDate: '2026-08-02' }), metricRow()])
    const em = { fork: () => ({ find }) } as unknown as EntityManager

    const days = await createConnectOperationalMetricsReader(em).listDaily({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      fromUtcDate: '2026-08-01',
      toUtcDate: '2026-08-02',
    })

    expect(find).toHaveBeenCalledWith(
      ConnectMetricDaily,
      {
        tenantId: 'tenant-1',
        organizationId: 'org-1',
        utcDate: { $gte: '2026-08-01', $lte: '2026-08-02' },
      },
      { orderBy: { utcDate: 'asc' } },
    )
    expect(days).toHaveLength(2)
    days.forEach((day) => expect(connectOperationalMetricDaySchema.parse(day)).toEqual(day))
  })
})

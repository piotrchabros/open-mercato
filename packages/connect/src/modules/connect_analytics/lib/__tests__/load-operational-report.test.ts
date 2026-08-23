import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { ConnectOperationalMetricDay } from '@open-mercato/connect/modules/connect/lib/operational-metrics-reader'
import { loadOperationalReport } from '../load-operational-report'

function day(utcDate: string): ConnectOperationalMetricDay {
  return {
    utcDate,
    inboundClaimed: 1,
    casesOpened: 1,
    casesAttached: 0,
    inboundSuppressed: 0,
    inboundDeadLettered: 0,
    unreconciled: 0,
    outboundAttempted: 0,
    outboundSent: 0,
    outboundFailed: 0,
    outboundUnknown: 0,
    unknownMaxAgeSeconds: null,
    casesAssigned: 0,
    casesResolved: 0,
    casesReopened: 0,
    firstResponse: null,
    elapsedAssignedToResolution: null,
    projectionLag: null,
    suppression: { observedMaxPermittedPerSender: 0, appliedCountLimit: null, withinLimit: null },
    generatedAt: '2026-08-02T03:00:00.000Z',
    stale: false,
  }
}

function containerWith(source: unknown): AppContainer {
  return { resolve: () => source } as unknown as AppContainer
}

const scope = { tenantId: 'tenant-1', organizationId: 'org-1', todayUtc: '2026-08-23' }

describe('loadOperationalReport', () => {
  it('reports an absent Connect reader as unavailable rather than as an empty dataset', async () => {
    const result = await loadOperationalReport({
      container: containerWith(null),
      ...scope,
      from: '2026-08-01',
      to: '2026-08-10',
    })
    expect(result).toEqual({ status: 'unavailable' })
  })

  it('passes the clamped range and the server-derived scope to the reader', async () => {
    const listDaily = jest.fn().mockResolvedValue([day('2026-08-21'), day('2026-08-22')])
    const result = await loadOperationalReport({
      container: containerWith({ listDaily }),
      ...scope,
      from: '2026-08-21',
      to: '2026-08-30',
    })

    expect(listDaily).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      organizationId: 'org-1',
      fromUtcDate: '2026-08-21',
      toUtcDate: '2026-08-22',
    })
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('[internal] expected an ok result')
    expect(result.report.to).toBe('2026-08-22')
    expect(result.report.completeDays).toBe(2)
  })

  it('does not query the source when the clamp leaves no complete day', async () => {
    const listDaily = jest.fn()
    const result = await loadOperationalReport({
      container: containerWith({ listDaily }),
      ...scope,
      from: '2026-08-23',
      to: '2026-08-23',
    })
    expect(listDaily).not.toHaveBeenCalled()
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('[internal] expected an ok result')
    expect(result.report).toMatchObject({ from: '2026-08-23', to: '2026-08-22', completeDays: 0, totals: null })
  })

  it('refuses an invalid or oversized range before touching the source', async () => {
    const listDaily = jest.fn()
    const container = containerWith({ listDaily })
    await expect(loadOperationalReport({ container, ...scope, from: '2026-08-10', to: '2026-08-01' }))
      .resolves.toEqual({ status: 'invalid_range' })
    await expect(loadOperationalReport({ container, ...scope, from: '2026-01-01', to: '2026-04-03' }))
      .resolves.toEqual({ status: 'range_too_large' })
    expect(listDaily).not.toHaveBeenCalled()
  })
})

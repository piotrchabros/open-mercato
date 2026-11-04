import { createMetaLeadAdsHealthCheck } from '../lib/health'
import { MetaConnection, MetaLeadEvent, MetaPage } from '../data/entities'

type Counts = { connections: number; broken: number; pagesTotal: number; pagesActive: number; deadLettered: number }

const scope = { tenantId: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222' }

function createStubEm(counts: Counts) {
  const calls: { entity: unknown; where: Record<string, unknown> }[] = []
  const em = {
    async count(entity: unknown, where: Record<string, unknown>) {
      calls.push({ entity, where })
      if (entity === MetaConnection) return where.status ? counts.broken : counts.connections
      if (entity === MetaPage) return where.subscriptionStatus ? counts.pagesActive : counts.pagesTotal
      if (entity === MetaLeadEvent) return counts.deadLettered
      return 0
    },
  }
  return { em, calls }
}

const healthyCounts: Counts = { connections: 1, broken: 0, pagesTotal: 2, pagesActive: 2, deadLettered: 0 }

describe('meta lead ads health check', () => {
  it('reports healthy when everything is active', async () => {
    const { em, calls } = createStubEm(healthyCounts)
    const result = await createMetaLeadAdsHealthCheck({ em: em as never }).check({}, scope)
    expect(result.status).toBe('healthy')
    expect(result.details).toEqual({ connections: 1, pagesActive: 2, pagesTotal: 2, deadLettered24h: 0 })
    calls.forEach((call) => {
      expect(call.where.tenantId).toBe(scope.tenantId)
      expect(call.where.organizationId).toBe(scope.organizationId)
    })
  })

  it('reports unhealthy when a connection is expired or invalid', async () => {
    const { em } = createStubEm({ ...healthyCounts, broken: 1, pagesActive: 1 })
    const result = await createMetaLeadAdsHealthCheck({ em: em as never }).check({}, scope)
    expect(result.status).toBe('unhealthy')
  })

  it('reports degraded when a page is not active', async () => {
    const { em } = createStubEm({ ...healthyCounts, pagesActive: 1 })
    const result = await createMetaLeadAdsHealthCheck({ em: em as never }).check({}, scope)
    expect(result.status).toBe('degraded')
  })

  it('reports degraded when events were dead-lettered in the last 24 hours', async () => {
    const { em, calls } = createStubEm({ ...healthyCounts, deadLettered: 3 })
    const result = await createMetaLeadAdsHealthCheck({ em: em as never }).check({}, scope)
    expect(result.status).toBe('degraded')
    expect(result.details.deadLettered24h).toBe(3)
    const eventCall = calls.find((call) => call.entity === MetaLeadEvent)
    expect(eventCall?.where.status).toBe('dead_lettered')
  })
})

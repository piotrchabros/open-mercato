import type { EntityManager } from '@mikro-orm/postgresql'
import { MetaConnection, MetaLeadEvent, MetaPage } from '../data/entities'
import type { MetaScope } from './constants'

export type MetaLeadAdsHealthStatus = 'healthy' | 'degraded' | 'unhealthy'

export type MetaLeadAdsHealthResult = {
  status: MetaLeadAdsHealthStatus
  message?: string
  details: {
    connections: number
    pagesActive: number
    pagesTotal: number
    deadLettered24h: number
  }
}

const DEAD_LETTER_WINDOW_MS = 24 * 60 * 60 * 1000

export function createMetaLeadAdsHealthCheck({ em }: { em: EntityManager }) {
  async function check(
    _credentials: Record<string, unknown> | null,
    scope: MetaScope,
  ): Promise<MetaLeadAdsHealthResult> {
    const scoped = { tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null }
    const since = new Date(Date.now() - DEAD_LETTER_WINDOW_MS)
    const [connections, brokenConnections, pagesTotal, pagesActive, deadLettered24h] = await Promise.all([
      em.count(MetaConnection, scoped),
      em.count(MetaConnection, { ...scoped, status: { $in: ['token_expired', 'invalid'] } }),
      em.count(MetaPage, scoped),
      em.count(MetaPage, { ...scoped, subscriptionStatus: 'active' }),
      em.count(MetaLeadEvent, { ...scoped, status: 'dead_lettered', updatedAt: { $gte: since } }),
    ])
    const details = { connections, pagesActive, pagesTotal, deadLettered24h }
    if (brokenConnections > 0) {
      return { status: 'unhealthy', message: 'meta_lead_ads.health.connectionBroken', details }
    }
    if (pagesActive < pagesTotal || deadLettered24h > 0) {
      return { status: 'degraded', message: 'meta_lead_ads.health.degraded', details }
    }
    return { status: 'healthy', details }
  }

  return { check }
}

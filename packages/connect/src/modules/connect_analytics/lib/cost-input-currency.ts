import type { AppContainer } from '@open-mercato/shared/lib/di/container'

/**
 * Scoped base-currency adapter for cost accounting.
 *
 * `currencies` owns what an organization's base currency is. Analytics only
 * needs the answer, so it resolves the peer service **structurally** — by DI
 * name and method shape — and never imports the Currency entity or reads its
 * table. That keeps `connect_analytics` soft-optional relative to `currencies`
 * while still refusing to store a currency nobody sanctioned.
 *
 * Every failure mode is a refusal, never a fallback. A format-only check
 * (`/^[A-Z]{3}$/`) would happily accept `XXX` on a tenant whose books are in
 * EUR, and a hard-coded default would silently mislabel real money — so a
 * missing service, a missing method, a malformed result, a disabled currencies
 * module and a thrown query all collapse to `unavailable` and the write fails
 * closed.
 */

export type CostInputCurrencyResolution =
  | { status: 'resolved'; code: string }
  | { status: 'missing' | 'ambiguous' | 'unavailable' }

export type CostInputCurrencyResolver = {
  resolve(input: { tenantId: string; organizationId: string }): Promise<CostInputCurrencyResolution>
}

type BaseCurrencyServiceLike = {
  resolveBaseCurrency: (scope: { tenantId: string; organizationIds: string[] }) => Promise<unknown>
}

function isBaseCurrencyServiceLike(candidate: unknown): candidate is BaseCurrencyServiceLike {
  return typeof candidate === 'object'
    && candidate !== null
    && typeof (candidate as BaseCurrencyServiceLike).resolveBaseCurrency === 'function'
}

function interpretResolution(raw: unknown): CostInputCurrencyResolution {
  if (typeof raw !== 'object' || raw === null) return { status: 'unavailable' }
  const status = (raw as { status?: unknown }).status
  if (status === 'missing' || status === 'ambiguous' || status === 'unavailable') return { status }
  if (status !== 'resolved') return { status: 'unavailable' }
  const code = (raw as { code?: unknown }).code
  if (typeof code !== 'string') return { status: 'unavailable' }
  const normalized = code.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(normalized) ? { status: 'resolved', code: normalized } : { status: 'unavailable' }
}

export function createCostInputCurrencyResolver(container: AppContainer): CostInputCurrencyResolver {
  return {
    async resolve({ tenantId, organizationId }) {
      if (!tenantId || !organizationId) return { status: 'unavailable' }

      let service: unknown
      try {
        service = container.resolve('baseCurrencyService')
      } catch {
        return { status: 'unavailable' }
      }
      if (!isBaseCurrencyServiceLike(service)) return { status: 'unavailable' }

      try {
        const raw = await service.resolveBaseCurrency({ tenantId, organizationIds: [organizationId] })
        return interpretResolution(raw)
      } catch {
        return { status: 'unavailable' }
      }
    },
  }
}

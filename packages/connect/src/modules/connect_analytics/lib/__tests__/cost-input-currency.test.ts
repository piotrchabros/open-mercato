import { createCostInputCurrencyResolver } from '../cost-input-currency'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'

const SCOPE = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
}

function containerWith(resolve: (name: string) => unknown): AppContainer {
  return { resolve } as unknown as AppContainer
}

describe('costInputCurrencyResolver', () => {
  it('passes the exact dual scope through to the source service', async () => {
    const resolveBaseCurrency = jest.fn().mockResolvedValue({ status: 'resolved', code: 'EUR' })
    const resolver = createCostInputCurrencyResolver(containerWith(() => ({ resolveBaseCurrency })))

    await resolver.resolve(SCOPE)

    expect(resolveBaseCurrency).toHaveBeenCalledWith({
      tenantId: SCOPE.tenantId,
      organizationIds: [SCOPE.organizationId],
    })
  })

  it('returns the resolved code uppercased', async () => {
    const resolver = createCostInputCurrencyResolver(
      containerWith(() => ({ resolveBaseCurrency: async () => ({ status: 'resolved', code: ' eur ' }) })),
    )

    await expect(resolver.resolve(SCOPE)).resolves.toEqual({ status: 'resolved', code: 'EUR' })
  })

  it.each(['missing', 'ambiguous', 'unavailable'] as const)('passes the %s outcome through', async (status) => {
    const resolver = createCostInputCurrencyResolver(
      containerWith(() => ({ resolveBaseCurrency: async () => ({ status }) })),
    )

    await expect(resolver.resolve(SCOPE)).resolves.toEqual({ status })
  })

  // Every one of these would, if it degraded to a format-only check, let an
  // unverified currency code onto a stored money row.
  it('is unavailable when the currencies module is not registered', async () => {
    const resolver = createCostInputCurrencyResolver(containerWith(() => {
      throw new Error('[internal] not registered')
    }))

    await expect(resolver.resolve(SCOPE)).resolves.toEqual({ status: 'unavailable' })
  })

  it('is unavailable when the resolved service has no resolveBaseCurrency method', async () => {
    const resolver = createCostInputCurrencyResolver(containerWith(() => ({ somethingElse: () => null })))

    await expect(resolver.resolve(SCOPE)).resolves.toEqual({ status: 'unavailable' })
  })

  it('is unavailable when the source query throws', async () => {
    const resolver = createCostInputCurrencyResolver(
      containerWith(() => ({
        resolveBaseCurrency: async () => {
          throw new Error('[internal] connection refused')
        },
      })),
    )

    await expect(resolver.resolve(SCOPE)).resolves.toEqual({ status: 'unavailable' })
  })

  it.each([
    ['a null result', null],
    ['a non-object result', 'EUR'],
    ['an unknown status', { status: 'weird', code: 'EUR' }],
    ['a resolved status with no code', { status: 'resolved' }],
    ['a resolved status with a non-string code', { status: 'resolved', code: 978 }],
    ['a resolved status with a malformed code', { status: 'resolved', code: 'EURO' }],
  ])('is unavailable for %s', async (_label, raw) => {
    const resolver = createCostInputCurrencyResolver(
      containerWith(() => ({ resolveBaseCurrency: async () => raw })),
    )

    await expect(resolver.resolve(SCOPE)).resolves.toEqual({ status: 'unavailable' })
  })

  it('is unavailable without ever calling the source when the scope is incomplete', async () => {
    const resolveBaseCurrency = jest.fn()
    const resolver = createCostInputCurrencyResolver(containerWith(() => ({ resolveBaseCurrency })))

    await expect(resolver.resolve({ tenantId: '', organizationId: SCOPE.organizationId }))
      .resolves.toEqual({ status: 'unavailable' })
    await expect(resolver.resolve({ tenantId: SCOPE.tenantId, organizationId: '' }))
      .resolves.toEqual({ status: 'unavailable' })
    expect(resolveBaseCurrency).not.toHaveBeenCalled()
  })

  it('never resolves anything other than baseCurrencyService', async () => {
    const resolve = jest.fn().mockReturnValue({ resolveBaseCurrency: async () => ({ status: 'resolved', code: 'PLN' }) })
    const resolver = createCostInputCurrencyResolver(containerWith(resolve))

    await resolver.resolve(SCOPE)

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith('baseCurrencyService')
  })
})

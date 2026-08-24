import type { ConnectAllocatedCostReader } from '@open-mercato/connect/modules/connect_analytics/lib/allocated-cost-contract'
import type { ConnectContactDenominatorReader } from '@open-mercato/connect/modules/connect/lib/contact-denominator-reader'
import { createCostPerContactSourceResolver } from '../source-resolver'

const costReader: ConnectAllocatedCostReader = {
  summarizeAllocated: jest.fn(),
}
const denominatorReader: ConnectContactDenominatorReader = {
  countCanonicalRoots: jest.fn(),
}

describe('cost reporting source resolver', () => {
  it('distinguishes disabled registrations from failed resolution', () => {
    const disabled = createCostPerContactSourceResolver({
      hasRegistration: () => false,
      resolveCostReader: () => costReader,
      resolveDenominatorReader: () => denominatorReader,
    })
    expect(disabled.cost()).toEqual({ status: 'module_disabled' })
    expect(disabled.denominator()).toEqual({ status: 'module_disabled' })

    const unavailable = createCostPerContactSourceResolver({
      hasRegistration: () => true,
      resolveCostReader: () => { throw new Error('[internal] unavailable') },
      resolveDenominatorReader: () => { throw new Error('[internal] unavailable') },
    })
    expect(unavailable.cost()).toEqual({ status: 'reader_unavailable' })
    expect(unavailable.denominator()).toEqual({ status: 'reader_unavailable' })
  })

  it('returns only the published reader facades', () => {
    const resolver = createCostPerContactSourceResolver({
      hasRegistration: () => true,
      resolveCostReader: () => costReader,
      resolveDenominatorReader: () => denominatorReader,
    })
    expect(resolver.cost()).toEqual({ status: 'available', reader: costReader })
    expect(resolver.denominator()).toEqual({ status: 'available', reader: denominatorReader })
  })
})

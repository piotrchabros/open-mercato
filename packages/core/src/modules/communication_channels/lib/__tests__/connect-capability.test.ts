import {
  CONNECT_CAPABILITY_CONTRACT_VERSION,
  CONNECT_CAPABILITY_REPORTER_DI_KEY,
  probeConnectCapabilities,
} from '../connect-capability'

/**
 * The handshake is the only thing standing between "Connect owns this channel's
 * Customer timeline" and "nobody does". It must fail closed for every way
 * Connect can be absent, broken, or incompatible.
 */

function containerWith(reporter: unknown, registered = true) {
  return {
    hasRegistration: (name: string) => registered && name === CONNECT_CAPABILITY_REPORTER_DI_KEY,
    resolve: () => reporter,
  }
}

function fullReport(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: CONNECT_CAPABILITY_CONTRACT_VERSION,
    ingestActive: true,
    inboundEnvelopeContract: true,
    customerProjection: true,
    recoverySchedulesRegistered: true,
    ...overrides,
  }
}

describe('probeConnectCapabilities', () => {
  it('succeeds when every capability is live and the version matches', async () => {
    const container = containerWith({ describeCapabilities: async () => fullReport() })
    const result = await probeConnectCapabilities(container)
    expect(result).toEqual({ ok: true, report: fullReport() })
  })

  // Connect is an optional peer: an installation without it must not throw,
  // and must not be able to cut a channel over.
  it('reports connect_not_installed when the reporter is not registered', async () => {
    const result = await probeConnectCapabilities(containerWith(undefined, false))
    expect(result).toEqual({ ok: false, missing: ['connect_not_installed'] })
  })

  it('reports connect_not_installed when resolution throws', async () => {
    const container = {
      resolve: () => {
        throw new Error('[internal] not registered')
      },
    }
    const result = await probeConnectCapabilities(container)
    expect(result).toEqual({ ok: false, missing: ['connect_not_installed'] })
  })

  it('fails closed when the reporter throws', async () => {
    const container = containerWith({
      describeCapabilities: async () => {
        throw new Error('[internal] probe exploded')
      },
    })
    const result = await probeConnectCapabilities(container)
    expect(result).toEqual({ ok: false, missing: ['connect_capability_probe_failed'] })
  })

  it('fails closed on a malformed report', async () => {
    const container = containerWith({ describeCapabilities: async () => ({ ingestActive: 'yes' }) })
    const result = await probeConnectCapabilities(container)
    expect(result).toEqual({ ok: false, missing: ['connect_capability_report_invalid'] })
  })

  // A newer Connect may mean something different by "projection is active", so
  // a version mismatch is a refusal rather than an optimistic guess.
  it('refuses a mismatched contract version', async () => {
    const container = containerWith({
      describeCapabilities: async () => fullReport({ contractVersion: CONNECT_CAPABILITY_CONTRACT_VERSION + 1 }),
    })
    const result = await probeConnectCapabilities(container)
    expect(result).toEqual({ ok: false, missing: ['connect_contract_version_mismatch'] })
  })

  it.each([
    ['ingestActive', 'connect_ingest_inactive'],
    ['inboundEnvelopeContract', 'connect_inbound_envelope_contract'],
    ['customerProjection', 'connect_customer_projection'],
    ['recoverySchedulesRegistered', 'connect_recovery_schedules'],
  ])('names %s as missing when it is not live', async (field, code) => {
    const container = containerWith({
      describeCapabilities: async () => fullReport({ [field]: false }),
    })
    const result = await probeConnectCapabilities(container)
    expect(result).toEqual({ ok: false, missing: [code] })
  })

  it('reports every missing capability at once so the operator sees the full gap', async () => {
    const container = containerWith({
      describeCapabilities: async () =>
        fullReport({ ingestActive: false, customerProjection: false }),
    })
    const result = await probeConnectCapabilities(container)
    expect(result).toEqual({
      ok: false,
      missing: ['connect_ingest_inactive', 'connect_customer_projection'],
    })
  })
})

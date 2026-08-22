import {
  CONNECT_CAPABILITY_CONTRACT_VERSION,
  createCapabilityReporter,
  evaluateActivation,
} from '../activation'

/**
 * Activation is what stops Connect from dead-lettering a legacy tenant's mail
 * before it owns anything, and what stops Contract E from cutting a channel
 * over to a Connect that cannot actually process it.
 */

const ALL_KEYS = [
  'communicationChannelsInboundEnvelopeReader',
  'communicationChannelsSharedInboxAuthorization',
  'customersInteractionLifecycle',
  'schedulerService',
]

function containerWith(available: readonly string[]) {
  return {
    hasRegistration: (name: string) => available.includes(name),
    resolve: (name: string) => (available.includes(name) ? {} : null),
  }
}

describe('evaluateActivation', () => {
  it('is active when every prerequisite resolves', () => {
    expect(evaluateActivation(containerWith(ALL_KEYS))).toEqual({ state: 'active' })
  })

  it.each([
    ['communicationChannelsInboundEnvelopeReader', 'inbound_envelope_contract'],
    ['communicationChannelsSharedInboxAuthorization', 'shared_inbox_authorization'],
    ['customersInteractionLifecycle', 'customer_interaction_lifecycle'],
    ['schedulerService', 'scheduler_unavailable'],
  ])('names %s as missing', (key, prerequisite) => {
    const available = ALL_KEYS.filter((candidate) => candidate !== key)
    expect(evaluateActivation(containerWith(available))).toEqual({
      state: 'inert',
      missing: [prerequisite],
    })
  })

  it('reports every missing prerequisite at once', () => {
    const status = evaluateActivation(containerWith([]))
    expect(status.state).toBe('inert')
    if (status.state !== 'inert') return
    expect(status.missing).toHaveLength(4)
  })

  it('treats a throwing resolve as missing rather than propagating', () => {
    const container = {
      resolve: () => {
        throw new Error('not registered')
      },
    }
    expect(evaluateActivation(container).state).toBe('inert')
  })
})

describe('createCapabilityReporter', () => {
  it('reports every capability live when Connect is fully wired', async () => {
    const report = await createCapabilityReporter(containerWith(ALL_KEYS)).describeCapabilities()
    expect(report).toEqual({
      contractVersion: CONNECT_CAPABILITY_CONTRACT_VERSION,
      ingestActive: true,
      inboundEnvelopeContract: true,
      customerProjection: true,
      recoverySchedulesRegistered: true,
    })
  })

  // The coupling that matters: a Connect-managed channel with no recovery would
  // strand receipts after any outage, so Contract E must refuse the cutover.
  it('refuses to claim readiness when recovery schedules could not be registered', async () => {
    const available = ALL_KEYS.filter((key) => key !== 'schedulerService')
    const report = await createCapabilityReporter(containerWith(available)).describeCapabilities()
    expect(report.recoverySchedulesRegistered).toBe(false)
    expect(report.ingestActive).toBe(false)
  })

  it('reports the envelope contract missing without claiming ingest is active', async () => {
    const available = ALL_KEYS.filter((key) => key !== 'communicationChannelsInboundEnvelopeReader')
    const report = await createCapabilityReporter(containerWith(available)).describeCapabilities()
    expect(report).toMatchObject({ inboundEnvelopeContract: false, ingestActive: false })
  })
})

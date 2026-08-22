import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('connect').child({ component: 'activation' })

/**
 * Connect activation and capability reporting.
 *
 * The inbound subscriber is ALWAYS registered — auto-discovery has no
 * conditional path, and a subscriber that appears only under some conditions is
 * a subscriber whose absence nobody notices. Instead it is always present and
 * checks this service before doing any work.
 *
 * Two distinct failure modes, deliberately handled differently:
 *
 *   - **Before any Connect-managed channel exists**, missing prerequisites keep
 *     the handler INERT. Nothing is wrong; Connect simply has no traffic to own,
 *     and failing delivery would dead-letter every legacy message in the tenant.
 *   - **After Contract E has enabled a channel**, a prerequisite/DI/scheduler
 *     outage is RETRYABLE. The handler fails delivery without acknowledging the
 *     persistent source event, so the message is redelivered rather than lost —
 *     losing a customer's mail to a transient outage is not acceptable.
 *
 * Partial deployment is never advertised as active: a missing piece makes the
 * whole capability report unavailable, with a reason an operator can act on.
 */

/** Version of the upstream contract surface this Connect build expects. */
export const CONNECT_CAPABILITY_CONTRACT_VERSION = 1

export type ConnectPrerequisite =
  | 'inbound_envelope_contract'
  | 'shared_inbox_authorization'
  | 'customer_interaction_lifecycle'
  | 'scheduler_unavailable'
  | 'queue_unavailable'

export type ConnectActivationStatus =
  | { state: 'active' }
  | { state: 'inert'; missing: ConnectPrerequisite[] }

type ContainerLike = {
  hasRegistration?: (name: string) => boolean
  resolve: <T = unknown>(name: string) => T
}

/** DI keys Connect depends on, and the prerequisite each one satisfies. */
const REQUIRED_DEPENDENCIES: ReadonlyArray<{ key: string; prerequisite: ConnectPrerequisite }> = [
  { key: 'communicationChannelsInboundEnvelopeReader', prerequisite: 'inbound_envelope_contract' },
  { key: 'communicationChannelsSharedInboxAuthorization', prerequisite: 'shared_inbox_authorization' },
  { key: 'customersInteractionLifecycle', prerequisite: 'customer_interaction_lifecycle' },
]

/** Optional infrastructure — absent means recovery cannot run, so not active. */
const REQUIRED_INFRASTRUCTURE: ReadonlyArray<{ key: string; prerequisite: ConnectPrerequisite }> = [
  { key: 'schedulerService', prerequisite: 'scheduler_unavailable' },
]

function canResolve(container: ContainerLike, key: string): boolean {
  try {
    if (typeof container.hasRegistration === 'function' && !container.hasRegistration(key)) return false
    return container.resolve(key) != null
  } catch {
    return false
  }
}

/**
 * Evaluate whether Connect can do work right now.
 *
 * Deliberately cheap and synchronous-ish: it runs on every inbound delivery, so
 * it probes DI registrations rather than making network or database calls.
 */
export function evaluateActivation(container: ContainerLike): ConnectActivationStatus {
  const missing: ConnectPrerequisite[] = []
  for (const dependency of [...REQUIRED_DEPENDENCIES, ...REQUIRED_INFRASTRUCTURE]) {
    if (!canResolve(container, dependency.key)) missing.push(dependency.prerequisite)
  }
  if (missing.length > 0) return { state: 'inert', missing }
  return { state: 'active' }
}

export type ConnectCapabilityReport = {
  contractVersion: number
  ingestActive: boolean
  inboundEnvelopeContract: boolean
  customerProjection: boolean
  recoverySchedulesRegistered: boolean
}

/**
 * `connectCapabilityReporter` — the answer Contract E's handshake reads before
 * letting an administrator cut a shared channel over to Connect projection.
 *
 * It reports what is actually resolvable, not what this build intends to
 * support. If Connect is installed but its recovery schedules could not be
 * registered, the honest answer is "not ready", because a Connect-managed
 * channel with no recovery would silently strand receipts after any outage.
 */
export function createCapabilityReporter(container: ContainerLike) {
  return {
    async describeCapabilities(): Promise<ConnectCapabilityReport> {
      const status = evaluateActivation(container)
      const missing = status.state === 'inert' ? new Set(status.missing) : new Set<ConnectPrerequisite>()
      const report: ConnectCapabilityReport = {
        contractVersion: CONNECT_CAPABILITY_CONTRACT_VERSION,
        ingestActive: status.state === 'active',
        inboundEnvelopeContract: !missing.has('inbound_envelope_contract'),
        customerProjection: !missing.has('customer_interaction_lifecycle'),
        recoverySchedulesRegistered: !missing.has('scheduler_unavailable'),
      }
      if (status.state !== 'active') {
        logger.warn('connect capability probe reports inactive', { missing: [...missing] })
      }
      return report
    },
  }
}

export type ConnectCapabilityReporter = ReturnType<typeof createCapabilityReporter>

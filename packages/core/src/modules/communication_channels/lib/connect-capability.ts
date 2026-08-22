import { z } from 'zod'

/**
 * Connect capability handshake (Connect upstream Contract E).
 *
 * A `connect_managed` channel hands its entire Customer-timeline projection to
 * Connect: the legacy customers subscribers skip it, so if Connect is absent,
 * mid-upgrade, or missing a contract, the channel's traffic would be projected
 * by nobody and the loss would be silent. Provisioning or cutting a channel
 * over therefore requires a source-verified handshake first — if any capability
 * is unavailable, creation/activation fails BEFORE any traffic and the channel
 * stays disabled or legacy.
 *
 * The hub does not import Connect. Connect registers a reporter under
 * {@link CONNECT_CAPABILITY_REPORTER_DI_KEY}; the hub resolves it softly and
 * treats an absent registration as "Connect is not installed".
 */

/**
 * Version of the capability contract this hub understands. Connect reports the
 * version it implements; a mismatch fails the handshake rather than guessing,
 * because a newer Connect may have changed what "projection is active" means.
 */
export const CONNECT_CAPABILITY_CONTRACT_VERSION = 1

/** DI key Connect registers its capability reporter under. */
export const CONNECT_CAPABILITY_REPORTER_DI_KEY = 'connectCapabilityReporter'

/**
 * The capabilities a channel cutover depends on. Each maps to one upstream
 * contract or Connect subsystem that must already be live.
 */
export const connectCapabilityReportSchema = z.object({
  /** Contract version Connect implements. Must equal the hub's. */
  contractVersion: z.number().int(),
  /** Connect Foundation ingest is installed and accepting inbound receipts. */
  ingestActive: z.boolean(),
  /** Connect can read the hub's inbound envelope facade (Contract D). */
  inboundEnvelopeContract: z.boolean(),
  /** Connect's Customer projection (Contract B consumer) is installed. */
  customerProjection: z.boolean(),
  /** Connect's recovery/reconciliation schedules are registered. */
  recoverySchedulesRegistered: z.boolean(),
})

export type ConnectCapabilityReport = z.infer<typeof connectCapabilityReportSchema>

export type ConnectCapabilityReporter = {
  describeCapabilities: () => Promise<unknown>
}

export type ConnectCapabilityHandshake =
  | { ok: true; report: ConnectCapabilityReport }
  | { ok: false; missing: string[] }

type ContainerLike = {
  hasRegistration?: (name: string) => boolean
  resolve: <T = unknown>(name: string) => T
}

/**
 * Softly resolve Connect's capability reporter. Connect is an OPTIONAL peer of
 * the hub, so an unconditional `container.resolve` would break every
 * installation without it (cross-module coupling rule: the upstream module must
 * never hard-require its consumer).
 */
function tryResolveReporter(container: ContainerLike): ConnectCapabilityReporter | undefined {
  try {
    if (typeof container.hasRegistration === 'function') {
      if (!container.hasRegistration(CONNECT_CAPABILITY_REPORTER_DI_KEY)) return undefined
    }
    return container.resolve<ConnectCapabilityReporter>(CONNECT_CAPABILITY_REPORTER_DI_KEY)
  } catch {
    return undefined
  }
}

/**
 * Run the handshake. Fails closed: an absent reporter, a throwing reporter, a
 * malformed report, a version mismatch, or any single unavailable capability
 * all yield `{ ok: false }` with the specific missing pieces named so the admin
 * page can tell the operator what to install.
 */
export async function probeConnectCapabilities(
  container: ContainerLike,
): Promise<ConnectCapabilityHandshake> {
  const reporter = tryResolveReporter(container)
  if (!reporter || typeof reporter.describeCapabilities !== 'function') {
    return { ok: false, missing: ['connect_not_installed'] }
  }

  let raw: unknown
  try {
    raw = await reporter.describeCapabilities()
  } catch {
    return { ok: false, missing: ['connect_capability_probe_failed'] }
  }

  const parsed = connectCapabilityReportSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, missing: ['connect_capability_report_invalid'] }

  const report = parsed.data
  const missing: string[] = []
  if (report.contractVersion !== CONNECT_CAPABILITY_CONTRACT_VERSION) {
    missing.push('connect_contract_version_mismatch')
  }
  if (!report.ingestActive) missing.push('connect_ingest_inactive')
  if (!report.inboundEnvelopeContract) missing.push('connect_inbound_envelope_contract')
  if (!report.customerProjection) missing.push('connect_customer_projection')
  if (!report.recoverySchedulesRegistered) missing.push('connect_recovery_schedules')

  if (missing.length > 0) return { ok: false, missing }
  return { ok: true, report }
}

import { createLogger } from '@open-mercato/shared/lib/logger'
import type {
  ConnectContentOrigin,
  ConnectPrincipalKind,
  ConnectResponseEvidence,
} from '../data/entities'
import type { ConnectPrincipalKindReader } from './principal-classification'

const logger = createLogger('connect').child({ component: 'response-evidence' })

/**
 * What can be proven about who answered the customer.
 *
 * The asymmetry here is deliberate and is the whole safety argument: claiming a
 * bot's reply was human is unrecoverable — it credits a person who never read
 * the message — while recording a real person's reply as `unknown` only loses
 * an observation. So every branch fails closed to `unknown`, and only two
 * narrow, independently corroborated cases escape it.
 *
 * Evidence is computed ONCE, inside the enqueue transaction, and frozen on the
 * message. Recomputing it later would let a reclassification, a rename or a
 * deletion retroactively change what is claimed about a reply already sent.
 */

export const CONNECT_CONTENT_ORIGINS = ['human_authored', 'ai_draft', 'automation'] as const

export const CONNECT_RESPONSE_EVIDENCES = ['human', 'human_accepted_ai', 'unknown'] as const

/** Bump only alongside a documented rule change; stored on every message. */
export const CONNECT_RESPONSE_EVIDENCE_VERSION = 1

export type ResponseEvidenceInput = {
  contentOrigin: ConnectContentOrigin
  /** Independently resolved kind of the composing user, or null when unresolved. */
  authorPrincipalKind: ConnectPrincipalKind | null
  /** The authenticated user who accepted an AI draft, when one did. */
  acceptedByUserId: string | null
  acceptedByPrincipalKind: ConnectPrincipalKind | null
}

export function computeResponseEvidence(input: ResponseEvidenceInput): ConnectResponseEvidence {
  if (input.contentOrigin === 'human_authored' && input.authorPrincipalKind === 'human') {
    return 'human'
  }
  // An AI draft only counts once a resolved HUMAN acceptor is on record. An
  // acceptor id with no classification behind it proves nothing: it could be a
  // service account clicking approve.
  if (
    input.contentOrigin === 'ai_draft' &&
    input.acceptedByUserId !== null &&
    input.acceptedByPrincipalKind === 'human'
  ) {
    return 'human_accepted_ai'
  }
  return 'unknown'
}

type ContainerLike = { resolve: <T = unknown>(name: string) => T }

/**
 * Resolve principal kinds without ever being able to fail a send.
 *
 * The reader is a soft dependency: Connect owns classification, but a build
 * without the sidecar provisioned, an Auth facade that is down, or a user who
 * was deleted must all degrade to "we cannot tell" rather than refusing to
 * deliver an agent's reply to a customer.
 */
export async function resolvePrincipalKindsSoftly(
  container: ContainerLike,
  input: { tenantId: string; organizationId: string; userIds: readonly string[] },
): Promise<Map<string, ConnectPrincipalKind>> {
  const userIds = Array.from(new Set(input.userIds.filter((userId) => typeof userId === 'string' && userId)))
  if (userIds.length === 0) return new Map()

  let reader: ConnectPrincipalKindReader | null = null
  try {
    const candidate = container.resolve<unknown>('connectPrincipalKindReader')
    if (candidate && typeof (candidate as ConnectPrincipalKindReader).resolve === 'function') {
      reader = candidate as ConnectPrincipalKindReader
    }
  } catch {
    reader = null
  }
  if (!reader) {
    logger.debug('principal kind reader unavailable; response evidence stays unknown')
    return new Map()
  }

  try {
    const records = await reader.resolve({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      userIds,
    })
    return new Map(records.map((record) => [record.userId, record.kind]))
  } catch (err) {
    logger.warn('principal classification could not be resolved; response evidence stays unknown', { err })
    return new Map()
  }
}

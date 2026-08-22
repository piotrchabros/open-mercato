import type { EntityManager } from '@mikro-orm/postgresql'
import { authorizeFeatures } from '@open-mercato/shared/security/featurePolicy'
import { ChannelDeliveryAttempt, CommunicationChannel } from '../data/entities'
import { getChannelAdapter } from './adapter-registry-singleton'
import {
  SHARED_INBOX_SEND_FEATURE,
  authorizeSharedInbox,
} from './shared-inbox-authorization'

/**
 * Read-only send-status reconciliation facade (Connect upstream Contract A).
 *
 * The question this answers is "did my send happen?", asked by a caller that
 * lost the original response. It is the ONLY sanctioned way to answer it,
 * because the alternative — resending to find out — is exactly the mistake the
 * correlation record exists to prevent.
 *
 * It never sends. It never calls a provider that could have a side effect. It
 * returns only a conclusive `sent`/`failed`, or `unknown`, and it reports
 * whether the provider can offer independent evidence at all so a caller knows
 * whether `unknown` is temporary or permanent.
 *
 * Every scope component is server-derived. Foreign correlations are
 * indistinguishable from missing ones, so the facade cannot be used to probe
 * which correlation ids exist in another tenant or organization.
 */

export type SendStatusLookupActor = {
  userId: string
  tenantId: string
  organizationId: string | null
  /** Server-resolved effective features (may contain wildcard grants). */
  features: readonly string[]
}

export type SendStatusLookupInput = {
  channelId: string
  correlationId: string
  /**
   * The attempt the caller believes it bound. Required: without it a caller who
   * merely guessed a correlation id could read another caller's outcome.
   */
  attemptId: string
}

/** Whether the provider can independently corroborate an indeterminate send. */
export type ProviderEvidenceSupport = 'supported' | 'unsupported'

export type SendStatusLookupResult =
  | {
      status: 'sent' | 'failed' | 'unknown'
      tenantId: string
      organizationId: string | null
      channelId: string
      correlationId: string
      attemptId: string
      deliveryRevision: number
      providerMessageId: string | null
      reasonCode: string | null
      occurredAt: string | null
      providerEvidence: ProviderEvidenceSupport
    }
  | { status: 'not_found' }

type ContainerLike = { resolve: <T = unknown>(name: string) => T }

/**
 * A still-`pending` attempt is reported as `unknown` rather than as its own
 * state: from the caller's side "in flight" and "we cannot tell" are the same
 * answer — do not resend, ask again later.
 */
function projectStatus(attempt: ChannelDeliveryAttempt): 'sent' | 'failed' | 'unknown' {
  if (attempt.status === 'sent') return 'sent'
  if (attempt.status === 'failed') return 'failed'
  return 'unknown'
}

export async function lookupSendStatus(
  container: ContainerLike,
  actor: SendStatusLookupActor,
  input: SendStatusLookupInput,
): Promise<SendStatusLookupResult> {
  const em = (container.resolve('em') as EntityManager).fork()

  const channel = await em.findOne(CommunicationChannel, {
    id: input.channelId,
    tenantId: actor.tenantId,
    deletedAt: null,
  })
  if (!channel) return { status: 'not_found' }

  // Authorization mirrors the send path exactly: a shared inbox goes through
  // Contract E (scope + active membership + `.send`), a personal mailbox stays
  // owner-only. Anything else — including a legacy tenant-wide channel — has no
  // defined shared-send actor and is refused.
  if (channel.isSharedInbox) {
    if (!actor.organizationId) return { status: 'not_found' }
    const decision = await authorizeSharedInbox(
      em,
      channel.id,
      {
        userId: actor.userId,
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
        features: actor.features,
      },
      SHARED_INBOX_SEND_FEATURE,
    )
    if (!decision.ok) return { status: 'not_found' }
  } else if (channel.userId) {
    if (channel.userId !== actor.userId) return { status: 'not_found' }
  } else {
    const grantedFeatures = Array.isArray(actor.features) ? [...actor.features] : []
    if (!authorizeFeatures(['communication_channels.manage'], { grantedFeatures })) {
      return { status: 'not_found' }
    }
  }

  const attempt = await em.findOne(ChannelDeliveryAttempt, {
    channelId: channel.id,
    tenantId: actor.tenantId,
    organizationId: channel.organizationId ?? null,
    correlationId: input.correlationId,
  })
  // A correlation bound to a different attempt is reported as missing, not as a
  // mismatch: telling a caller "that correlation exists but is not yours" is
  // itself an information leak.
  if (!attempt || attempt.attemptId !== input.attemptId) return { status: 'not_found' }

  const adapter = getChannelAdapter(channel.providerKey)
  const providerEvidence: ProviderEvidenceSupport =
    adapter && typeof adapter.getStatus === 'function' ? 'supported' : 'unsupported'

  return {
    status: projectStatus(attempt),
    tenantId: attempt.tenantId,
    organizationId: attempt.organizationId ?? null,
    channelId: attempt.channelId,
    correlationId: attempt.correlationId,
    attemptId: attempt.attemptId,
    deliveryRevision: attempt.deliveryRevision,
    providerMessageId: attempt.providerMessageId ?? null,
    reasonCode: attempt.reasonCode ?? null,
    occurredAt: attempt.occurredAt ? attempt.occurredAt.toISOString() : null,
    providerEvidence,
  }
}

/** DI service type for cross-module callers (`communicationChannelsSendStatusLookup`). */
export type SendStatusLookupService = typeof lookupSendStatus

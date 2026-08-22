import type { EntityManager } from '@mikro-orm/postgresql'
import { authorizeFeatures } from '@open-mercato/shared/security/featurePolicy'
import { CommunicationChannel, SharedChannelMembership } from '../data/entities'

/**
 * Source-owned shared-inbox authorization (Connect upstream Contract E).
 *
 * This module is the single canonical answer to "may this actor use this shared
 * channel in this organization?". The send contract (A), the thread reader (C),
 * the inbound envelope reader (D), and every shared-inbox admin route delegate
 * here instead of re-deriving the rule — one implementation, one set of tests,
 * one place to revoke.
 *
 * Authorization is the CONJUNCTION of three independent facts:
 *
 *   1. **Scope** — the channel is an organization-owned shared inbox whose
 *      `(tenantId, organizationId)` equals the caller's server-derived scope.
 *   2. **Membership** — an active `SharedChannelMembership` row exists for the
 *      caller on that channel.
 *   3. **Feature** — the caller holds the corresponding immutable ACL feature
 *      (`…shared_inbox.read` / `.send` / `.manage`), wildcard-aware.
 *
 * None of the three grants access alone. In particular, a caller-supplied
 * feature list from a browser payload is never trusted: callers pass the
 * server-resolved granted features from the authenticated session.
 *
 * Every failure returns the same opaque `not_found` outcome for foreign or
 * missing channels so an attacker cannot use the API to learn that a channel ID
 * exists in another tenant or organization.
 */

export const SHARED_INBOX_READ_FEATURE = 'communication_channels.shared_inbox.read'
export const SHARED_INBOX_SEND_FEATURE = 'communication_channels.shared_inbox.send'
export const SHARED_INBOX_MANAGE_FEATURE = 'communication_channels.shared_inbox.manage'

export type SharedInboxFeature =
  | typeof SHARED_INBOX_READ_FEATURE
  | typeof SHARED_INBOX_SEND_FEATURE
  | typeof SHARED_INBOX_MANAGE_FEATURE

/**
 * Server-derived actor context. Every field is resolved from the authenticated
 * session or a trusted service principal — never from a request body.
 */
export type SharedInboxActor = {
  userId: string
  tenantId: string
  organizationId: string
  /** Effective granted features (concrete ids and/or wildcard grants). */
  features: readonly string[]
}

/**
 * Why authorization failed.
 *
 * `not_found` deliberately collapses "no such channel", "channel in another
 * tenant", "channel in a sibling organization", "not a shared inbox" and
 * "soft-deleted" into one indistinguishable outcome. The remaining reasons are
 * only ever reported for a channel the caller has already been proven to see.
 */
export type SharedInboxDenialReason =
  | 'not_found'
  | 'channel_disabled'
  | 'not_a_member'
  | 'missing_feature'
  | 'traffic_not_enabled'

export type SharedInboxAuthorization =
  | { ok: true; channel: CommunicationChannel; membership: SharedChannelMembership }
  | { ok: false; reason: SharedInboxDenialReason }

export type AuthorizeSharedInboxOptions = {
  /**
   * Require that Connect traffic has been enabled on a `connect_managed`
   * channel. Read paths leave this off (an operator may inspect a provisioned
   * inbox before cutover); send and inbound-claim paths turn it on so no
   * message can be observed by a projection owner that is not yet live.
   */
  requireTrafficEnabled?: boolean
}

/**
 * Load a shared inbox by ID within the actor's exact scope.
 *
 * Returns `null` for anything the actor must not be able to distinguish from a
 * missing row: another tenant, a sibling organization, a personal mailbox, a
 * legacy tenant-wide channel, or a soft-deleted row.
 */
export async function loadSharedInbox(
  em: EntityManager,
  channelId: string,
  scope: { tenantId: string; organizationId: string },
): Promise<CommunicationChannel | null> {
  return em.findOne(CommunicationChannel, {
    id: channelId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    isSharedInbox: true,
    deletedAt: null,
  })
}

/** Load the actor's membership row, active or revoked. */
export async function findMembership(
  em: EntityManager,
  channelId: string,
  userId: string,
  scope: { tenantId: string; organizationId: string },
): Promise<SharedChannelMembership | null> {
  return em.findOne(SharedChannelMembership, {
    channelId,
    userId,
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
}

/**
 * The canonical shared-inbox authorization check. See the module docblock for
 * the three conjuncts.
 */
export async function authorizeSharedInbox(
  em: EntityManager,
  channelId: string,
  actor: SharedInboxActor,
  requiredFeature: SharedInboxFeature,
  options: AuthorizeSharedInboxOptions = {},
): Promise<SharedInboxAuthorization> {
  const scope = { tenantId: actor.tenantId, organizationId: actor.organizationId }
  const channel = await loadSharedInbox(em, channelId, scope)
  if (!channel) return { ok: false, reason: 'not_found' }

  // Membership is checked before the feature so a non-member cannot use the
  // difference between `not_a_member` and `missing_feature` to probe another
  // user's grants; both are only reachable once scope already matched.
  const membership = await findMembership(em, channelId, actor.userId, scope)
  if (!membership || !membership.isActive) return { ok: false, reason: 'not_a_member' }

  const grantedFeatures = Array.isArray(actor.features) ? [...actor.features] : []
  if (!authorizeFeatures([requiredFeature], { grantedFeatures })) {
    return { ok: false, reason: 'missing_feature' }
  }

  if (!channel.isActive || channel.status === 'disconnected') {
    return { ok: false, reason: 'channel_disabled' }
  }

  if (
    options.requireTrafficEnabled &&
    channel.projectionMode === 'connect_managed' &&
    !channel.trafficEnabledAt
  ) {
    return { ok: false, reason: 'traffic_not_enabled' }
  }

  return { ok: true, channel, membership }
}

/**
 * Administrative authorization for provisioning, membership and provider
 * recovery operations.
 *
 * Deliberately NOT membership-based: an organization administrator manages a
 * shared inbox they do not personally read. It requires `…shared_inbox.manage`
 * plus an active organization-admin scope, which the caller resolves from the
 * session (never from the request body) and passes as `isOrganizationAdmin`.
 */
export function authorizeSharedInboxAdmin(actor: {
  features: readonly string[]
  isOrganizationAdmin: boolean
}): boolean {
  if (!actor.isOrganizationAdmin) return false
  const grantedFeatures = Array.isArray(actor.features) ? [...actor.features] : []
  return authorizeFeatures([SHARED_INBOX_MANAGE_FEATURE], { grantedFeatures })
}

/**
 * DI facade (`communicationChannelsSharedInboxAuthorization`).
 *
 * The stable in-process entry point that the send contract (A), thread reader
 * (C) and inbound envelope reader (D) call. It forks its own EntityManager so a
 * caller can never hand in an entity manager whose scope it controls, and it
 * returns a plain result — never an ORM entity — so no hub row crosses DI.
 */
export type SharedInboxAuthorizationDecision =
  | {
      ok: true
      channelId: string
      tenantId: string
      organizationId: string
      providerKey: string
      channelType: string
      projectionMode: string
      trafficEnabled: boolean
    }
  | { ok: false; reason: SharedInboxDenialReason }

type ContainerLike = { resolve: <T = unknown>(name: string) => T }

export async function checkSharedInboxAuthorization(
  container: ContainerLike,
  channelId: string,
  actor: SharedInboxActor,
  requiredFeature: SharedInboxFeature,
  options: AuthorizeSharedInboxOptions = {},
): Promise<SharedInboxAuthorizationDecision> {
  const em = (container.resolve('em') as EntityManager).fork()
  const result = await authorizeSharedInbox(em, channelId, actor, requiredFeature, options)
  if (!result.ok) return result
  const { channel } = result
  return {
    ok: true,
    channelId: channel.id,
    tenantId: channel.tenantId,
    organizationId: channel.organizationId as string,
    providerKey: channel.providerKey,
    channelType: channel.channelType,
    projectionMode: channel.projectionMode,
    trafficEnabled: channel.trafficEnabledAt != null,
  }
}

/**
 * Stable error class so route handlers map denials to a masked 404 rather than
 * leaking the underlying reason verbatim.
 */
export class SharedInboxAccessDeniedError extends Error {
  override name = 'SharedInboxAccessDeniedError'
  readonly statusCode = 404
  readonly reason: SharedInboxDenialReason

  constructor(reason: SharedInboxDenialReason) {
    super(`[internal] shared inbox access denied: ${reason}`)
    this.reason = reason
  }
}

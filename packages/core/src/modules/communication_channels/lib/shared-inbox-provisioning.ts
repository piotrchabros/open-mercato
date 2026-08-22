import type { EntityManager } from '@mikro-orm/postgresql'
import { findOneWithDecryption } from '@open-mercato/shared/lib/encryption/find'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { CommunicationChannel } from '../data/entities'
import type { ChannelAdapter } from './adapter'
import type { ChannelAdapterRegistry } from './registry'
import { isUniqueViolation } from './pg-errors'

const logger = createLogger('communication_channels').child({ component: 'shared-inbox-provisioning' })

/**
 * Source-owned shared-email provisioning primitives (Connect upstream
 * Contract E, AUTH-UP-EMAIL-01).
 *
 * Shared inboxes differ from every existing connect flow in three ways, which
 * is why they get their own path instead of a flag on the per-user one:
 *
 *   - the credential is stored with `user_id IS NULL` under the OWNING
 *     ORGANIZATION, not under the connecting administrator;
 *   - the channel row carries `is_shared_inbox` + a non-null `organization_id`,
 *     so the DB check constraint guarantees an unambiguous authorization scope;
 *   - failure is fail-closed. The legacy flow creates a `requires_reauth`
 *     channel when credential persistence fails so the owner can retry. A
 *     half-provisioned SHARED inbox instead means a team mailbox exists that
 *     nobody can send from and whose credential state is unknown, so we create
 *     nothing at all and report the failure.
 *
 * No function here ever returns provider secrets.
 */

/** Why a provider cannot back a shared inbox. */
export type SharedMailboxEligibility =
  | { eligible: true; adapter: ChannelAdapter }
  | { eligible: false; reason: 'unknown_provider' | 'not_shared_mailbox_capable' | 'not_email' }

/**
 * A provider must opt in explicitly via `sharedMailbox: true` AND be an email
 * provider. Push providers are tenant infrastructure and deliberately excluded
 * even though they are also `user_id IS NULL`.
 */
export function checkSharedMailboxEligibility(
  registry: ChannelAdapterRegistry,
  providerKey: string,
): SharedMailboxEligibility {
  const adapter = registry.get(providerKey)
  if (!adapter) return { eligible: false, reason: 'unknown_provider' }
  if (adapter.channelType !== 'email') return { eligible: false, reason: 'not_email' }
  if (adapter.sharedMailbox !== true) return { eligible: false, reason: 'not_shared_mailbox_capable' }
  return { eligible: true, adapter }
}

export type SharedCredentialScope = {
  tenantId: string
  organizationId: string
}

type CredentialsServiceLike = {
  save?: (
    integrationId: string,
    credentials: Record<string, unknown>,
    scope: { organizationId: string; tenantId: string; userId?: string | null },
  ) => Promise<string | void>
}

type ContainerLike = { resolve: <T = unknown>(name: string) => T }

/** Stable integration id for a shared-inbox credential row. */
export function sharedInboxIntegrationId(providerKey: string, organizationId: string): string {
  return `shared_inbox_${providerKey}_${organizationId}`
}

/**
 * Persist shared-mailbox credentials encrypted under the owning organization
 * with `user_id IS NULL`, then resolve the stored row id.
 *
 * Returns `null` when the credential could not be persisted OR could not be
 * read back — the caller must then abort provisioning rather than create a
 * credential-less shared channel. Secrets are never logged or returned.
 */
export async function persistSharedInboxCredentials(
  container: ContainerLike,
  em: EntityManager,
  providerKey: string,
  credentials: Record<string, unknown>,
  scope: SharedCredentialScope,
): Promise<string | null> {
  let credentialsService: CredentialsServiceLike | null = null
  try {
    credentialsService = container.resolve<CredentialsServiceLike>('integrationCredentialsService')
  } catch {
    credentialsService = null
  }
  if (!credentialsService?.save) return null

  const integrationId = sharedInboxIntegrationId(providerKey, scope.organizationId)
  // `userId: null` is what makes this a shared credential: the delivery worker
  // and every member's send resolve the SAME row, and no personal credential is
  // ever copied into the organization's scope.
  const credentialsScope = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    userId: null,
  }

  try {
    await credentialsService.save(integrationId, { ...credentials }, credentialsScope)
  } catch (err) {
    logger.warn('shared inbox credential persist failed', { providerKey, err })
    return null
  }

  try {
    const { IntegrationCredentials } = await import(
      '@open-mercato/core/modules/integrations/data/entities'
    )
    const row = await findOneWithDecryption(
      em,
      IntegrationCredentials,
      {
        integrationId,
        tenantId: credentialsScope.tenantId,
        organizationId: credentialsScope.organizationId,
        userId: null,
        deletedAt: null,
      },
      undefined,
      credentialsScope,
    )
    return (row as { id?: string } | null)?.id ?? null
  } catch (err) {
    logger.warn('shared inbox credential read-back failed', { providerKey, err })
    return null
  }
}

export type CreateSharedInboxChannelArgs = {
  em: EntityManager
  adapter: Pick<ChannelAdapter, 'channelType' | 'capabilities'>
  providerKey: string
  displayName: string
  /** Normalized (lower-cased) mailbox address. */
  externalIdentifier: string
  credentialsRefId: string
  scope: SharedCredentialScope
  pollIntervalSeconds?: number | null
}

export class SharedMailboxAlreadyProvisionedError extends Error {
  override name = 'SharedMailboxAlreadyProvisionedError'
  readonly externalIdentifier: string
  constructor(externalIdentifier: string) {
    super(`[internal] shared mailbox ${externalIdentifier} is already provisioned in this organization`)
    this.externalIdentifier = externalIdentifier
  }
}

/**
 * Create the organization-owned shared channel row.
 *
 * Always starts in `legacy_customers` projection mode with traffic disabled;
 * switching to Connect is a separate, handshake-guarded cutover so a channel
 * can never begin accepting traffic before a projection owner exists.
 */
export async function createSharedInboxChannelRow(
  args: CreateSharedInboxChannelArgs,
): Promise<CommunicationChannel> {
  const { em, adapter, providerKey, displayName, externalIdentifier, credentialsRefId, scope } = args

  const dedupeFilter = {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    providerKey,
    externalIdentifier,
    isSharedInbox: true,
    deletedAt: null,
  }

  const existing = await em.findOne(CommunicationChannel, dedupeFilter)
  if (existing) throw new SharedMailboxAlreadyProvisionedError(externalIdentifier)

  const channel = em.create(CommunicationChannel, {
    providerKey,
    channelType: adapter.channelType,
    displayName,
    externalIdentifier,
    credentialsRef: credentialsRefId,
    capabilities: adapter.capabilities as unknown as Record<string, unknown>,
    isActive: true,
    // A shared inbox has no personal owner and is never anybody's primary.
    userId: null,
    isPrimary: false,
    pollIntervalSeconds: args.pollIntervalSeconds ?? null,
    status: 'connected',
    lastError: null,
    isSharedInbox: true,
    projectionMode: 'legacy_customers',
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
  em.persist(channel)
  try {
    await em.flush()
  } catch (err) {
    // A concurrent provision won the race against
    // `communication_channels_shared_mailbox_uq`. Report the conflict rather
    // than healing the winner: the loser's credentials may differ, and silently
    // adopting someone else's channel would hide that.
    if (isUniqueViolation(err)) throw new SharedMailboxAlreadyProvisionedError(externalIdentifier)
    throw err
  }
  return channel
}

/**
 * Extract the mailbox address from a provider credential bag, normalized to
 * lower case so the dedup index matches canonically. Returns `null` when the
 * provider did not supply an address (which makes it ineligible: a shared inbox
 * without an identity cannot be reconciled or displayed).
 */
export function extractMailboxAddress(credentials: Record<string, unknown>): string | null {
  const candidates = [credentials.fromAddress, credentials.email, credentials.username]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.includes('@')) return candidate.toLowerCase()
  }
  return null
}

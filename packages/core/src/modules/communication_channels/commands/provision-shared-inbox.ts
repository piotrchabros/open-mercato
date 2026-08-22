import { z } from 'zod'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import type { ChannelAdapterRegistry } from '../lib/registry'
import { emitCommunicationChannelsEvent } from '../events'
import { authorizeSharedInboxAdmin } from '../lib/shared-inbox-authorization'
import {
  SharedMailboxAlreadyProvisionedError,
  checkSharedMailboxEligibility,
  createSharedInboxChannelRow,
  extractMailboxAddress,
  persistSharedInboxCredentials,
} from '../lib/shared-inbox-provisioning'

/**
 * Provision an organization-owned shared email inbox from a credential bag
 * (Connect upstream Contract E, AUTH-UP-EMAIL-01).
 *
 * This is the IMAP-style path: the administrator supplies a mailbox secret,
 * the provider validates it, and the credential + channel are created together
 * under the owning organization with `user_id IS NULL`.
 *
 * Gmail uses the OAuth path instead (`gmail/oauth/start` + callback), which
 * reaches the same `createSharedInboxChannelRow` after the consent exchange.
 *
 * Provider secrets are never echoed: every failure mode returns a code, and
 * validation failures return only the provider's field-level messages.
 */

const adminActorSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  features: z.array(z.string()),
  isOrganizationAdmin: z.boolean(),
})

const provisionSharedInboxSchema = z.object({
  providerKey: z.string().min(1).max(64),
  displayName: z.string().min(1).max(255),
  /** Provider-specific credential fields — opaque to the hub. */
  credentials: z.record(z.string(), z.unknown()),
  pollIntervalSeconds: z.number().int().positive().max(86_400).optional(),
  actor: adminActorSchema,
})

export type ProvisionSharedInboxInput = z.infer<typeof provisionSharedInboxSchema>

export type ProvisionSharedInboxResult =
  | { status: 'provisioned'; channelId: string; externalIdentifier: string }
  | { status: 'forbidden' }
  | {
      status: 'provider_ineligible'
      reason: 'unknown_provider' | 'not_shared_mailbox_capable' | 'not_email'
    }
  | { status: 'missing_mailbox_address' }
  | { status: 'validation_failed'; errors: Record<string, string>; errorCodes?: Record<string, string> }
  | { status: 'credentials_unavailable' }
  | { status: 'already_provisioned'; externalIdentifier: string }

export const COMMUNICATION_CHANNELS_PROVISION_SHARED_INBOX_COMMAND_ID =
  'communication_channels.shared_inbox.provision'

const provisionSharedInboxCommand: CommandHandler<
  ProvisionSharedInboxInput,
  ProvisionSharedInboxResult
> = {
  id: COMMUNICATION_CHANNELS_PROVISION_SHARED_INBOX_COMMAND_ID,
  // Not undoable: an undo would have to decide what to do with the provider
  // credential and any traffic already claimed. Removing a shared inbox goes
  // through the explicit, audited disable path instead.
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = provisionSharedInboxSchema.parse(rawInput)
    const { actor } = input
    if (!authorizeSharedInboxAdmin(actor)) return { status: 'forbidden' }

    const registry = ctx.container.resolve('channelAdapterRegistry') as ChannelAdapterRegistry
    const eligibility = checkSharedMailboxEligibility(registry, input.providerKey)
    if (!eligibility.eligible) {
      return { status: 'provider_ineligible', reason: eligibility.reason }
    }
    const { adapter } = eligibility

    const externalIdentifier = extractMailboxAddress(input.credentials)
    if (!externalIdentifier) return { status: 'missing_mailbox_address' }

    const scope = { tenantId: actor.tenantId, organizationId: actor.organizationId }

    if (typeof adapter.validateCredentials === 'function') {
      const validation = await adapter.validateCredentials({
        providerKey: input.providerKey,
        credentials: input.credentials,
        scope,
      })
      if (!validation.ok) {
        return {
          status: 'validation_failed',
          errors: validation.errors ?? { _form: 'Credential validation failed' },
          errorCodes: validation.errorCodes,
        }
      }
    }

    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const credentialsRefId = await persistSharedInboxCredentials(
      ctx.container,
      em,
      input.providerKey,
      input.credentials,
      scope,
    )
    // Fail closed. Unlike the personal connect flow we do NOT create a
    // `requires_reauth` channel: a shared mailbox that exists but has no usable
    // credential is a team-visible dead end whose credential state is unknown.
    if (!credentialsRefId) return { status: 'credentials_unavailable' }

    let channelId: string
    try {
      const channel = await createSharedInboxChannelRow({
        em,
        adapter,
        providerKey: input.providerKey,
        displayName: input.displayName,
        externalIdentifier,
        credentialsRefId,
        scope,
        pollIntervalSeconds: input.pollIntervalSeconds ?? null,
      })
      channelId = channel.id
    } catch (err) {
      if (err instanceof SharedMailboxAlreadyProvisionedError) {
        return { status: 'already_provisioned', externalIdentifier: err.externalIdentifier }
      }
      throw err
    }

    await emitCommunicationChannelsEvent(
      'communication_channels.shared_inbox.provisioned',
      {
        channelId,
        providerKey: input.providerKey,
        externalIdentifier,
        provisionedByUserId: actor.userId,
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
      },
      { persistent: true },
    )

    return { status: 'provisioned', channelId, externalIdentifier }
  },
}

registerCommand(provisionSharedInboxCommand)

export default provisionSharedInboxCommand

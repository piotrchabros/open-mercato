import { z } from 'zod'
import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CommunicationChannel } from '../data/entities'
import { emitCommunicationChannelsEvent } from '../events'
import { authorizeSharedInboxAdmin } from '../lib/shared-inbox-authorization'
import {
  checkSharedMailboxEligibility,
  extractMailboxAddress,
  persistSharedInboxCredentials,
} from '../lib/shared-inbox-provisioning'
import {
  DELIVERY_REASON_CHANNEL_DISABLED,
  OUTBOUND_DELIVERY_STATUS_DISPATCHING,
  OUTBOUND_DELIVERY_STATUS_FAILED,
  OUTBOUND_DELIVERY_STATUS_PENDING,
  OUTBOUND_DELIVERY_STATUS_UNKNOWN,
} from '../lib/delivery-status'
import type { ChannelAdapterRegistry } from '../lib/registry'

/**
 * Shared-inbox provider recovery (Connect upstream Contract E,
 * AUTH-UP-RECOVER-01).
 *
 * Disable, reconnect and secret rotation all preserve channel IDENTITY: the
 * same channel row, the same conversations, the same membership and the same
 * audit trail. An administrator recovering from expired Gmail consent or a
 * rotated IMAP password must never have to create a second inbox, because that
 * would split the team's history in two.
 *
 * The delivery-state classification on disable is the safety-critical part.
 * See `lib/delivery-status.ts` for the state machine: work that provably never
 * reached the provider is terminated as `failed` (an operator may explicitly
 * retry it after reconnecting), while work that may have crossed the provider
 * boundary becomes `unknown` and is reconciliation-only. Reconnect never
 * revives either — it only allows NEW sends.
 */

const adminActorSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  features: z.array(z.string()),
  isOrganizationAdmin: z.boolean(),
})

const channelActionSchema = z.object({
  channelId: z.string().uuid(),
  actor: adminActorSchema,
})

const rotateCredentialsSchema = channelActionSchema.extend({
  credentials: z.record(z.string(), z.unknown()),
})

export type DisableSharedInboxInput = z.infer<typeof channelActionSchema>
export type ReconnectSharedInboxInput = z.infer<typeof channelActionSchema>
export type RotateSharedInboxCredentialsInput = z.infer<typeof rotateCredentialsSchema>

export type DisableSharedInboxResult =
  | { status: 'disabled'; channelId: string; terminatedCount: number; unknownCount: number }
  | { status: 'already_disabled'; channelId: string }
  | { status: 'forbidden' }
  | { status: 'not_found' }

export type ReconnectSharedInboxResult =
  | { status: 'reconnected'; channelId: string }
  | { status: 'already_connected'; channelId: string }
  | { status: 'forbidden' }
  | { status: 'not_found' }
  | { status: 'credentials_missing' }

export type RotateSharedInboxCredentialsResult =
  | { status: 'rotated'; channelId: string }
  | { status: 'forbidden' }
  | { status: 'not_found' }
  | { status: 'provider_ineligible' }
  | { status: 'mailbox_mismatch' }
  | { status: 'validation_failed'; errors: Record<string, string>; errorCodes?: Record<string, string> }
  | { status: 'credentials_unavailable' }

export const COMMUNICATION_CHANNELS_DISABLE_SHARED_INBOX_COMMAND_ID =
  'communication_channels.shared_inbox.disable'
export const COMMUNICATION_CHANNELS_RECONNECT_SHARED_INBOX_COMMAND_ID =
  'communication_channels.shared_inbox.reconnect'
export const COMMUNICATION_CHANNELS_ROTATE_SHARED_INBOX_CREDENTIALS_COMMAND_ID =
  'communication_channels.shared_inbox.rotate_credentials'

async function lockSharedInbox(
  em: EntityManager,
  channelId: string,
  scope: { tenantId: string; organizationId: string },
): Promise<CommunicationChannel | null> {
  return em.findOne(
    CommunicationChannel,
    {
      id: channelId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      isSharedInbox: true,
      deletedAt: null,
    },
    { lockMode: LockMode.PESSIMISTIC_WRITE },
  )
}

const disableSharedInboxCommand: CommandHandler<
  DisableSharedInboxInput,
  DisableSharedInboxResult
> = {
  id: COMMUNICATION_CHANNELS_DISABLE_SHARED_INBOX_COMMAND_ID,
  // Not undoable: an undo would re-enable a provider an administrator
  // deliberately cut off, and could not restore the terminal/unknown delivery
  // classifications it produced. Reconnect is the explicit inverse.
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = channelActionSchema.parse(rawInput)
    const { actor } = input
    if (!authorizeSharedInboxAdmin(actor)) return { status: 'forbidden' }

    const scope = { tenantId: actor.tenantId, organizationId: actor.organizationId }
    const rootEm = (ctx.container.resolve('em') as EntityManager).fork()

    const outcome = await rootEm.transactional(async (em) => {
      const channel = await lockSharedInbox(em as EntityManager, input.channelId, scope)
      if (!channel) return { status: 'not_found' } as DisableSharedInboxResult
      if (!channel.isActive && channel.status === 'disconnected') {
        return { status: 'already_disabled', channelId: channel.id } as DisableSharedInboxResult
      }

      // Blocking new work and classifying in-flight work happen in ONE
      // transaction: otherwise a send enqueued between the two steps would be
      // dispatched against a provider the administrator has already cut off.
      channel.isActive = false
      channel.status = 'disconnected'
      channel.lastError = DELIVERY_REASON_CHANNEL_DISABLED

      // Undispatched work — provably never reached the provider.
      const terminated = await em.execute(
        `update "message_channel_links"
            set "delivery_status" = ?,
                "channel_metadata" = coalesce("channel_metadata", '{}'::jsonb) || jsonb_build_object('lastError', ?::text, 'reasonCode', ?::text, 'retryable', true)
          where "tenant_id" = ?
            and "organization_id" = ?
            and "direction" = 'outbound'
            and "delivery_status" = ?
            and "external_conversation_id" in (
              select "id" from "external_conversations"
               where "channel_id" = ? and "tenant_id" = ?
            )
          returning "id"`,
        [
          OUTBOUND_DELIVERY_STATUS_FAILED,
          DELIVERY_REASON_CHANNEL_DISABLED,
          DELIVERY_REASON_CHANNEL_DISABLED,
          scope.tenantId,
          scope.organizationId,
          OUTBOUND_DELIVERY_STATUS_PENDING,
          channel.id,
          scope.tenantId,
        ],
      )

      // Possibly-dispatched work — the message may already be in the
      // recipient's mailbox, so it is never retried automatically.
      const unresolved = await em.execute(
        `update "message_channel_links"
            set "delivery_status" = ?,
                "channel_metadata" = coalesce("channel_metadata", '{}'::jsonb) || jsonb_build_object('lastError', ?::text, 'reasonCode', ?::text, 'retryable', false)
          where "tenant_id" = ?
            and "organization_id" = ?
            and "direction" = 'outbound'
            and "delivery_status" = ?
            and "external_conversation_id" in (
              select "id" from "external_conversations"
               where "channel_id" = ? and "tenant_id" = ?
            )
          returning "id"`,
        [
          OUTBOUND_DELIVERY_STATUS_UNKNOWN,
          DELIVERY_REASON_CHANNEL_DISABLED,
          DELIVERY_REASON_CHANNEL_DISABLED,
          scope.tenantId,
          scope.organizationId,
          OUTBOUND_DELIVERY_STATUS_DISPATCHING,
          channel.id,
          scope.tenantId,
        ],
      )

      await em.flush()
      return {
        status: 'disabled',
        channelId: channel.id,
        terminatedCount: Array.isArray(terminated) ? terminated.length : 0,
        unknownCount: Array.isArray(unresolved) ? unresolved.length : 0,
      } as DisableSharedInboxResult
    })

    if (outcome.status === 'disabled') {
      await emitCommunicationChannelsEvent(
        'communication_channels.shared_inbox.disabled',
        {
          channelId: outcome.channelId,
          disabledByUserId: actor.userId,
          terminatedCount: outcome.terminatedCount,
          unknownCount: outcome.unknownCount,
          tenantId: actor.tenantId,
          organizationId: actor.organizationId,
        },
        { persistent: true },
      )
    }

    return outcome
  },
}

const reconnectSharedInboxCommand: CommandHandler<
  ReconnectSharedInboxInput,
  ReconnectSharedInboxResult
> = {
  id: COMMUNICATION_CHANNELS_RECONNECT_SHARED_INBOX_COMMAND_ID,
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = channelActionSchema.parse(rawInput)
    const { actor } = input
    if (!authorizeSharedInboxAdmin(actor)) return { status: 'forbidden' }

    const scope = { tenantId: actor.tenantId, organizationId: actor.organizationId }
    const rootEm = (ctx.container.resolve('em') as EntityManager).fork()

    const outcome = await rootEm.transactional(async (em) => {
      const channel = await lockSharedInbox(em as EntityManager, input.channelId, scope)
      if (!channel) return { status: 'not_found' } as ReconnectSharedInboxResult
      // Reconnecting a channel whose credential row was never stored (or was
      // removed) would produce an active channel that fails on first use.
      if (!channel.credentialsRef) return { status: 'credentials_missing' } as ReconnectSharedInboxResult
      if (channel.isActive && channel.status === 'connected') {
        return { status: 'already_connected', channelId: channel.id } as ReconnectSharedInboxResult
      }

      // Deliberately touches ONLY the channel. Terminal (`failed`) and
      // unresolved (`unknown`) links stay exactly as the disable left them:
      // reviving a terminal attempt would resend without an operator decision,
      // and reviving an unknown one could double-send a message that already
      // arrived.
      channel.isActive = true
      channel.status = 'connected'
      channel.lastError = null
      await em.flush()
      return { status: 'reconnected', channelId: channel.id } as ReconnectSharedInboxResult
    })

    if (outcome.status === 'reconnected') {
      await emitCommunicationChannelsEvent(
        'communication_channels.shared_inbox.reconnected',
        {
          channelId: outcome.channelId,
          reconnectedByUserId: actor.userId,
          tenantId: actor.tenantId,
          organizationId: actor.organizationId,
        },
        { persistent: true },
      )
    }

    return outcome
  },
}

const rotateSharedInboxCredentialsCommand: CommandHandler<
  RotateSharedInboxCredentialsInput,
  RotateSharedInboxCredentialsResult
> = {
  id: COMMUNICATION_CHANNELS_ROTATE_SHARED_INBOX_CREDENTIALS_COMMAND_ID,
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = rotateCredentialsSchema.parse(rawInput)
    const { actor } = input
    if (!authorizeSharedInboxAdmin(actor)) return { status: 'forbidden' }

    const scope = { tenantId: actor.tenantId, organizationId: actor.organizationId }
    const em = (ctx.container.resolve('em') as EntityManager).fork()

    const channel = await em.findOne(CommunicationChannel, {
      id: input.channelId,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      isSharedInbox: true,
      deletedAt: null,
    })
    if (!channel) return { status: 'not_found' }

    const registry = ctx.container.resolve('channelAdapterRegistry') as ChannelAdapterRegistry
    const eligibility = checkSharedMailboxEligibility(registry, channel.providerKey)
    if (!eligibility.eligible) return { status: 'provider_ineligible' }

    // Rotation replaces the SECRET, never the identity. A credential bag for a
    // different mailbox would silently re-point the team's inbox at another
    // address while keeping its history and membership.
    const rotatedAddress = extractMailboxAddress(input.credentials)
    if (!rotatedAddress || rotatedAddress !== channel.externalIdentifier) {
      return { status: 'mailbox_mismatch' }
    }

    const { adapter } = eligibility
    if (typeof adapter.validateCredentials === 'function') {
      const validation = await adapter.validateCredentials({
        providerKey: channel.providerKey,
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

    const credentialsRefId = await persistSharedInboxCredentials(
      ctx.container,
      em,
      channel.providerKey,
      input.credentials,
      scope,
    )
    if (!credentialsRefId) return { status: 'credentials_unavailable' }

    channel.credentialsRef = credentialsRefId
    // A validated secret self-heals a `requires_reauth` / `error` channel, but
    // an administratively DISABLED channel stays disabled: re-enabling it is a
    // separate, separately audited decision.
    if (channel.status === 'requires_reauth' || channel.status === 'error') {
      channel.status = 'connected'
      channel.lastError = null
    }
    await em.flush()

    return { status: 'rotated', channelId: channel.id }
  },
}

registerCommand(disableSharedInboxCommand)
registerCommand(reconnectSharedInboxCommand)
registerCommand(rotateSharedInboxCredentialsCommand)

export {
  disableSharedInboxCommand,
  reconnectSharedInboxCommand,
  rotateSharedInboxCredentialsCommand,
}

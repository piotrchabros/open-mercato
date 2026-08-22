import { z } from 'zod'
import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CommunicationChannel, ExternalMessage } from '../data/entities'
import { emitCommunicationChannelsEvent } from '../events'
import { authorizeSharedInboxAdmin } from '../lib/shared-inbox-authorization'
import { probeConnectCapabilities } from '../lib/connect-capability'

/**
 * Cut a shared inbox over to Connect-managed projection (Connect upstream
 * Contract E, AUTH-UP-02).
 *
 * Switching projection mode moves ownership of the Customer timeline from the
 * legacy customers subscribers to Connect. Two things must therefore be true
 * and stay true across the switch:
 *
 *   1. **A projection owner exists.** The capability handshake proves Connect's
 *      ingest, inbound-envelope contract, Customer projection and recovery
 *      schedules are live and version-compatible. If anything is missing the
 *      switch fails BEFORE any traffic and the channel stays legacy.
 *   2. **No traffic gap and no double projection.** Mode and traffic enablement
 *      flip in ONE transaction under the channel write lock. A channel is never
 *      observable as `connect_managed` with traffic already flowing but no
 *      projection, nor as legacy-with-Connect-traffic.
 *
 * Projection mode is immutable once the channel has traffic, so the command
 * refuses a channel that already has messages: re-pointing history at a
 * different projection owner needs an audited history migration that is out of
 * Phase 1 scope.
 */

const adminActorSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  features: z.array(z.string()),
  isOrganizationAdmin: z.boolean(),
})

const enableConnectSchema = z.object({
  channelId: z.string().uuid(),
  actor: adminActorSchema,
})

export type EnableSharedInboxConnectInput = z.infer<typeof enableConnectSchema>

export type EnableSharedInboxConnectResult =
  | { status: 'enabled'; channelId: string }
  | { status: 'already_enabled'; channelId: string }
  | { status: 'forbidden' }
  | { status: 'not_found' }
  | { status: 'has_traffic' }
  | { status: 'connect_unavailable'; missing: string[] }

export const COMMUNICATION_CHANNELS_ENABLE_SHARED_INBOX_CONNECT_COMMAND_ID =
  'communication_channels.shared_inbox.enable_connect'

const enableSharedInboxConnectCommand: CommandHandler<
  EnableSharedInboxConnectInput,
  EnableSharedInboxConnectResult
> = {
  id: COMMUNICATION_CHANNELS_ENABLE_SHARED_INBOX_CONNECT_COMMAND_ID,
  // Not undoable: reverting after traffic has been projected by Connect would
  // strand those Customer interactions under an owner that no longer watches
  // the channel. Reverting requires the same audited history migration as any
  // other post-traffic mode change.
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = enableConnectSchema.parse(rawInput)
    const { actor } = input
    if (!authorizeSharedInboxAdmin(actor)) return { status: 'forbidden' }

    // Probe BEFORE opening the transaction: the handshake calls into Connect and
    // must not hold the channel lock while doing so.
    const handshake = await probeConnectCapabilities(ctx.container)
    if (!handshake.ok) return { status: 'connect_unavailable', missing: handshake.missing }

    const rootEm = (ctx.container.resolve('em') as EntityManager).fork()

    const outcome = await rootEm.transactional(async (em) => {
      const channel = await em.findOne(
        CommunicationChannel,
        {
          id: input.channelId,
          tenantId: actor.tenantId,
          organizationId: actor.organizationId,
          isSharedInbox: true,
          deletedAt: null,
        },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      )
      if (!channel) return { status: 'not_found' } as EnableSharedInboxConnectResult

      if (channel.projectionMode === 'connect_managed' && channel.trafficEnabledAt) {
        return { status: 'already_enabled', channelId: channel.id } as EnableSharedInboxConnectResult
      }

      // Immutability guard: any message at all means the channel's history was
      // already projected by the legacy owner.
      const existingTraffic = await em.count(ExternalMessage, {
        channelId: channel.id,
        tenantId: actor.tenantId,
      })
      if (existingTraffic > 0) return { status: 'has_traffic' } as EnableSharedInboxConnectResult

      const now = new Date()
      channel.projectionMode = 'connect_managed'
      channel.trafficEnabledAt = now
      channel.connectCapabilitySnapshot = {
        ...handshake.report,
        verifiedAt: now.toISOString(),
        verifiedByUserId: actor.userId,
      }
      if (!channel.ownershipFrozenAt) channel.ownershipFrozenAt = now
      await em.flush()
      return { status: 'enabled', channelId: channel.id } as EnableSharedInboxConnectResult
    })

    if (outcome.status === 'enabled') {
      await emitCommunicationChannelsEvent(
        'communication_channels.shared_inbox.connect_enabled',
        {
          channelId: outcome.channelId,
          enabledByUserId: actor.userId,
          tenantId: actor.tenantId,
          organizationId: actor.organizationId,
        },
        { persistent: true },
      )
    }

    return outcome
  },
}

registerCommand(enableSharedInboxConnectCommand)

export default enableSharedInboxConnectCommand

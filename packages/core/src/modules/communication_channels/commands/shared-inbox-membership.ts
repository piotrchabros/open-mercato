import { z } from 'zod'
import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { CommandHandler } from '@open-mercato/shared/lib/commands'
import { registerCommand } from '@open-mercato/shared/lib/commands'
import { CommunicationChannel, SharedChannelMembership } from '../data/entities'
import { emitCommunicationChannelsEvent } from '../events'
import {
  SHARED_INBOX_MANAGE_FEATURE,
  authorizeSharedInboxAdmin,
} from '../lib/shared-inbox-authorization'
import { isActiveOrganizationMember, holdsSharedInboxManage } from '../lib/organization-membership'

/**
 * Shared-inbox membership commands (Connect upstream Contract E, AUTH-UP-02).
 *
 * Membership is the second conjunct of shared-inbox authorization (see
 * `lib/shared-inbox-authorization.ts`). These commands are the ONLY way to
 * mutate it, so every grant and revoke goes through the same guard, the same
 * organization-lock, and the same audit event.
 *
 * Both commands require the acting administrator to hold
 * `communication_channels.shared_inbox.manage` AND an active organization-admin
 * scope — both server-derived by the route, never read from a request body.
 */

const adminActorSchema = z.object({
  userId: z.string().uuid(),
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  /** Server-resolved effective features (may contain wildcard grants). */
  features: z.array(z.string()),
  /** Server-resolved active organization-admin scope. */
  isOrganizationAdmin: z.boolean(),
})

const grantMemberSchema = z.object({
  channelId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  actor: adminActorSchema,
})

const revokeMemberSchema = z.object({
  channelId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  actor: adminActorSchema,
})

export type GrantSharedInboxMemberInput = z.infer<typeof grantMemberSchema>
export type RevokeSharedInboxMemberInput = z.infer<typeof revokeMemberSchema>

export type GrantSharedInboxMemberResult =
  | { status: 'granted'; membershipId: string; reactivated: boolean }
  | { status: 'already_member'; membershipId: string }
  | { status: 'forbidden' }
  | { status: 'not_found' }
  | { status: 'invalid_member'; reason: 'not_in_organization' }

export type RevokeSharedInboxMemberResult =
  | { status: 'revoked'; membershipId: string }
  | { status: 'already_revoked'; membershipId: string }
  | { status: 'forbidden' }
  | { status: 'not_found' }
  | { status: 'last_manager' }

export const COMMUNICATION_CHANNELS_SHARED_INBOX_GRANT_MEMBER_COMMAND_ID =
  'communication_channels.shared_inbox.grant_member'
export const COMMUNICATION_CHANNELS_SHARED_INBOX_REVOKE_MEMBER_COMMAND_ID =
  'communication_channels.shared_inbox.revoke_member'

/**
 * Take the per-channel write lock.
 *
 * Provision and revoke serialize on the owning channel row so two concurrent
 * revocations cannot both observe "there is still another manager" and both
 * succeed, leaving the inbox unmanageable. The lock also covers the
 * ownership-freeze transition, so a first grant and an ownership reassignment
 * cannot interleave.
 */
async function lockChannel(
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

const grantSharedInboxMemberCommand: CommandHandler<
  GrantSharedInboxMemberInput,
  GrantSharedInboxMemberResult
> = {
  id: COMMUNICATION_CHANNELS_SHARED_INBOX_GRANT_MEMBER_COMMAND_ID,
  // Not undoable: an undo would silently re-grant mailbox access after an
  // administrator deliberately removed it. Re-granting is an explicit,
  // separately audited action.
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = grantMemberSchema.parse(rawInput)
    const { actor } = input
    if (!authorizeSharedInboxAdmin(actor)) return { status: 'forbidden' }

    const scope = { tenantId: actor.tenantId, organizationId: actor.organizationId }
    const rootEm = (ctx.container.resolve('em') as EntityManager).fork()

    const outcome = await rootEm.transactional(async (em) => {
      const channel = await lockChannel(em as EntityManager, input.channelId, scope)
      // Existence masking: a channel in another tenant/organization, a personal
      // mailbox, and a missing id are indistinguishable.
      if (!channel) return { status: 'not_found' } as GrantSharedInboxMemberResult

      const memberIsInOrganization = await isActiveOrganizationMember(
        ctx.container,
        em as EntityManager,
        input.targetUserId,
        scope,
      )
      if (!memberIsInOrganization) {
        return { status: 'invalid_member', reason: 'not_in_organization' } as GrantSharedInboxMemberResult
      }

      const existing = await em.findOne(SharedChannelMembership, {
        channelId: channel.id,
        userId: input.targetUserId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      })

      // The first membership freezes the owning organization: from here on the
      // channel has authorization history and rehoming it would silently move
      // that history to another organization.
      if (!channel.ownershipFrozenAt) channel.ownershipFrozenAt = new Date()

      if (existing && existing.isActive) {
        await em.flush()
        return { status: 'already_member', membershipId: existing.id } as GrantSharedInboxMemberResult
      }

      if (existing) {
        // Reactivate in place so the revoke/regrant history stays linear and the
        // recovery view can show what happened to a mistakenly revoked member.
        existing.isActive = true
        existing.revokedAt = null
        existing.revokedByUserId = null
        existing.grantedByUserId = actor.userId
        await em.flush()
        return { status: 'granted', membershipId: existing.id, reactivated: true } as GrantSharedInboxMemberResult
      }

      const membership = em.create(SharedChannelMembership, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        channelId: channel.id,
        userId: input.targetUserId,
        isActive: true,
        grantedByUserId: actor.userId,
      })
      await em.flush()
      return { status: 'granted', membershipId: membership.id, reactivated: false } as GrantSharedInboxMemberResult
    })

    if (outcome.status === 'granted') {
      await emitCommunicationChannelsEvent(
        'communication_channels.shared_inbox.member_granted',
        {
          channelId: input.channelId,
          membershipId: outcome.membershipId,
          memberUserId: input.targetUserId,
          grantedByUserId: actor.userId,
          reactivated: outcome.reactivated,
          tenantId: actor.tenantId,
          organizationId: actor.organizationId,
        },
        { persistent: true },
      )
    }

    return outcome
  },
}

const revokeSharedInboxMemberCommand: CommandHandler<
  RevokeSharedInboxMemberInput,
  RevokeSharedInboxMemberResult
> = {
  id: COMMUNICATION_CHANNELS_SHARED_INBOX_REVOKE_MEMBER_COMMAND_ID,
  isUndoable: false,
  async execute(rawInput, ctx) {
    const input = revokeMemberSchema.parse(rawInput)
    const { actor } = input
    if (!authorizeSharedInboxAdmin(actor)) return { status: 'forbidden' }

    const scope = { tenantId: actor.tenantId, organizationId: actor.organizationId }
    const rootEm = (ctx.container.resolve('em') as EntityManager).fork()

    const outcome = await rootEm.transactional(async (em) => {
      const channel = await lockChannel(em as EntityManager, input.channelId, scope)
      if (!channel) return { status: 'not_found' } as RevokeSharedInboxMemberResult

      const membership = await em.findOne(SharedChannelMembership, {
        channelId: channel.id,
        userId: input.targetUserId,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      })
      if (!membership) return { status: 'not_found' } as RevokeSharedInboxMemberResult
      if (!membership.isActive) {
        return { status: 'already_revoked', membershipId: membership.id } as RevokeSharedInboxMemberResult
      }

      // Last-manager protection. Under the channel lock taken above, two
      // concurrent revocations serialize, so the second one observes the first
      // one's effect and is rejected instead of leaving the inbox with no
      // member who can administer it.
      const remaining = await em.find(SharedChannelMembership, {
        channelId: channel.id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        isActive: true,
        id: { $ne: membership.id },
      })
      const revokedMemberIsManager = await holdsSharedInboxManage(
        ctx.container,
        membership.userId,
        scope,
      )
      if (revokedMemberIsManager) {
        let anotherManagerRemains = false
        for (const candidate of remaining) {
          if (await holdsSharedInboxManage(ctx.container, candidate.userId, scope)) {
            anotherManagerRemains = true
            break
          }
        }
        if (!anotherManagerRemains) return { status: 'last_manager' } as RevokeSharedInboxMemberResult
      }

      membership.isActive = false
      membership.revokedAt = new Date()
      membership.revokedByUserId = actor.userId
      await em.flush()
      return { status: 'revoked', membershipId: membership.id } as RevokeSharedInboxMemberResult
    })

    if (outcome.status === 'revoked') {
      await emitCommunicationChannelsEvent(
        'communication_channels.shared_inbox.member_revoked',
        {
          channelId: input.channelId,
          membershipId: outcome.membershipId,
          memberUserId: input.targetUserId,
          revokedByUserId: actor.userId,
          requiredFeature: SHARED_INBOX_MANAGE_FEATURE,
          tenantId: actor.tenantId,
          organizationId: actor.organizationId,
        },
        { persistent: true },
      )
    }

    return outcome
  },
}

registerCommand(grantSharedInboxMemberCommand)
registerCommand(revokeSharedInboxMemberCommand)

export { grantSharedInboxMemberCommand, revokeSharedInboxMemberCommand }

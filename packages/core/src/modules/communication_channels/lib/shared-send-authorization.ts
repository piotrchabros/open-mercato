import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { CommunicationChannel } from '../data/entities'
import {
  SHARED_INBOX_SEND_FEATURE,
  authorizeSharedInbox,
} from './shared-inbox-authorization'

const logger = createLogger('communication_channels').child({ component: 'shared-send-authorization' })

/**
 * Dispatch-time re-authorization for a shared-inbox send (Connect upstream
 * Contract A).
 *
 * Authorization at enqueue time is not enough: a queued send can sit for
 * minutes, and a membership revoked in the meantime must not still be able to
 * put mail in the world under the organization's address. This re-runs the
 * Contract E rule against CURRENT membership and CURRENT effective features,
 * immediately before the provider call.
 *
 * Fails CLOSED. If the actor's grants cannot be resolved we refuse the send
 * rather than assume the revocation did not happen — the cost of refusing is a
 * definitive, reconcilable `failed:authorization_revoked`, while the cost of
 * assuming is mail sent by someone no longer entitled to send it.
 */

type ContainerLike = { resolve: <T = unknown>(name: string) => T }

type RbacServiceLike = {
  loadAcl: (
    userId: string,
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<{ isSuperAdmin: boolean; features: string[]; organizations: string[] | null }>
}

export async function isSharedSendStillAuthorized(
  container: ContainerLike,
  em: EntityManager,
  channel: Pick<CommunicationChannel, 'id' | 'tenantId' | 'organizationId'>,
  actorUserId: string,
): Promise<boolean> {
  const organizationId = channel.organizationId
  // A shared inbox always has an owning organization (enforced by
  // `communication_channels_shared_inbox_scope_chk`); a row without one is
  // malformed and must not be sent from.
  if (!organizationId) return false

  let features: string[] = []
  try {
    const rbac = container.resolve<RbacServiceLike>('rbacService')
    const acl = await rbac.loadAcl(actorUserId, {
      tenantId: channel.tenantId,
      organizationId,
    })
    features = acl?.isSuperAdmin ? ['*'] : Array.isArray(acl?.features) ? acl.features : []
  } catch (err) {
    logger.warn('dispatch-time authorization probe failed; refusing the send', {
      channelId: channel.id,
      err,
    })
    return false
  }

  const decision = await authorizeSharedInbox(
    em,
    channel.id,
    {
      userId: actorUserId,
      tenantId: channel.tenantId,
      organizationId,
      features,
    },
    SHARED_INBOX_SEND_FEATURE,
    { requireTrafficEnabled: true },
  )
  return decision.ok
}

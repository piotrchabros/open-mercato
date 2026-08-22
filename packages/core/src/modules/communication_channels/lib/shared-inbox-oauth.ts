import { createHash } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { SharedInboxOAuthState } from '../data/entities'

/**
 * Server-side one-time state for the shared-mailbox OAuth flow (Connect
 * upstream Contract E, AUTH-UP-GMAIL-01).
 *
 * The encrypted state cookie still carries confidentiality and PKCE extras; the
 * row this module manages adds the two properties a cookie cannot give a flow
 * that binds a credential to an organization: provable single use, and a
 * server-held copy of the scope the callback must honor.
 */

/** Shared-inbox OAuth authorizations expire quickly — consent is interactive. */
export const SHARED_INBOX_OAUTH_STATE_TTL_MS = 10 * 60 * 1000

/**
 * Only the hash is persisted, so a database read (backup, replica, log) cannot
 * be replayed as a valid callback `state`.
 */
export function hashOAuthState(state: string): string {
  return createHash('sha256').update(state).digest('hex')
}

export type CreateSharedInboxOAuthStateArgs = {
  em: EntityManager
  state: string
  nonce: string
  tenantId: string
  organizationId: string
  initiatedByUserId: string
  providerKey: string
  displayName?: string | null
  returnUrl?: string | null
  now?: Date
}

export async function createSharedInboxOAuthState(
  args: CreateSharedInboxOAuthStateArgs,
): Promise<SharedInboxOAuthState> {
  const now = args.now ?? new Date()
  const row = args.em.create(SharedInboxOAuthState, {
    tenantId: args.tenantId,
    organizationId: args.organizationId,
    stateHash: hashOAuthState(args.state),
    nonce: args.nonce,
    initiatedByUserId: args.initiatedByUserId,
    providerKey: args.providerKey,
    displayName: args.displayName ?? null,
    returnUrl: args.returnUrl ?? null,
    expiresAt: new Date(now.getTime() + SHARED_INBOX_OAUTH_STATE_TTL_MS),
  })
  args.em.persist(row)
  await args.em.flush()
  return row
}

export type ConsumedSharedInboxOAuthState = {
  id: string
  tenantId: string
  organizationId: string
  nonce: string
  initiatedByUserId: string
  providerKey: string
  displayName: string | null
  returnUrl: string | null
}

export type ConsumeSharedInboxOAuthStateResult =
  | { status: 'consumed'; state: ConsumedSharedInboxOAuthState }
  | { status: 'not_found' }
  | { status: 'already_consumed' }
  | { status: 'expired' }

/**
 * Atomically claim a state row.
 *
 * The claim is ONE conditional UPDATE (`consumed_at is null and expires_at >
 * now`), so two concurrent callbacks — a double-submitted redirect, a browser
 * prefetch, a replayed URL — cannot both succeed: exactly one UPDATE returns a
 * row. The follow-up read only classifies WHY a claim failed and never grants
 * anything.
 */
export async function consumeSharedInboxOAuthState(
  em: EntityManager,
  state: string,
  now: Date = new Date(),
): Promise<ConsumeSharedInboxOAuthStateResult> {
  const stateHash = hashOAuthState(state)
  const claimed = (await em.execute(
    `update "communication_channel_shared_oauth_states"
        set "consumed_at" = ?
      where "state_hash" = ?
        and "consumed_at" is null
        and "expires_at" > ?
      returning "id", "tenant_id", "organization_id", "nonce", "initiated_by_user_id", "provider_key", "display_name", "return_url"`,
    [now, stateHash, now],
  )) as Array<{
    id: string
    tenant_id: string
    organization_id: string
    nonce: string
    initiated_by_user_id: string
    provider_key: string
    display_name: string | null
    return_url: string | null
  }>

  if (claimed.length === 1) {
    const row = claimed[0]
    return {
      status: 'consumed',
      state: {
        id: row.id,
        tenantId: row.tenant_id,
        organizationId: row.organization_id,
        nonce: row.nonce,
        initiatedByUserId: row.initiated_by_user_id,
        providerKey: row.provider_key,
        displayName: row.display_name,
        returnUrl: row.return_url,
      },
    }
  }

  const existing = await em.findOne(SharedInboxOAuthState, { stateHash })
  if (!existing) return { status: 'not_found' }
  if (existing.consumedAt) return { status: 'already_consumed' }
  return { status: 'expired' }
}

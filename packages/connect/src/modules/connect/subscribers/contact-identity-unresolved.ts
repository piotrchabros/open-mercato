import type { EntityManager } from '@mikro-orm/postgresql'
import { ConnectContactIdentity, ConnectManualMatchTask } from '../data/entities'

/**
 * Open a manual-match task for an unresolved identity.
 *
 * Idempotent in two directions, both of which matter:
 *
 *   - **Duplicate delivery** must not open a second task. The partial unique
 *     index on `(tenant, organization, identity) WHERE status = 'open'` is the
 *     arbiter; this handler simply defers to it.
 *   - **A stale event** — one delivered after the identity was already linked —
 *     must not reopen a resolved task. The handler re-reads the CURRENT identity
 *     rather than trusting the state the event described.
 */
export const metadata = {
  event: 'connect.contact_identity.unresolved',
  persistent: true,
  id: 'connect:contact-identity-unresolved',
}

type SubscriberContext = { resolve: <T = unknown>(name: string) => T }

type Payload = {
  identityId?: string
  tenantId?: string
  organizationId?: string
}

export default async function handler(payload: Payload, ctx: SubscriberContext): Promise<void> {
  if (
    typeof payload?.identityId !== 'string' ||
    typeof payload?.tenantId !== 'string' ||
    typeof payload?.organizationId !== 'string'
  ) {
    return
  }

  const em = (ctx.resolve('em') as EntityManager).fork()
  const identity = await em.findOne(ConnectContactIdentity, {
    id: payload.identityId,
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
  })
  if (!identity) return
  // Re-read rather than trust the event: the identity may have been linked
  // between emission and delivery, and reopening a task for it would send a
  // human to look at work that is already done.
  if (identity.linkState === 'linked') return

  const existing = await em.findOne(ConnectManualMatchTask, {
    tenantId: payload.tenantId,
    organizationId: payload.organizationId,
    identityId: identity.id,
    status: 'open',
  })
  if (existing) return

  em.persist(
    em.create(ConnectManualMatchTask, {
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      identityId: identity.id,
      status: 'open',
      sourceEventId: `unresolved:${identity.id}`,
    }),
  )
  try {
    await em.flush()
  } catch {
    // The partial unique index rejected a concurrent insert. Another delivery
    // opened the task, which is the outcome we wanted.
  }
}

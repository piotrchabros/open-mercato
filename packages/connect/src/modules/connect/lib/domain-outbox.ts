import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ConnectDomainOutboxEntry } from '../data/entities'

const logger = createLogger('connect').child({ component: 'domain-outbox' })

/**
 * Transactional outbox for Connect domain events.
 *
 * Emitting an event directly from a command has two failure modes that both
 * corrupt downstream state: emit-then-crash-before-commit announces something
 * that never happened, and commit-then-crash-before-emit loses an announcement
 * nobody will retry. Writing the event row in the SAME transaction as the
 * mutation removes both — after commit the event provably exists, and a
 * separate drain publishes it at least once.
 *
 * Every entry carries a caller-derived `sourceEventId` that is unique per
 * tenant, so a redelivered inbound cannot enqueue the same announcement twice.
 */

export const CONNECT_OUTBOX_QUEUE = 'connect.domain_outbox.publish'

/** How long a claimed batch stays leased before the sweeper may retake it. */
export const CONNECT_OUTBOX_LEASE_MS = 5 * 60 * 1000

export type EnqueueDomainEventInput = {
  tenantId: string
  organizationId: string
  /** Stable and caller-derived — this is what makes publication idempotent. */
  sourceEventId: string
  aggregateId: string
  aggregateVersion: number
  eventType: string
  /** Identifier-only. Never message content. */
  payload: Record<string, unknown>
}

/**
 * Stage an event inside the caller's transaction.
 *
 * Does NOT flush: the caller owns the transaction boundary, and flushing here
 * would let the event become durable before the mutation it describes.
 */
export function stageDomainEvent(em: EntityManager, input: EnqueueDomainEventInput): ConnectDomainOutboxEntry {
  const entry = em.create(ConnectDomainOutboxEntry, {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    sourceEventId: input.sourceEventId,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    eventType: input.eventType,
    payload: input.payload,
    status: 'pending',
  })
  em.persist(entry)
  return entry
}

export type ClaimedOutboxEntry = {
  id: string
  tenantId: string
  organizationId: string
  sourceEventId: string
  eventType: string
  payload: Record<string, unknown>
}

/**
 * Claim a bounded batch of pending entries.
 *
 * The claim is one conditional UPDATE with a lease, so two workers (a wake job
 * and the scheduled sweep, say) cannot publish the same entry concurrently. An
 * expired lease is reclaimable, which is what makes a worker crash recoverable
 * rather than permanently stranding a batch.
 */
export async function claimOutboxBatch(
  em: EntityManager,
  batchSize: number,
  now: Date = new Date(),
): Promise<ClaimedOutboxEntry[]> {
  const leaseExpiresAt = new Date(now.getTime() + CONNECT_OUTBOX_LEASE_MS)
  const rows = (await em.execute(
    `update "connect_domain_outbox"
        set "lease_expires_at" = ?, "attempts" = "attempts" + 1, "updated_at" = ?
      where "id" in (
        select "id" from "connect_domain_outbox"
         where "status" = 'pending'
           and ("lease_expires_at" is null or "lease_expires_at" < ?)
         order by "created_at" asc
         limit ?
         for update skip locked
      )
      returning "id", "tenant_id", "organization_id", "source_event_id", "event_type", "payload"`,
    [leaseExpiresAt, now, now, batchSize],
  )) as Array<{
    id: string
    tenant_id: string
    organization_id: string
    source_event_id: string
    event_type: string
    payload: Record<string, unknown>
  }>

  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    organizationId: row.organization_id,
    sourceEventId: row.source_event_id,
    eventType: row.event_type,
    payload: row.payload,
  }))
}

/**
 * Mark an entry published.
 *
 * Called AFTER a successful emit. A crash between emit and this call leaves the
 * entry pending and it is published again — at-least-once, which the stable
 * `sourceEventId` makes safe for subscribers to deduplicate.
 */
export async function markOutboxPublished(
  em: EntityManager,
  entryId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    await em.execute(
      `update "connect_domain_outbox"
          set "status" = 'published', "published_at" = ?, "lease_expires_at" = null, "updated_at" = ?
        where "id" = ? and "status" = 'pending'`,
      [now, now, entryId],
    )
  } catch (err) {
    logger.warn('could not mark a published outbox entry; it will be re-published', { entryId, err })
  }
}

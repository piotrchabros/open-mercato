import type { EntityManager } from '@mikro-orm/postgresql'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { ConnectInboundSuppression } from '../data/entities'

const logger = createLogger('connect').child({ component: 'inbound-rate-limiter' })

/**
 * Loop suppression, keyed by `(tenant, organization, channel, senderHandleHash)`.
 *
 * The composite key is the whole point. A tenant- or organization-wide bucket
 * would let one looping sender suppress every other customer's mail on the same
 * inbox — a far worse outcome than the loop it prevents. There is deliberately
 * no broader fallback: if the precise counter is unavailable we degrade
 * acknowledgement, never the key.
 *
 * The sender is identified by its blind-index hash; the raw handle never
 * reaches this table.
 */

export type SuppressionScope = {
  tenantId: string
  organizationId: string
  channelId: string
  fromHandleHash: string
}

export type SuppressionConfig = {
  /** Messages allowed from one sender within the window before suppressing. */
  count: number
  windowMinutes: number
}

export type SuppressionResult =
  | { status: 'allowed'; hitCount: number }
  | { status: 'suppressed'; hitCount: number }
  | { status: 'unavailable' }

/** Truncate to the start of the current fixed window, so counters are shared. */
export function windowStart(now: Date, windowMinutes: number): Date {
  const windowMs = Math.max(1, windowMinutes) * 60 * 1000
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs)
}

/**
 * Record one inbound message against the sender's counter.
 *
 * Idempotent by `externalMessageId`: a redelivered event re-reads the same
 * counter without advancing it, so a retry storm cannot suppress a legitimate
 * sender by counting the same message repeatedly.
 *
 * Returns `unavailable` rather than throwing when the counter cannot be read or
 * written. The caller then stores the message anyway and skips only the
 * automated acknowledgement — losing a real customer message to a counter
 * outage would be the wrong trade.
 */
export async function recordInboundHit(
  em: EntityManager,
  scope: SuppressionScope,
  config: SuppressionConfig,
  externalMessageId: string,
  now: Date = new Date(),
): Promise<SuppressionResult> {
  const startedAt = windowStart(now, config.windowMinutes)

  try {
    const rows = (await em.execute(
      `insert into "connect_inbound_suppressions"
         ("tenant_id", "organization_id", "channel_id", "from_handle_hash", "window_started_at",
          "hit_count", "last_external_message_id", "created_at", "updated_at")
       values (?, ?, ?, ?, ?, 1, ?, ?, ?)
       on conflict ("tenant_id", "organization_id", "channel_id", "from_handle_hash", "window_started_at")
       do update set
         -- Idempotent by external message id: a redelivered event does not
         -- advance the counter, it just re-reads it.
         "hit_count" = case
           when "connect_inbound_suppressions"."last_external_message_id" is distinct from excluded."last_external_message_id"
           then "connect_inbound_suppressions"."hit_count" + 1
           else "connect_inbound_suppressions"."hit_count"
         end,
         "last_external_message_id" = excluded."last_external_message_id",
         "updated_at" = excluded."updated_at"
       returning "hit_count"`,
      [
        scope.tenantId,
        scope.organizationId,
        scope.channelId,
        scope.fromHandleHash,
        startedAt,
        externalMessageId,
        now,
        now,
      ],
    )) as Array<{ hit_count: number }>

    const hitCount = rows[0]?.hit_count ?? 1
    return hitCount > config.count
      ? { status: 'suppressed', hitCount }
      : { status: 'allowed', hitCount }
  } catch (err) {
    // Never widen the key on failure; report unavailability and let the caller
    // decide (it stores the message and skips acknowledgement).
    logger.warn('suppression counter unavailable; not falling back to a broader bucket', {
      channelId: scope.channelId,
      err,
    })
    return { status: 'unavailable' }
  }
}

/** Read-only probe used by health reporting; never advances a counter. */
export async function readInboundHits(
  em: EntityManager,
  scope: SuppressionScope,
  config: SuppressionConfig,
  now: Date = new Date(),
): Promise<number | null> {
  try {
    const row = await em.findOne(ConnectInboundSuppression, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      channelId: scope.channelId,
      fromHandleHash: scope.fromHandleHash,
      windowStartedAt: windowStart(now, config.windowMinutes),
    })
    return row?.hitCount ?? 0
  } catch {
    return null
  }
}

/**
 * `MessageChannelLink.deliveryStatus` vocabulary.
 *
 * The column is free-form text for provider-specific states, but the hub's own
 * lifecycle uses these values. They are named here because shared-inbox
 * recovery (Contract E) has to reason about which of them may have crossed the
 * provider boundary.
 *
 * Lifecycle of an outbound link:
 *
 *   pending ──▶ dispatching ──▶ sent | queued        (provider accepted)
 *      │             │
 *      │             └────────▶ failed               (provider rejected)
 *      │             └────────▶ unknown              (disable/crash: unresolved)
 *      └──────────────────────▶ failed               (never dispatched)
 *
 * `unknown` is the only state that must never be auto-resent: the message may
 * already be in the recipient's mailbox. It is resolved by reconciliation, or
 * by an operator explicitly creating a new send.
 */

/** Created, not yet handed to the provider. Provably undispatched. */
export const OUTBOUND_DELIVERY_STATUS_PENDING = 'pending'

/**
 * Handed to the provider; the response has not been recorded yet. May or may
 * not have been delivered.
 */
export const OUTBOUND_DELIVERY_STATUS_DISPATCHING = 'dispatching'

/** Terminal: the provider rejected the send, or the hub abandoned it. */
export const OUTBOUND_DELIVERY_STATUS_FAILED = 'failed'

/**
 * Terminal-for-automation: the send may have crossed the provider boundary and
 * no evidence resolves it. Reconciliation-only — never retried automatically.
 */
export const OUTBOUND_DELIVERY_STATUS_UNKNOWN = 'unknown'

/** Statuses that prove the provider accepted the message. */
export const OUTBOUND_DELIVERED_STATUSES = ['queued', 'sent', 'delivered', 'read'] as const

/** Reason code stamped on links terminated by a shared-inbox disable. */
export const DELIVERY_REASON_CHANNEL_DISABLED = 'channel_disabled'

/**
 * Routing queue names.
 *
 * Held in one place so the worker's `metadata.queue`, the setup deferral and the
 * CLI cannot drift apart — a mismatch there produces a queue nobody drains,
 * which is indistinguishable from "the backfill silently did nothing".
 */
export const CONNECT_ROUTING_QUEUES = {
  /** Recomputes one organization's agent capacity from Connect Case ownership. */
  capacityReconcile: 'connect.routing_capacity.reconcile',
} as const

export type ConnectRoutingQueueName =
  (typeof CONNECT_ROUTING_QUEUES)[keyof typeof CONNECT_ROUTING_QUEUES]

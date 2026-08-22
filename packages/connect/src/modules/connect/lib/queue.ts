/**
 * Connect queue names.
 *
 * Kept in one module so the worker's `metadata.queue`, the after-commit wake
 * job, and the scheduler registration cannot drift apart — a mismatch there
 * produces a queue nobody drains, which looks exactly like "nothing happened".
 */
export const CONNECT_QUEUES = {
  /** Drains the transactional domain outbox. */
  domainOutbox: 'connect.domain_outbox.publish',
  /** Retries inbound receipts left `processing` by a crash or outage. */
  inboundReceipts: 'connect.inbound.receipts',
  /** Submits durable outbound rows to the hub send facade. */
  outboundDispatch: 'connect.outbound.dispatch',
  /** Re-checks attempts whose outcome is still unknown. */
  outboundReconcile: 'connect.outbound.reconcile',
  /** Closes resolved Cases after the configured quiet window. */
  caseAutoClose: 'connect.case.auto-close',
  /** Materializes staged Customer-timeline projections. */
  projectionDrain: 'connect.projection.drain',
  /** Converges unlink sagas after a lost acknowledgement or a crash. */
  projectionRecovery: 'connect.projection.recovery',
  /** Recomputes daily operational aggregates from immutable facts. */
  metricsAggregate: 'connect.metrics.aggregate',
} as const

export type ConnectQueueName = (typeof CONNECT_QUEUES)[keyof typeof CONNECT_QUEUES]

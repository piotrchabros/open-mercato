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
} as const

export type ConnectQueueName = (typeof CONNECT_QUEUES)[keyof typeof CONNECT_QUEUES]

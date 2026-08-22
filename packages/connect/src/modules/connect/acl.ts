/**
 * Connect access control.
 *
 * Foundation exposes only ingestion settings and dead-letter remediation. Case
 * reads, assignment and agent actions arrive with Inbox Operations and get their
 * own features — declaring them here before anything enforces them would create
 * grants that silently mean nothing.
 */
export const features = [
  {
    id: 'connect.settings.view',
    title: 'View Connect ingestion settings',
    module: 'connect',
  },
  {
    id: 'connect.settings.manage',
    title: 'Manage Connect ingestion settings',
    module: 'connect',
  },
  /**
   * Remediate dead-lettered inbound receipts (replay / acknowledge).
   *
   * Separate from `settings.manage` because it acts on real customer traffic: a
   * replay re-runs ingest for a message, and an acknowledgement records that a
   * human decided not to. Neither deletes evidence.
   */
  {
    id: 'connect.inbound.remediate',
    title: 'Replay or acknowledge dead-lettered inbound messages',
    module: 'connect',
  },
] as const

export default features

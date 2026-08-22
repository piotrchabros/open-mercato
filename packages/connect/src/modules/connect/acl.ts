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
  /**
   * The front-line agent grant. A handler sees UNASSIGNED Cases plus their own,
   * may claim an unassigned one, and may reply / resolve / reopen the Cases they
   * own. Without the unassigned half the Inbox would be empty for a new agent —
   * the failure the earlier design shipped.
   */
  {
    id: 'connect.inbox.handle',
    title: 'Handle Connect cases',
    module: 'connect',
  },
  /**
   * See every Case in the active organization, not just unassigned plus own.
   * Never crosses into a sibling organization: the Case's organization scope is
   * a predicate, not a filter this feature can widen.
   */
  {
    id: 'connect.cases.view.all',
    title: 'View all Connect cases in the organization',
    module: 'connect',
  },
  /**
   * Assign, transfer or unassign another agent's Case, and act on a Case the
   * caller does not own (with an audited reason). Separate from `handle`
   * because taking someone else's work is a supervisory act.
   */
  {
    id: 'connect.cases.assign',
    title: 'Assign Connect cases to other agents',
    module: 'connect',
  },
  /**
   * Close a Case. Separate from resolve: `closed` is terminal — a later inbound
   * opens a successor rather than reviving it — so closing decides that a
   * conversation is over, which is not a front-line judgement.
   */
  {
    id: 'connect.cases.manage',
    title: 'Close Connect cases',
    module: 'connect',
  },
  /**
   * See and acknowledge deliveries whose outcome could not be determined.
   * Read-only remediation: Phase 1 deliberately has no force-sent / force-failed
   * override, because asserting an outcome the provider never confirmed is how a
   * customer gets a duplicate or a silent drop.
   */
  {
    id: 'connect.inbox.recovery.view',
    title: 'View unknown-delivery recovery queue',
    module: 'connect',
  },
  {
    id: 'connect.inbox.recovery.acknowledge',
    title: 'Acknowledge unknown deliveries',
    module: 'connect',
  },
] as const

export default features

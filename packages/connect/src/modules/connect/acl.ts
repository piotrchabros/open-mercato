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
  /**
   * Customer matching. Split into five features because the acts genuinely
   * differ in what they can cost:
   *
   * - `.read` sees the queue and searches candidates — no customer data changes.
   * - `.link` associates an identity with a customer. A wrong link exposes
   *   another customer's conversations, so it is the front-line grant that
   *   creates the risk.
   * - `.unlink` takes that exposure back across two modules. It is the
   *   supervisory counterpart and is NOT granted with `.link`.
   * - `.recover` resumes a stuck unlink saga — an operational act on a
   *   half-committed cross-module workflow.
   * - `.audit` reads historical associations, including customers an identity
   *   is no longer linked to. Deliberately separate from `.read` so an ordinary
   *   agent cannot recover a cleared association from the audit trail.
   */
  {
    id: 'connect.customer_match.read',
    title: 'View the customer-matching queue and candidates',
    module: 'connect',
  },
  {
    id: 'connect.customer_match.link',
    title: 'Link a contact identity to a customer',
    module: 'connect',
  },
  {
    id: 'connect.customer_match.unlink',
    title: 'Unlink a contact identity and retract its timeline projections',
    module: 'connect',
  },
  {
    id: 'connect.customer_match.recover',
    title: 'Resume a stuck unlink saga',
    module: 'connect',
  },
  {
    id: 'connect.customer_match.audit',
    title: 'Read historical identity link audit (restricted)',
    module: 'connect',
  },

  /**
   * Operational metrics.
   *
   * Split from the Inbox features because the audience is different: metrics
   * are an operations surface, and an agent handling their own Cases has no
   * reason to read organization-wide volume, response percentiles or the
   * suppression safety criterion.
   *
   * `.manage` is separate again because a rebuild is a bounded but real cost —
   * it recomputes aggregates over a date range — and because it is the only
   * write on this surface.
   */
  /**
   * Case reparenting — splitting conversations out of a Case, and merging two
   * Cases into one.
   *
   * Four features rather than one, because the acts differ in what they can
   * cost:
   *
   * - `.reparent` performs a correction between Cases the caller can already
   *   see. It is supervisory, not front-line: a wrong merge shows one
   *   customer's conversation to the agent working another's.
   * - `.reparent.override` waives the same-customer safeguard. It exists so the
   *   safeguard can be a hard default rather than a warning, and it is granted
   *   only to admins — deliberately NOT to the managers who hold `.reparent`.
   * - `.reparent.undo` reverses a correction. Separate because undo is
   *   conditional and touches records that may have moved on since.
   * - `.reparent.audit` reads the full audit trail including the operator's
   *   free-text reason, which describes the mistake and therefore the customer.
   */
  {
    id: 'connect.cases.reparent',
    title: 'Split and merge Connect cases',
    module: 'connect',
  },
  {
    id: 'connect.cases.reparent.override',
    title: 'Merge Connect cases across a customer mismatch',
    module: 'connect',
  },
  {
    id: 'connect.cases.reparent.undo',
    title: 'Undo a Connect case split or merge',
    module: 'connect',
  },
  {
    id: 'connect.cases.reparent.audit',
    title: 'Read Connect case reparenting audit reasons (restricted)',
    module: 'connect',
  },

  {
    id: 'connect.metrics.view',
    title: 'View Connect operational metrics and exceptions',
    module: 'connect',
  },
  {
    id: 'connect.metrics.manage',
    title: 'Rebuild Connect metric aggregates',
    module: 'connect',
  },
] as const

export default features

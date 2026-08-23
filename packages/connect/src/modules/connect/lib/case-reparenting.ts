import { createHash } from 'node:crypto'
import type {
  ConnectCasePriority,
  ConnectCaseStatus,
  ConnectLineageInstruction,
  ConnectReparentOperation,
} from '../data/entities'

/**
 * Pure decision layer for Case reparenting.
 *
 * Everything here is a total function over plain values: no EntityManager, no
 * container, no clock. The command owns locking, persistence and events; this
 * file owns the questions that must have the same answer every time — is this
 * selection legal, is this pair of Cases mergeable, is this reversal still safe.
 *
 * Keeping them separable is what makes the matrix testable at all. The lifecycle
 * combinations that matter (closed source, already-merged target, unlinked
 * customer, a Conversation that moved again) are cheap to enumerate here and
 * prohibitively expensive to enumerate through a database.
 */

export const MAX_SPLIT_CONVERSATIONS = 100
export const MAX_REPARENT_REASON_LENGTH = 500
export const REPARENT_SNAPSHOT_VERSION = 1 as const
export const REPARENT_LINEAGE_VERSION = 1 as const

export const CONNECT_REPARENT_FEATURE = 'connect.cases.reparent'
export const CONNECT_REPARENT_OVERRIDE_FEATURE = 'connect.cases.reparent.override'
export const CONNECT_REPARENT_UNDO_FEATURE = 'connect.cases.reparent.undo'
export const CONNECT_REPARENT_AUDIT_FEATURE = 'connect.cases.reparent.audit'

export type ReparentCaseSnapshotV1 = {
  schemaVersion: typeof REPARENT_SNAPSHOT_VERSION
  id: string
  status: ConnectCaseStatus
  priority: ConnectCasePriority
  assigneeUserId: string | null
  channelId: string
  firstInboundAt: string | null
  lastInboundAt: string | null
  firstAssignedAt: string | null
  firstOutboundSentAt: string | null
  resolvedAt: string | null
  closedAt: string | null
  previousCaseId: string | null
  mergedIntoCaseId: string | null
  splitFromCaseId: string | null
  lineageVersion: number
  updatedAt: string
}

export type ReparentItemSnapshotV1 = {
  conversationId: string
  fromCaseId: string
  toCaseId: string
  beforeBindingId: string
  afterBindingId: string
  conversationUpdatedAtBefore: string
  conversationUpdatedAtAfter: string
  lastMessageAtAtExecution: string | null
}

export type ReparentUndoPayload = {
  schemaVersion: typeof REPARENT_SNAPSHOT_VERSION
  reparentingId: string
  operation: 'split' | 'merge'
  sourceBefore: ReparentCaseSnapshotV1
  destinationBefore: ReparentCaseSnapshotV1 | null
  sourcePostUpdatedAt: string
  destinationPostUpdatedAt: string
  itemCount: number
  payloadFingerprint: string
}

/** The Case fields the decision layer needs. Deliberately not the entity. */
export type ReparentCaseView = {
  id: string
  tenantId: string
  organizationId: string
  status: ConnectCaseStatus
  priority: ConnectCasePriority
  assigneeUserId: string | null
  channelId: string
  customerKind: 'person' | 'company' | null
  customerId: string | null
  firstInboundAt: Date | null
  lastInboundAt: Date | null
  firstAssignedAt: Date | null
  firstOutboundSentAt: Date | null
  resolvedAt: Date | null
  closedAt: Date | null
  previousCaseId: string | null
  mergedIntoCaseId: string | null
  splitFromCaseId: string | null
  lineageVersion: number
  updatedAt: Date
}

export type ReparentConversationView = {
  id: string
  currentCaseId: string | null
  lastMessageAt: Date | null
  updatedAt: Date
}

export function buildCaseSnapshot(view: ReparentCaseView): ReparentCaseSnapshotV1 {
  return {
    schemaVersion: REPARENT_SNAPSHOT_VERSION,
    id: view.id,
    status: view.status,
    priority: view.priority,
    assigneeUserId: view.assigneeUserId ?? null,
    channelId: view.channelId,
    firstInboundAt: isoOrNull(view.firstInboundAt),
    lastInboundAt: isoOrNull(view.lastInboundAt),
    firstAssignedAt: isoOrNull(view.firstAssignedAt),
    firstOutboundSentAt: isoOrNull(view.firstOutboundSentAt),
    resolvedAt: isoOrNull(view.resolvedAt),
    closedAt: isoOrNull(view.closedAt),
    previousCaseId: view.previousCaseId ?? null,
    mergedIntoCaseId: view.mergedIntoCaseId ?? null,
    splitFromCaseId: view.splitFromCaseId ?? null,
    lineageVersion: view.lineageVersion,
    updatedAt: view.updatedAt.toISOString(),
  }
}

function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

// ── Canonical fingerprint ─────────────────────────────────────

export type ReparentFingerprintInput =
  | {
      operation: 'split'
      tenantId: string
      organizationId: string
      sourceCaseId: string
      conversationIds: readonly string[]
      expectedSourceUpdatedAt: string
      reason: string
    }
  | {
      operation: 'merge'
      tenantId: string
      organizationId: string
      sourceCaseId: string
      targetCaseId: string
      expectedSourceUpdatedAt: string
      expectedTargetUpdatedAt: string
      reason: string
      allowCustomerMismatch: boolean
    }

/**
 * Stable hash of the request, computed from validated PLAINTEXT before anything
 * is persisted or encrypted.
 *
 * Key order is fixed by construction rather than by `JSON.stringify` over an
 * object literal, and conversation ids are sorted, so two requests that mean the
 * same thing hash the same regardless of how the client serialized them. Actor
 * and session metadata are excluded on purpose: the same correction retried from
 * a different tab is the same correction.
 */
export function computeReparentFingerprint(input: ReparentFingerprintInput): string {
  const canonical =
    input.operation === 'split'
      ? [
          ['allowCustomerMismatch', false],
          ['conversationIds', [...input.conversationIds].sort(compareIdentifiers)],
          ['expectedSourceUpdatedAt', normalizeInstant(input.expectedSourceUpdatedAt)],
          ['operation', 'split'],
          ['organizationId', input.organizationId],
          ['reason', normalizeReason(input.reason)],
          ['schemaVersion', REPARENT_SNAPSHOT_VERSION],
          ['sourceCaseId', input.sourceCaseId],
          ['tenantId', input.tenantId],
        ]
      : [
          ['allowCustomerMismatch', input.allowCustomerMismatch],
          ['expectedSourceUpdatedAt', normalizeInstant(input.expectedSourceUpdatedAt)],
          ['expectedTargetUpdatedAt', normalizeInstant(input.expectedTargetUpdatedAt)],
          ['operation', 'merge'],
          ['organizationId', input.organizationId],
          ['reason', normalizeReason(input.reason)],
          ['schemaVersion', REPARENT_SNAPSHOT_VERSION],
          ['sourceCaseId', input.sourceCaseId],
          ['targetCaseId', input.targetCaseId],
          ['tenantId', input.tenantId],
        ]
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

export function normalizeReason(reason: string): string {
  return reason.trim()
}

/**
 * Locale-independent codepoint ordering for identifiers.
 *
 * Deliberately NOT `localeCompare`: this ordering feeds the canonical
 * fingerprint and the deterministic lock sequence, so it must produce the same
 * answer on every machine. A locale-aware collation would make a request hash
 * differently — and two nodes acquire locks in different orders — depending on
 * the server's `LANG`.
 */
export function compareIdentifiers(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Compare optimistic tokens as instants, not as strings.
 *
 * A client that echoes back `...+00:00` instead of `...Z` means the same moment;
 * failing that with a conflict would train operators to retry blindly, which is
 * the opposite of what the token is for.
 */
export function normalizeInstant(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toISOString()
}

export function instantsMatch(expected: string, actual: Date): boolean {
  const parsed = new Date(expected)
  if (Number.isNaN(parsed.getTime())) return false
  return parsed.getTime() === actual.getTime()
}

// ── Invariants ────────────────────────────────────────────────

export type ReparentRejection =
  | { code: 'not_found' }
  | { code: 'invalid_selection'; reason: string }
  | { code: 'invalid_state'; reason: string }
  | { code: 'customer_mismatch'; reason: string }
  | { code: 'case_merged'; canonicalCaseId: string }

export type SplitPlan = {
  movedConversationIds: string[]
  childStatus: ConnectCaseStatus
  childChannelId: string
}

export type SplitValidationInput = {
  source: ReparentCaseView
  /** Every conversation currently active on the source, ordered `(createdAt, id)`. */
  activeConversations: readonly SplitConversationCandidate[]
  requestedConversationIds: readonly string[]
}

export type SplitConversationCandidate = {
  id: string
  channelId: string
  createdAt: Date
}

/**
 * Validate a split selection and derive the child's starting shape.
 *
 * Two rules carry the weight. A split must leave the source with at least one
 * active Conversation — an empty source is a merge wearing a different name, and
 * conflating them would let a supervisor silently retire a Case without the
 * merge path's target checks. And the child's channel comes from the EARLIEST
 * selected Conversation, not from the source Case: the source's originating
 * channel may have nothing to do with the conversations being split out, and a
 * Case whose `channelId` names a channel none of its conversations belong to is
 * an operational trap.
 */
export function validateSplit(input: SplitValidationInput): { ok: true; plan: SplitPlan } | { ok: false; rejection: ReparentRejection } {
  const source = input.source
  const merged = rejectMergedSource(source)
  if (merged) return { ok: false, rejection: merged }
  if (source.status === 'closed') {
    return { ok: false, rejection: { code: 'invalid_state', reason: 'source_closed' } }
  }

  const requested = [...input.requestedConversationIds]
  if (requested.length === 0) {
    return { ok: false, rejection: { code: 'invalid_selection', reason: 'empty_selection' } }
  }
  if (new Set(requested).size !== requested.length) {
    return { ok: false, rejection: { code: 'invalid_selection', reason: 'duplicate_conversation' } }
  }
  if (requested.length > MAX_SPLIT_CONVERSATIONS) {
    return { ok: false, rejection: { code: 'invalid_selection', reason: 'too_many_conversations' } }
  }

  const byId = new Map(input.activeConversations.map((row) => [row.id, row]))
  const selected: SplitConversationCandidate[] = []
  for (const id of requested) {
    const row = byId.get(id)
    // A conversation that is not active on this source is indistinguishable from
    // one that does not exist: both are 404, so a caller cannot probe for a
    // conversation belonging to someone else's Case.
    if (!row) return { ok: false, rejection: { code: 'not_found' } }
    selected.push(row)
  }
  if (selected.length >= input.activeConversations.length) {
    return { ok: false, rejection: { code: 'invalid_selection', reason: 'source_would_be_empty' } }
  }

  const earliest = [...selected].sort(compareByCreatedAtThenId)[0]!
  return {
    ok: true,
    plan: {
      movedConversationIds: selected.map((row) => row.id),
      // A child of a `new` source has not been worked either; a child of an
      // active Case inherits the fact that somebody is already on it.
      childStatus: source.status === 'new' ? 'new' : 'in_progress',
      childChannelId: earliest.channelId,
    },
  }
}

function compareByCreatedAtThenId(a: SplitConversationCandidate, b: SplitConversationCandidate): number {
  const delta = a.createdAt.getTime() - b.createdAt.getTime()
  if (delta !== 0) return delta
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export type MergeValidationInput = {
  source: ReparentCaseView
  target: ReparentCaseView
  allowCustomerMismatch: boolean
  /** Wildcard-resolved: does the caller hold the override feature. */
  hasOverrideFeature: boolean
}

export function validateMerge(
  input: MergeValidationInput,
): { ok: true } | { ok: false; rejection: ReparentRejection } {
  const { source, target } = input
  if (source.id === target.id) {
    return { ok: false, rejection: { code: 'invalid_selection', reason: 'same_case' } }
  }
  if (source.tenantId !== target.tenantId || source.organizationId !== target.organizationId) {
    return { ok: false, rejection: { code: 'not_found' } }
  }

  const mergedSource = rejectMergedSource(source)
  if (mergedSource) return { ok: false, rejection: mergedSource }
  if (source.status === 'closed') {
    return { ok: false, rejection: { code: 'invalid_state', reason: 'source_closed' } }
  }
  // A merged target is itself historical: merging into it would move live work
  // onto a Case that every read surface already treats as read-only.
  if (target.mergedIntoCaseId) {
    return { ok: false, rejection: { code: 'case_merged', canonicalCaseId: target.mergedIntoCaseId } }
  }
  if (target.status === 'closed') {
    return { ok: false, rejection: { code: 'invalid_state', reason: 'target_closed' } }
  }

  const customerCheck = validateCustomerAlignment(source, target)
  if (customerCheck !== 'aligned') {
    if (!input.allowCustomerMismatch) {
      return { ok: false, rejection: { code: 'customer_mismatch', reason: customerCheck } }
    }
    if (!input.hasOverrideFeature) {
      return { ok: false, rejection: { code: 'customer_mismatch', reason: 'override_required' } }
    }
  }
  return { ok: true }
}

export type CustomerAlignment = 'aligned' | 'different_customer' | 'unlinked_case'

/**
 * Two Cases may merge freely only when both name the SAME customer.
 *
 * An unlinked Case is not treated as compatible-with-anything. It is the state a
 * mis-matched identity lands in, so silently absorbing it into a linked Case is
 * exactly the mistake that exposes one customer's thread to another — it needs a
 * supervisor's override and an audited reason, not a default.
 */
export function validateCustomerAlignment(
  source: Pick<ReparentCaseView, 'customerKind' | 'customerId'>,
  target: Pick<ReparentCaseView, 'customerKind' | 'customerId'>,
): CustomerAlignment {
  const sourceLinked = source.customerId != null
  const targetLinked = target.customerId != null
  if (!sourceLinked || !targetLinked) return 'unlinked_case'
  if (source.customerId !== target.customerId) return 'different_customer'
  if (source.customerKind !== target.customerKind) return 'different_customer'
  return 'aligned'
}

function rejectMergedSource(source: ReparentCaseView): ReparentRejection | null {
  if (!source.mergedIntoCaseId) return null
  return { code: 'case_merged', canonicalCaseId: source.mergedIntoCaseId }
}

// ── Timestamp folding ─────────────────────────────────────────

/**
 * Fold the source's inbound range into the merge target.
 *
 * `lastInboundAt` takes the LATER value because the target now owns the source's
 * conversations and its triage position must reflect the newest traffic it is
 * responsible for. `firstInboundAt` takes the EARLIER value so the Case's own
 * history does not appear to start after messages it now contains.
 */
export function foldInboundRange(
  target: Pick<ReparentCaseView, 'firstInboundAt' | 'lastInboundAt'>,
  source: Pick<ReparentCaseView, 'firstInboundAt' | 'lastInboundAt'>,
): { firstInboundAt: Date | null; lastInboundAt: Date | null } {
  return {
    firstInboundAt: earliest(target.firstInboundAt, source.firstInboundAt),
    lastInboundAt: latest(target.lastInboundAt, source.lastInboundAt),
  }
}

export function earliest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b
  if (!b) return a
  return a.getTime() <= b.getTime() ? a : b
}

export function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b
  if (!b) return a
  return a.getTime() >= b.getTime() ? a : b
}

// ── Undo safety ───────────────────────────────────────────────

export type UndoItemFingerprint = {
  conversationId: string
  toCaseId: string
  afterConversationUpdatedAt: Date
  lastMessageAtAtExecution: Date | null
}

export type UndoSafetyInput = {
  reparenting: {
    status: 'completed' | 'reversed'
    sourcePostUpdatedAt: Date
    destinationPostUpdatedAt: Date
  }
  source: ReparentCaseView | null
  destination: ReparentCaseView | null
  items: readonly UndoItemFingerprint[]
  conversations: ReadonlyMap<string, ReparentConversationView>
}

export type UndoSafety =
  | { safe: true }
  | { safe: false; reason: UndoUnsafeReason }

export type UndoUnsafeReason =
  | 'already_reversed'
  | 'source_changed'
  | 'destination_changed'
  | 'case_missing'
  | 'conversation_missing'
  | 'conversation_moved'
  | 'conversation_changed'
  | 'later_activity'

/**
 * Decide whether a mechanical reversal is still the right thing to do.
 *
 * The whole point is to fail closed. Every check below asks "is the world still
 * exactly as this operation left it?" — if a Case was reassigned, a conversation
 * moved again, or a customer replied after the correction, then moving rows back
 * would be a decision about work nobody reviewed. A `409` telling the operator to
 * look is strictly safer than an undo that quietly discards a reply.
 */
export function evaluateUndoSafety(input: UndoSafetyInput): UndoSafety {
  if (input.reparenting.status !== 'completed') return { safe: false, reason: 'already_reversed' }
  if (!input.source || !input.destination) return { safe: false, reason: 'case_missing' }
  if (input.source.updatedAt.getTime() !== input.reparenting.sourcePostUpdatedAt.getTime()) {
    return { safe: false, reason: 'source_changed' }
  }
  if (input.destination.updatedAt.getTime() !== input.reparenting.destinationPostUpdatedAt.getTime()) {
    return { safe: false, reason: 'destination_changed' }
  }

  for (const item of input.items) {
    const conversation = input.conversations.get(item.conversationId)
    if (!conversation) return { safe: false, reason: 'conversation_missing' }
    if (conversation.currentCaseId !== item.toCaseId) return { safe: false, reason: 'conversation_moved' }
    if (conversation.updatedAt.getTime() !== item.afterConversationUpdatedAt.getTime()) {
      return { safe: false, reason: 'conversation_changed' }
    }
    if (!sameInstantOrBothNull(conversation.lastMessageAt, item.lastMessageAtAtExecution)) {
      return { safe: false, reason: 'later_activity' }
    }
  }
  return { safe: true }
}

function sameInstantOrBothNull(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b
  return a.getTime() === b.getTime()
}

// ── Lineage vocabulary ────────────────────────────────────────

export function lineageInstructionFor(operation: ConnectReparentOperation): ConnectLineageInstruction {
  if (operation === 'split') return 'child_of_source'
  if (operation === 'merge') return 'source_into_target'
  return 'inverse_of_reparenting'
}

export function inverseOperation(operation: 'split' | 'merge'): 'undo_split' | 'undo_merge' {
  return operation === 'split' ? 'undo_split' : 'undo_merge'
}

export function reparentEventType(operation: ConnectReparentOperation): string {
  if (operation === 'split') return 'connect.case.split'
  if (operation === 'merge') return 'connect.case.merged'
  return 'connect.case.reparenting_undone'
}

/**
 * Deterministic lock order.
 *
 * Two supervisors merging A→B and B→A at the same moment take the same two row
 * locks in opposite orders unless something forces an ordering. Sorting by id
 * turns a deadlock into a queue: the second operation waits, re-reads, and then
 * fails its optimistic check honestly.
 */
export function deterministicLockOrder(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort(compareIdentifiers)
}

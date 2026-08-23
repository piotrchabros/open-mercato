import { createHash } from 'node:crypto'
import { LockMode } from '@mikro-orm/core'
import type { EntityManager } from '@mikro-orm/postgresql'
import {
  registerCommand,
  type CommandHandler,
  type CommandRuntimeContext,
  type CommandUndoLogEntry,
} from '@open-mercato/shared/lib/commands'
import { extractUndoPayload } from '@open-mercato/shared/lib/commands/undo'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { authorizeFeatures } from '@open-mercato/shared/security/featurePolicy'
import {
  ConnectCase,
  ConnectCaseReparenting,
  ConnectCaseReparentingItem,
  ConnectCaseTransition,
  ConnectConversation,
  ConnectConversationCaseBinding,
  type ConnectReparentOperation,
} from '../data/entities'
import { reparentCaseInputSchema, type ReparentCaseInput } from '../data/validators'
import { evaluateCaseAccess, type CaseActor } from '../lib/case-access'
import { allocateConnectCaseNumber } from '../lib/case-number'
import { stageDomainEvent } from '../lib/domain-outbox'
import {
  CONNECT_REPARENT_OVERRIDE_FEATURE,
  CONNECT_REPARENT_UNDO_FEATURE,
  REPARENT_LINEAGE_VERSION,
  REPARENT_SNAPSHOT_VERSION,
  buildCaseSnapshot,
  computeReparentFingerprint,
  deterministicLockOrder,
  evaluateUndoSafety,
  foldInboundRange,
  instantsMatch,
  inverseOperation,
  lineageInstructionFor,
  normalizeReason,
  reparentEventType,
  validateMerge,
  validateSplit,
  type ReparentCaseSnapshotV1,
  type ReparentCaseView,
  type ReparentRejection,
  type ReparentUndoPayload,
} from '../lib/case-reparenting'

/**
 * Atomic Case reparenting: split, merge, and the conditional inverse of either.
 *
 * ONE registered command owns all of it. Splitting and merging differ only in
 * which Conversations move and what becomes of the source's lifecycle; they
 * share validation, lock ordering, interval bookkeeping, audit shape,
 * idempotency and undo semantics. Two commands would mean two copies of that,
 * and the copies would drift.
 *
 * The invariant everything else serves: once this commits, every moved
 * Conversation has exactly one closed interval and exactly one open one, both
 * Cases carry a bumped lineage version, an audit row records precisely enough to
 * reverse the operation, and the outbox holds an identifier-only announcement.
 * All in one transaction — a half-reparented Conversation is one nobody owns.
 *
 * Undo lives here too, as the handler's own `undo()`, reached through the
 * canonical audit-log undo endpoint. A second "undo reparenting" command would
 * be a second write path into the same aggregate with its own copy of the safety
 * checks, which is exactly how the checks come apart.
 */

export const CONNECT_REPARENT_CASE_COMMAND_ID = 'connect.case.reparent'
export const CONNECT_REPARENTING_RESOURCE_KIND = 'connect.case_reparenting'

export type ReparentCaseSuccess = {
  operation: 'split' | 'merge'
  reparentingId: string
  sourceCaseId: string
  destinationCaseId: string
  movedConversationIds: string[]
  sourceUpdatedAt: string
  destinationUpdatedAt: string
  /**
   * Carried on the result so `buildLog` can persist it without re-reading the
   * row it just wrote. API routes project their response explicitly and never
   * spread the result, so this stays server-side.
   */
  undoPayload: ReparentUndoPayload
}

export type ReparentCaseResult =
  | ({ status: 'reparented'; idempotentReplay: false } & ReparentCaseSuccess)
  | ({ status: 'idempotent_replay'; idempotentReplay: true } & ReparentCaseSuccess)
  | { status: 'not_found' }
  | { status: 'forbidden'; reason: 'override_required' }
  | { status: 'invalid_state'; reason: string }
  | { status: 'invalid_selection'; reason: string }
  | { status: 'customer_mismatch'; reason: string }
  | { status: 'case_merged'; canonicalCaseId: string }
  | { status: 'conflict'; caseId: string; currentUpdatedAt: string }
  | { status: 'command_key_conflict' }

type Scope = { tenantId: string; organizationId: string }

function toCaseView(row: ConnectCase): ReparentCaseView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    status: row.status,
    priority: row.priority,
    assigneeUserId: row.assigneeUserId ?? null,
    channelId: row.channelId,
    customerKind: row.customerKind ?? null,
    customerId: row.customerId ?? null,
    firstInboundAt: row.firstInboundAt ?? null,
    lastInboundAt: row.lastInboundAt ?? null,
    firstAssignedAt: row.firstAssignedAt ?? null,
    firstOutboundSentAt: row.firstOutboundSentAt ?? null,
    resolvedAt: row.resolvedAt ?? null,
    closedAt: row.closedAt ?? null,
    previousCaseId: row.previousCaseId ?? null,
    mergedIntoCaseId: row.mergedIntoCaseId ?? null,
    splitFromCaseId: row.splitFromCaseId ?? null,
    lineageVersion: row.lineageVersion,
    updatedAt: row.updatedAt,
  }
}

function rejectionToResult(rejection: ReparentRejection): ReparentCaseResult {
  switch (rejection.code) {
    case 'not_found':
      return { status: 'not_found' }
    case 'invalid_selection':
      return { status: 'invalid_selection', reason: rejection.reason }
    case 'invalid_state':
      return { status: 'invalid_state', reason: rejection.reason }
    case 'case_merged':
      return { status: 'case_merged', canonicalCaseId: rejection.canonicalCaseId }
    case 'customer_mismatch':
      return rejection.reason === 'override_required'
        ? { status: 'forbidden', reason: 'override_required' }
        : { status: 'customer_mismatch', reason: rejection.reason }
  }
}

// ── Locking ───────────────────────────────────────────────────

/**
 * Lock Cases in lexicographic id order.
 *
 * Not an optimization — a correctness requirement. Two supervisors merging A→B
 * and B→A concurrently would otherwise take the same pair of row locks in
 * opposite orders and deadlock. Sorting turns that into a queue: the second
 * operation waits, re-reads, and fails its optimistic check honestly.
 */
async function lockCasesInOrder(
  em: EntityManager,
  scope: Scope,
  caseIds: readonly string[],
): Promise<Map<string, ConnectCase>> {
  const found = new Map<string, ConnectCase>()
  for (const caseId of deterministicLockOrder(caseIds)) {
    const row = await em.findOne(
      ConnectCase,
      { id: caseId, tenantId: scope.tenantId, organizationId: scope.organizationId, deletedAt: null },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (row) found.set(caseId, row)
  }
  return found
}

type LockedConversation = {
  conversation: ConnectConversation
  binding: ConnectConversationCaseBinding
}

/**
 * Lock each Conversation and its open interval, in the same deterministic order.
 *
 * The Conversation row is the lock inbound ingest also takes, which is what
 * serializes a reparenting against a message arriving on a Conversation it is
 * moving. Without it a message could attach to the Case a Conversation is being
 * moved out of, at the same instant.
 *
 * A row-at-a-time loop rather than one `$in` query: `SELECT ... FOR UPDATE` with
 * a plan the database chooses gives no ordering guarantee, and the whole point
 * here is the order.
 */
async function lockConversationsInOrder(
  em: EntityManager,
  scope: Scope,
  conversationIds: readonly string[],
): Promise<Map<string, LockedConversation> | null> {
  const locked = new Map<string, LockedConversation>()
  for (const conversationId of deterministicLockOrder(conversationIds)) {
    const conversation = await em.findOne(
      ConnectConversation,
      { id: conversationId, tenantId: scope.tenantId, organizationId: scope.organizationId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!conversation) return null
    const binding = await em.findOne(
      ConnectConversationCaseBinding,
      {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        conversationId,
        unboundAt: null,
      },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    // A Conversation with no open interval belongs to no Case. That is a broken
    // invariant, not something this command may guess its way past.
    if (!binding) return null
    locked.set(conversationId, { conversation, binding })
  }
  return locked
}

// ── Interval movement ─────────────────────────────────────────

type ClosedInterval = {
  conversation: ConnectConversation
  beforeBinding: ConnectConversationCaseBinding
  fromCaseId: string
  toCaseId: string
  beforeConversationUpdatedAt: Date
  lastMessageAtAtExecution: Date | null
}

type PendingMove = ClosedInterval & {
  afterBinding: ConnectConversationCaseBinding
}

/**
 * Close a Conversation's open interval and repoint it at its new Case.
 *
 * Only the closing half. The replacement is opened separately, by
 * {@link openReplacementIntervals}, because the two halves must reach the
 * database in that order — see the note there.
 */
function closeConversationInterval(
  locked: LockedConversation,
  toCaseId: string,
  now: Date,
): ClosedInterval {
  const { conversation, binding } = locked
  const closed: ClosedInterval = {
    conversation,
    beforeBinding: binding,
    fromCaseId: binding.caseId,
    toCaseId,
    beforeConversationUpdatedAt: conversation.updatedAt,
    lastMessageAtAtExecution: conversation.lastMessageAt ?? null,
  }
  binding.unboundAt = now
  conversation.currentCaseId = toCaseId
  return closed
}

/**
 * Open the replacement intervals, after the old ones are closed IN THE DATABASE.
 *
 * The flush is load-bearing, not tidiness. `connect_conversation_case_bindings`
 * carries a partial unique index over `(tenant, organization, conversation)
 * WHERE unbound_at IS NULL`, and Postgres checks a unique index per statement
 * rather than at commit. The unit of work is free to order its INSERTs before
 * its UPDATEs, and when it does, the new interval lands while the old one is
 * still open and the whole reparenting dies on a constraint violation.
 *
 * Flushing the closes first makes the ordering explicit instead of leaving it to
 * the ORM. Both halves still commit together — this is one transaction — so a
 * failure between them strands nothing.
 */
async function openReplacementIntervals(
  em: EntityManager,
  scope: Scope,
  closed: readonly ClosedInterval[],
  reason: string,
  now: Date,
): Promise<PendingMove[]> {
  await em.flush()
  return closed.map((entry) => {
    const afterBinding = em.create(ConnectConversationCaseBinding, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      conversationId: entry.conversation.id,
      caseId: entry.toCaseId,
      boundAt: now,
      reason,
    })
    em.persist(afterBinding)
    return { ...entry, afterBinding }
  })
}

/**
 * Point an identity binding at the merge target when it still names the source.
 *
 * Only for merge, and only when it currently equals the source. A partial split
 * must NOT touch it: the identity binding selects a Case for a brand-new
 * Conversation, so rewriting it after moving some conversations would silently
 * redirect every future conversation for that person. Correctness does not
 * depend on this update — the Conversation-first ingest rule already keeps moved
 * conversations with their destination — it only keeps the next NEW conversation
 * from landing on a Case that is now historical.
 */
async function repointIdentityBindings(
  em: EntityManager,
  scope: Scope,
  fromCaseId: string,
  toCaseId: string,
): Promise<void> {
  await em.execute(
    `update "connect_identity_case_bindings"
        set "current_case_id" = ?, "version" = "version" + 1, "updated_at" = now()
      where "tenant_id" = ? and "organization_id" = ? and "current_case_id" = ?`,
    [toCaseId, scope.tenantId, scope.organizationId, fromCaseId],
  )
}

// ── Audit + event ─────────────────────────────────────────────

function buildEventPayload(args: {
  scope: Scope
  reparentingId: string
  reversesReparentingId: string | null
  operation: ConnectReparentOperation
  sourceCaseId: string
  destinationCaseId: string
  movedConversationCount: number
  occurredAt: Date
  sourceUpdatedAt: Date
  destinationUpdatedAt: Date
}): Record<string, unknown> {
  return {
    tenantId: args.scope.tenantId,
    organizationId: args.scope.organizationId,
    // The reparenting row's id doubles as the source event id, so a consumer
    // deduplicating the event and one reconciling through the read facade agree
    // on what "the same operation" means.
    sourceEventId: args.reparentingId,
    reparentingId: args.reparentingId,
    reversesReparentingId: args.reversesReparentingId,
    operation: args.operation,
    sourceCaseId: args.sourceCaseId,
    destinationCaseId: args.destinationCaseId,
    // A count, not an inventory. A large merge would otherwise put an unbounded
    // id array into persistent event storage and every subscriber's memory.
    movedConversationCount: args.movedConversationCount,
    occurredAt: args.occurredAt.toISOString(),
    sourceUpdatedAt: args.sourceUpdatedAt.toISOString(),
    destinationUpdatedAt: args.destinationUpdatedAt.toISOString(),
    lineageInstruction: lineageInstructionFor(args.operation),
    lineageVersion: REPARENT_LINEAGE_VERSION,
  }
}

/**
 * Write the audit parent, its normalized items and the outbox entry.
 *
 * Ordering is dictated by database-generated ids: the parent must be flushed
 * before items can name it, and the moved conversations must be flushed before
 * their replacement bindings have ids to record. Both flushes stay inside the
 * caller's transaction, so a failure at any point rolls the whole operation back
 * — including the event, which must never describe a state that was undone.
 */
async function finalizeReparenting(args: {
  em: EntityManager
  scope: Scope
  actorUserId: string
  operation: 'split' | 'merge'
  source: ConnectCase
  destination: ConnectCase
  sourceBefore: ReparentCaseSnapshotV1
  destinationBefore: ReparentCaseSnapshotV1 | null
  moves: readonly PendingMove[]
  clientCommandKey: string
  fingerprint: string
  reason: string
  reversesReparentingId: string | null
  now: Date
}): Promise<ReparentCaseSuccess> {
  const { em, scope, source, destination, now } = args

  // Flush the Case and Conversation mutations first: the replacement bindings
  // need their ids, and both Cases need their post-operation `updated_at`.
  await em.flush()

  const reparenting = em.create(ConnectCaseReparenting, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    operation: args.operation,
    sourceCaseId: source.id,
    destinationCaseId: destination.id,
    clientCommandKey: args.clientCommandKey,
    payloadFingerprint: args.fingerprint,
    actorUserId: args.actorUserId,
    reason: args.reason,
    sourceBefore: args.sourceBefore as unknown as Record<string, unknown>,
    destinationBefore: (args.destinationBefore ?? null) as unknown as Record<string, unknown> | null,
    sourcePostUpdatedAt: source.updatedAt,
    destinationPostUpdatedAt: destination.updatedAt,
    reversesReparentingId: args.reversesReparentingId,
    status: 'completed',
    occurredAt: now,
  })
  em.persist(reparenting)
  await em.flush()

  for (const move of args.moves) {
    em.persist(
      em.create(ConnectCaseReparentingItem, {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        reparentingId: reparenting.id,
        conversationId: move.conversation.id,
        fromCaseId: move.fromCaseId,
        toCaseId: move.toCaseId,
        beforeBindingId: move.beforeBinding.id,
        afterBindingId: move.afterBinding.id,
        beforeConversationUpdatedAt: move.beforeConversationUpdatedAt,
        afterConversationUpdatedAt: move.conversation.updatedAt,
        lastMessageAtAtExecution: move.lastMessageAtAtExecution,
      }),
    )
  }

  stageDomainEvent(em, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    sourceEventId: reparenting.id,
    aggregateId: destination.id,
    aggregateVersion: destination.lineageVersion,
    eventType: reparentEventType(args.operation),
    payload: buildEventPayload({
      scope,
      reparentingId: reparenting.id,
      reversesReparentingId: args.reversesReparentingId,
      operation: args.operation,
      sourceCaseId: source.id,
      destinationCaseId: destination.id,
      movedConversationCount: args.moves.length,
      occurredAt: now,
      sourceUpdatedAt: source.updatedAt,
      destinationUpdatedAt: destination.updatedAt,
    }),
  })
  await em.flush()

  return {
    operation: args.operation,
    reparentingId: reparenting.id,
    sourceCaseId: source.id,
    destinationCaseId: destination.id,
    movedConversationIds: args.moves.map((move) => move.conversation.id).sort(),
    sourceUpdatedAt: source.updatedAt.toISOString(),
    destinationUpdatedAt: destination.updatedAt.toISOString(),
    undoPayload: {
      schemaVersion: REPARENT_SNAPSHOT_VERSION,
      reparentingId: reparenting.id,
      operation: args.operation,
      sourceBefore: args.sourceBefore,
      destinationBefore: args.destinationBefore,
      sourcePostUpdatedAt: source.updatedAt.toISOString(),
      destinationPostUpdatedAt: destination.updatedAt.toISOString(),
      itemCount: args.moves.length,
      payloadFingerprint: args.fingerprint,
    },
  }
}

// ── Execute ───────────────────────────────────────────────────

async function replayResult(
  em: EntityManager,
  scope: Scope,
  existing: ConnectCaseReparenting,
): Promise<ReparentCaseResult> {
  // A key recorded against an inverse row cannot be replayed as a split or
  // merge; treating it as one would return a success shape for an operation the
  // caller never asked for.
  if (existing.operation !== 'split' && existing.operation !== 'merge') {
    return { status: 'command_key_conflict' }
  }
  const items = await em.find(ConnectCaseReparentingItem, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    reparentingId: existing.id,
  })
  return {
    status: 'idempotent_replay',
    idempotentReplay: true,
    operation: existing.operation,
    reparentingId: existing.id,
    sourceCaseId: existing.sourceCaseId,
    destinationCaseId: existing.destinationCaseId,
    movedConversationIds: items.map((item) => item.conversationId).sort(),
    sourceUpdatedAt: existing.sourcePostUpdatedAt.toISOString(),
    destinationUpdatedAt: existing.destinationPostUpdatedAt.toISOString(),
    undoPayload: {
      schemaVersion: REPARENT_SNAPSHOT_VERSION,
      reparentingId: existing.id,
      operation: existing.operation,
      sourceBefore: existing.sourceBefore as unknown as ReparentCaseSnapshotV1,
      destinationBefore: (existing.destinationBefore ?? null) as unknown as ReparentCaseSnapshotV1 | null,
      sourcePostUpdatedAt: existing.sourcePostUpdatedAt.toISOString(),
      destinationPostUpdatedAt: existing.destinationPostUpdatedAt.toISOString(),
      itemCount: items.length,
      payloadFingerprint: existing.payloadFingerprint,
    },
  }
}

async function executeSplit(args: {
  em: EntityManager
  scope: Scope
  actor: CaseActor
  source: ConnectCase
  sourceBefore: ReparentCaseSnapshotV1
  conversationIds: readonly string[]
  clientCommandKey: string
  fingerprint: string
  reason: string
  now: Date
}): Promise<ReparentCaseResult> {
  const { em, scope, source, now } = args

  const activeBindings = await em.find(ConnectConversationCaseBinding, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    caseId: source.id,
    unboundAt: null,
  })
  const activeConversationIds = activeBindings.map((binding) => binding.conversationId)
  const activeConversations = activeConversationIds.length
    ? await em.find(ConnectConversation, {
        id: { $in: activeConversationIds },
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        currentCaseId: source.id,
      })
    : []

  const validation = validateSplit({
    source: toCaseView(source),
    activeConversations: activeConversations.map((row) => ({
      id: row.id,
      channelId: row.channelId,
      createdAt: row.createdAt,
    })),
    requestedConversationIds: args.conversationIds,
  })
  if (!validation.ok) return rejectionToResult(validation.rejection)
  const plan = validation.plan

  const locked = await lockConversationsInOrder(em, scope, plan.movedConversationIds)
  if (!locked) return { status: 'not_found' }

  // Re-read under the lock. A Conversation that moved between validation and the
  // lock is no longer the one that was validated, so the caller's view of the
  // Case is stale even though its `updated_at` may not have changed.
  for (const conversationId of plan.movedConversationIds) {
    const entry = locked.get(conversationId)
    if (!entry || entry.conversation.currentCaseId !== source.id) {
      return { status: 'conflict', caseId: source.id, currentUpdatedAt: source.updatedAt.toISOString() }
    }
  }

  // From the locked sequence, not `max(number) + 1`: a split and an inbound open
  // racing must not claim the same human-facing number.
  const number = await allocateConnectCaseNumber(em, scope)

  const child = em.create(ConnectCase, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    number,
    // Subject and wrap-up are NOT copied. They describe the source's
    // conversation as a whole; asserting them for a subset would be a claim
    // nobody made. The masked display label is safe and keeps lists readable.
    subject: null,
    displayLabel: source.displayLabel ?? null,
    status: plan.childStatus,
    priority: source.priority,
    customerKind: source.customerKind ?? null,
    customerId: source.customerId ?? null,
    channelId: plan.childChannelId,
    // Inherited from the source, because Phase 1 stores no per-Conversation
    // inbound range. The transition below records that provenance, so nobody
    // later mistakes an inherited timestamp for a measured one.
    firstInboundAt: source.firstInboundAt ?? null,
    lastInboundAt: source.lastInboundAt ?? null,
    splitFromCaseId: source.id,
    lineageVersion: 1,
  })
  em.persist(child)
  // The id is database-generated, so nothing may reference the child until this
  // flush assigns it.
  await em.flush()

  const closed = plan.movedConversationIds.map((conversationId) =>
    closeConversationInterval(locked.get(conversationId)!, child.id, now),
  )

  em.persist(
    em.create(ConnectCaseTransition, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      caseId: child.id,
      actorKind: 'user',
      actorUserId: args.actor.userId,
      fromStatus: null,
      toStatus: plan.childStatus,
      payload: {
        trigger: 'split',
        splitFromCaseId: source.id,
        inboundRangeProvenance: 'source_case_snapshot',
      },
    }),
  )

  // The source's status, assignee and timings are deliberately untouched: a
  // split corrects grouping, it does not restart the source's work.
  source.lineageVersion += 1

  const moves = await openReplacementIntervals(em, scope, closed, 'split', now)

  const success = await finalizeReparenting({
    em,
    scope,
    actorUserId: args.actor.userId,
    operation: 'split',
    source,
    destination: child,
    sourceBefore: args.sourceBefore,
    destinationBefore: null,
    moves,
    clientCommandKey: args.clientCommandKey,
    fingerprint: args.fingerprint,
    reason: args.reason,
    reversesReparentingId: null,
    now,
  })
  return { status: 'reparented', idempotentReplay: false, ...success }
}

async function executeMerge(args: {
  em: EntityManager
  scope: Scope
  actor: CaseActor
  source: ConnectCase
  target: ConnectCase
  sourceBefore: ReparentCaseSnapshotV1
  allowCustomerMismatch: boolean
  hasOverrideFeature: boolean
  clientCommandKey: string
  fingerprint: string
  reason: string
  now: Date
}): Promise<ReparentCaseResult> {
  const { em, scope, source, target, now } = args

  const validation = validateMerge({
    source: toCaseView(source),
    target: toCaseView(target),
    allowCustomerMismatch: args.allowCustomerMismatch,
    hasOverrideFeature: args.hasOverrideFeature,
  })
  if (!validation.ok) return rejectionToResult(validation.rejection)

  const targetBefore = buildCaseSnapshot(toCaseView(target))

  const activeBindings = await em.find(ConnectConversationCaseBinding, {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    caseId: source.id,
    unboundAt: null,
  })
  const conversationIds = activeBindings.map((binding) => binding.conversationId)

  const locked = conversationIds.length
    ? await lockConversationsInOrder(em, scope, conversationIds)
    : new Map<string, LockedConversation>()
  if (!locked) return { status: 'not_found' }

  for (const conversationId of conversationIds) {
    const entry = locked.get(conversationId)
    if (!entry || entry.conversation.currentCaseId !== source.id) {
      return { status: 'conflict', caseId: source.id, currentUpdatedAt: source.updatedAt.toISOString() }
    }
  }

  const closed = conversationIds.map((conversationId) =>
    closeConversationInterval(locked.get(conversationId)!, target.id, now),
  )

  // The target keeps its status, deadlines, ownership and first-response facts.
  // Only the inbound range folds, so the target's triage position reflects the
  // traffic it is now responsible for.
  const folded = foldInboundRange(toCaseView(target), toCaseView(source))
  target.firstInboundAt = folded.firstInboundAt
  target.lastInboundAt = folded.lastInboundAt
  target.lineageVersion += 1

  // The source becomes historical rather than deleted: its transitions,
  // wrap-up, ownership and audit trail are the evidence of what was done for
  // the customer, and a merge is a correction, not a retraction.
  const sourcePreviousStatus = source.status
  source.status = 'closed'
  source.closedAt = now
  source.mergedIntoCaseId = target.id
  source.lineageVersion += 1

  em.persist(
    em.create(ConnectCaseTransition, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      caseId: source.id,
      actorKind: 'user',
      actorUserId: args.actor.userId,
      fromStatus: sourcePreviousStatus,
      toStatus: 'closed',
      payload: { trigger: 'merge', mergedIntoCaseId: target.id },
    }),
  )

  await repointIdentityBindings(em, scope, source.id, target.id)

  const moves = await openReplacementIntervals(em, scope, closed, 'merge', now)

  const success = await finalizeReparenting({
    em,
    scope,
    actorUserId: args.actor.userId,
    operation: 'merge',
    source,
    destination: target,
    sourceBefore: args.sourceBefore,
    destinationBefore: targetBefore,
    moves,
    clientCommandKey: args.clientCommandKey,
    fingerprint: args.fingerprint,
    reason: args.reason,
    reversesReparentingId: null,
    now,
  })
  return { status: 'reparented', idempotentReplay: false, ...success }
}

async function executeReparent(
  rawInput: ReparentCaseInput,
  ctx: CommandRuntimeContext,
): Promise<ReparentCaseResult> {
  const input = reparentCaseInputSchema.parse(rawInput)
  const scope: Scope = { tenantId: input.actor.tenantId, organizationId: input.actor.organizationId }
  const actor: CaseActor = input.actor
  const grantedFeatures = [...input.actor.features]
  const reason = normalizeReason(input.reason)
  const now = new Date()

  const fingerprint =
    input.operation === 'split'
      ? computeReparentFingerprint({
          operation: 'split',
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          sourceCaseId: input.sourceCaseId,
          conversationIds: input.conversationIds,
          expectedSourceUpdatedAt: input.expectedSourceUpdatedAt,
          reason,
        })
      : computeReparentFingerprint({
          operation: 'merge',
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          sourceCaseId: input.sourceCaseId,
          targetCaseId: input.targetCaseId,
          expectedSourceUpdatedAt: input.expectedSourceUpdatedAt,
          expectedTargetUpdatedAt: input.expectedTargetUpdatedAt,
          reason,
          allowCustomerMismatch: input.allowCustomerMismatch,
        })

  const rootEm = (ctx.container.resolve('em') as EntityManager).fork()

  return rootEm.transactional(async (tem) => {
    const em = tem as EntityManager

    // (1) Idempotency, before any lock. A lost response retried with the same
    // key must resolve to the original operation rather than perform a second
    // one. A DIFFERENT payload under the same key is a client bug, and quietly
    // returning the first result for it would hide a real mistake.
    const existing = await em.findOne(ConnectCaseReparenting, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      clientCommandKey: input.clientCommandKey,
    })
    if (existing) {
      if (existing.payloadFingerprint !== fingerprint) return { status: 'command_key_conflict' }
      return replayResult(em, scope, existing)
    }

    // (2) Cases, locked in deterministic order.
    const wantedCaseIds =
      input.operation === 'merge' ? [input.sourceCaseId, input.targetCaseId] : [input.sourceCaseId]
    const cases = await lockCasesInOrder(em, scope, wantedCaseIds)
    const source = cases.get(input.sourceCaseId)
    if (!source) return { status: 'not_found' }

    // Visibility is evaluated on the Case as it is NOW, under the lock. A Case
    // the caller may not read is a 404, identical to one that does not exist.
    if (!evaluateCaseAccess(source, actor).canRead) return { status: 'not_found' }

    if (!instantsMatch(input.expectedSourceUpdatedAt, source.updatedAt)) {
      return { status: 'conflict', caseId: source.id, currentUpdatedAt: source.updatedAt.toISOString() }
    }

    const sourceBefore = buildCaseSnapshot(toCaseView(source))

    if (input.operation === 'split') {
      return executeSplit({
        em,
        scope,
        actor,
        source,
        sourceBefore,
        conversationIds: input.conversationIds,
        clientCommandKey: input.clientCommandKey,
        fingerprint,
        reason,
        now,
      })
    }

    const target = cases.get(input.targetCaseId)
    if (!target) return { status: 'not_found' }
    if (!evaluateCaseAccess(target, actor).canRead) return { status: 'not_found' }
    if (!instantsMatch(input.expectedTargetUpdatedAt, target.updatedAt)) {
      return { status: 'conflict', caseId: target.id, currentUpdatedAt: target.updatedAt.toISOString() }
    }

    return executeMerge({
      em,
      scope,
      actor,
      source,
      target,
      sourceBefore,
      allowCustomerMismatch: input.allowCustomerMismatch,
      hasOverrideFeature: authorizeFeatures([CONNECT_REPARENT_OVERRIDE_FEATURE], { grantedFeatures }),
      clientCommandKey: input.clientCommandKey,
      fingerprint,
      reason,
      now,
    })
  })
}

// ── Undo ──────────────────────────────────────────────────────

/** Distinct from the original's hash, so the two rows are never confusable. */
function undoFingerprint(originalFingerprint: string): string {
  return createHash('sha256').update(`undo:${originalFingerprint}`).digest('hex')
}

function unsafeUndo(reason: string): CrudHttpError {
  return new CrudHttpError(409, {
    error: 'record_conflict',
    code: 'unsafe_undo',
    details: { reason },
  })
}

/**
 * Restore a Case's lifecycle fields from its pre-operation snapshot.
 *
 * Only the fields this command is allowed to have changed. Restoring the whole
 * row would clobber anything else that legitimately moved — and the undo-safety
 * check has already proven nothing did, which is exactly why a narrow restore is
 * both sufficient and honest about its scope.
 */
function restoreCaseFromSnapshot(target: ConnectCase, snapshot: ReparentCaseSnapshotV1): void {
  target.status = snapshot.status
  target.firstInboundAt = snapshot.firstInboundAt ? new Date(snapshot.firstInboundAt) : null
  target.lastInboundAt = snapshot.lastInboundAt ? new Date(snapshot.lastInboundAt) : null
  target.resolvedAt = snapshot.resolvedAt ? new Date(snapshot.resolvedAt) : null
  target.closedAt = snapshot.closedAt ? new Date(snapshot.closedAt) : null
  target.mergedIntoCaseId = snapshot.mergedIntoCaseId
  target.lineageVersion += 1
}

async function undoReparent(params: {
  ctx: CommandRuntimeContext
  logEntry: CommandUndoLogEntry
}): Promise<void> {
  const { ctx, logEntry } = params
  const payload = extractUndoPayload<ReparentUndoPayload>(logEntry)
  // Fail closed. An absent or malformed undo payload means this handler cannot
  // prove what the operation did, and guessing would move customer conversations
  // on the strength of a corrupt log row.
  if (!payload || payload.schemaVersion !== REPARENT_SNAPSHOT_VERSION || !payload.reparentingId) {
    throw unsafeUndo('undo_payload_unavailable')
  }

  const auth = ctx.auth
  const tenantId = (auth?.tenantId as string | null | undefined) ?? null
  const organizationId =
    ctx.selectedOrganizationId ?? ((auth?.orgId as string | null | undefined) ?? null)
  const actorUserId = (auth?.sub as string | undefined) ?? null
  if (!tenantId || !organizationId || !actorUserId) throw unsafeUndo('scope_unavailable')
  const scope: Scope = { tenantId, organizationId }

  // The generic audit-log undo grants (`audit_logs.undo_*`) are already checked
  // by the endpoint. They say the caller may undo THEIR OWN action; they do not
  // say the caller may reparent Connect Cases. Intersecting the domain feature
  // here is what stops an operator with a broad undo grant from reversing a
  // supervisor's correction.
  const grantedFeatures = await resolveActorFeatures(ctx, actorUserId, scope)
  if (!authorizeFeatures([CONNECT_REPARENT_UNDO_FEATURE], { grantedFeatures })) {
    throw new CrudHttpError(403, { error: 'feature_required', code: 'feature_required' })
  }
  const actor: CaseActor = { userId: actorUserId, tenantId, organizationId, features: grantedFeatures }

  const rootEm = (ctx.container.resolve('em') as EntityManager).fork()
  await rootEm.transactional(async (tem) => {
    const em = tem as EntityManager
    const now = new Date()

    const reparenting = await em.findOne(
      ConnectCaseReparenting,
      { id: payload.reparentingId, tenantId, organizationId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    )
    if (!reparenting) throw unsafeUndo('reparenting_missing')
    if (reparenting.operation !== 'split' && reparenting.operation !== 'merge') {
      throw unsafeUndo('not_reversible')
    }
    if (reparenting.payloadFingerprint !== payload.payloadFingerprint) {
      throw unsafeUndo('fingerprint_mismatch')
    }

    const items = await em.find(
      ConnectCaseReparentingItem,
      { tenantId, organizationId, reparentingId: reparenting.id },
      { orderBy: { conversationId: 'asc' } },
    )
    if (items.length !== payload.itemCount) throw unsafeUndo('item_count_mismatch')

    const cases = await lockCasesInOrder(em, scope, [
      reparenting.sourceCaseId,
      reparenting.destinationCaseId,
    ])
    const source = cases.get(reparenting.sourceCaseId) ?? null
    const destination = cases.get(reparenting.destinationCaseId) ?? null
    // Normal Case visibility still applies. A caller who cannot see the Cases
    // cannot reverse an operation on them, whatever their undo grant says.
    if (!source || !destination) throw unsafeUndo('case_missing')
    if (!evaluateCaseAccess(source, actor).canRead || !evaluateCaseAccess(destination, actor).canRead) {
      throw unsafeUndo('case_missing')
    }

    const locked = items.length
      ? await lockConversationsInOrder(em, scope, items.map((item) => item.conversationId))
      : new Map<string, LockedConversation>()
    if (!locked) throw unsafeUndo('conversation_missing')

    const safety = evaluateUndoSafety({
      reparenting: {
        status: reparenting.status,
        sourcePostUpdatedAt: reparenting.sourcePostUpdatedAt,
        destinationPostUpdatedAt: reparenting.destinationPostUpdatedAt,
      },
      source: toCaseView(source),
      destination: toCaseView(destination),
      items: items.map((item) => ({
        conversationId: item.conversationId,
        toCaseId: item.toCaseId,
        afterConversationUpdatedAt: item.afterConversationUpdatedAt,
        lastMessageAtAtExecution: item.lastMessageAtAtExecution ?? null,
      })),
      conversations: new Map(
        [...locked.entries()].map(([id, entry]) => [
          id,
          {
            id,
            currentCaseId: entry.conversation.currentCaseId ?? null,
            lastMessageAt: entry.conversation.lastMessageAt ?? null,
            updatedAt: entry.conversation.updatedAt,
          },
        ]),
      ),
    })
    if (!safety.safe) throw unsafeUndo(safety.reason)

    const operation = reparenting.operation

    // The inverse row's own "before" is the state as it is right now, not the
    // original's before-snapshot. Reusing the original's would make the audit
    // trail claim the inverse started from a state it did not.
    const inverseSourceBefore = buildCaseSnapshot(toCaseView(destination))
    const inverseDestinationBefore = buildCaseSnapshot(toCaseView(source))

    // Read before mutating. A split child may be retired only when nothing else
    // ever attached to it — soft-deleting a Case that acquired its own
    // conversation would hide real work behind an "undo" — and asking that
    // question after staging the moves would answer it against a half-written
    // unit of work.
    const childHasOtherBindings =
      operation === 'split'
        ? (await em.count(ConnectConversationCaseBinding, {
            tenantId,
            organizationId,
            caseId: destination.id,
            conversationId: { $nin: items.map((item) => item.conversationId) },
          })) > 0
        : false

    const closed = items.map((item) =>
      closeConversationInterval(locked.get(item.conversationId)!, item.fromCaseId, now),
    )

    const sourceBefore = reparenting.sourceBefore as unknown as ReparentCaseSnapshotV1
    restoreCaseFromSnapshot(source, sourceBefore)

    if (operation === 'merge') {
      const destinationBefore = reparenting.destinationBefore as unknown as ReparentCaseSnapshotV1 | null
      if (!destinationBefore) throw unsafeUndo('destination_snapshot_missing')
      // The target keeps everything it owned before the merge; only the folded
      // inbound range is put back, because that is all the merge changed.
      destination.firstInboundAt = destinationBefore.firstInboundAt
        ? new Date(destinationBefore.firstInboundAt)
        : null
      destination.lastInboundAt = destinationBefore.lastInboundAt
        ? new Date(destinationBefore.lastInboundAt)
        : null
      destination.lineageVersion += 1
      await repointIdentityBindings(em, scope, destination.id, source.id)
      em.persist(
        em.create(ConnectCaseTransition, {
          tenantId,
          organizationId,
          caseId: source.id,
          actorKind: 'user',
          actorUserId,
          fromStatus: 'closed',
          toStatus: sourceBefore.status,
          payload: { trigger: 'undo_merge', reparentingId: reparenting.id },
        }),
      )
    } else {
      destination.lineageVersion += 1
      if (!childHasOtherBindings) {
        destination.deletedAt = now
        destination.status = 'closed'
        destination.closedAt = now
      }
    }

    reparenting.status = 'reversed'

    const inverse = inverseOperation(operation)
    const moves = await openReplacementIntervals(em, scope, closed, `undo_${operation}`, now)
    await em.flush()

    const inverseRow = em.create(ConnectCaseReparenting, {
      tenantId,
      organizationId,
      operation: inverse,
      // The inverse moves work back the other way, so its source is the Case the
      // original called its destination.
      sourceCaseId: reparenting.destinationCaseId,
      destinationCaseId: reparenting.sourceCaseId,
      // Derived from the original, so the inverse is idempotent under the same
      // unique key and can never be mistaken for a fresh request that happened
      // to hash the same way.
      clientCommandKey: `undo:${reparenting.id}`,
      payloadFingerprint: undoFingerprint(reparenting.payloadFingerprint),
      actorUserId,
      // The original supervisor's reason, carried forward. The undo endpoint
      // takes no new reason, and inventing one would put words in an operator's
      // mouth on an audit row.
      reason: reparenting.reason,
      sourceBefore: inverseSourceBefore as unknown as Record<string, unknown>,
      destinationBefore: inverseDestinationBefore as unknown as Record<string, unknown>,
      sourcePostUpdatedAt: destination.updatedAt,
      destinationPostUpdatedAt: source.updatedAt,
      reversesReparentingId: reparenting.id,
      status: 'completed',
      occurredAt: now,
    })
    em.persist(inverseRow)
    await em.flush()

    for (const move of moves) {
      em.persist(
        em.create(ConnectCaseReparentingItem, {
          tenantId,
          organizationId,
          reparentingId: inverseRow.id,
          conversationId: move.conversation.id,
          fromCaseId: move.fromCaseId,
          toCaseId: move.toCaseId,
          beforeBindingId: move.beforeBinding.id,
          afterBindingId: move.afterBinding.id,
          beforeConversationUpdatedAt: move.beforeConversationUpdatedAt,
          afterConversationUpdatedAt: move.conversation.updatedAt,
          lastMessageAtAtExecution: move.lastMessageAtAtExecution,
        }),
      )
    }

    stageDomainEvent(em, {
      tenantId,
      organizationId,
      sourceEventId: inverseRow.id,
      aggregateId: source.id,
      aggregateVersion: source.lineageVersion,
      eventType: reparentEventType(inverse),
      payload: buildEventPayload({
        scope,
        reparentingId: inverseRow.id,
        reversesReparentingId: reparenting.id,
        operation: inverse,
        sourceCaseId: reparenting.destinationCaseId,
        destinationCaseId: reparenting.sourceCaseId,
        movedConversationCount: moves.length,
        occurredAt: now,
        sourceUpdatedAt: destination.updatedAt,
        destinationUpdatedAt: source.updatedAt,
      }),
    })
    await em.flush()
  })
}

type RbacServiceLike = {
  loadAcl: (
    userId: string,
    scope: { tenantId: string | null; organizationId: string | null },
  ) => Promise<{ isSuperAdmin: boolean; features: string[]; organizations: string[] | null }>
}

/**
 * Resolve the caller's effective features server-side.
 *
 * The undo endpoint hands this handler an auth context, not a feature list, so
 * the domain grant has to be looked up here. A failure to resolve resolves to no
 * features — an undo that cannot prove authorization must not proceed.
 */
async function resolveActorFeatures(
  ctx: CommandRuntimeContext,
  userId: string,
  scope: Scope,
): Promise<string[]> {
  try {
    const rbac = ctx.container.resolve('rbacService') as RbacServiceLike
    const acl = await rbac.loadAcl(userId, {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    })
    if (acl?.isSuperAdmin) return ['*']
    return Array.isArray(acl?.features) ? acl.features : []
  } catch {
    return []
  }
}

export const reparentCaseCommand: CommandHandler<ReparentCaseInput, ReparentCaseResult> = {
  id: CONNECT_REPARENT_CASE_COMMAND_ID,
  isUndoable: true,
  execute: executeReparent,

  buildLog: ({ input, result }) => {
    // Nothing happened, so nothing is undoable. Logging a rejected attempt with
    // an undo token would hand the operator a button that reverses somebody
    // else's operation.
    if (result.status !== 'reparented') return { skipLog: true }
    return {
      actionLabel:
        result.operation === 'split' ? 'Split Connect case' : 'Merge Connect cases',
      resourceKind: CONNECT_REPARENTING_RESOURCE_KIND,
      resourceId: result.reparentingId,
      tenantId: input.actor.tenantId,
      organizationId: input.actor.organizationId,
      actorUserId: input.actor.userId,
      // Bounded snapshots and a count. The item ARRAY is deliberately not
      // embedded: a merge can move an unbounded number of conversations, and
      // `undo()` reads them back by `reparentingId` instead.
      payload: { undo: result.undoPayload },
      context: {
        operation: result.operation,
        sourceCaseId: result.sourceCaseId,
        destinationCaseId: result.destinationCaseId,
        movedConversationCount: result.movedConversationIds.length,
      },
    }
  },

  undo: undoReparent,

  /**
   * Redo is not supported, and says so instead of pretending.
   *
   * Replaying a reparenting after an undo is not the same act as the original:
   * the world has moved on, and the operator who reviewed the first decision
   * reviewed a different situation. A fresh, explicitly reviewed split or merge
   * is the supported path.
   */
  redo: () => {
    throw new CrudHttpError(409, {
      error: 'record_conflict',
      code: 'reparent_redo_unsupported',
    })
  },
}

registerCommand(reparentCaseCommand)

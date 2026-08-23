# Mercato Connect — Case Reparenting Contract

| Field | Value |
|---|---|
| **Date** | 2026-08-22 |
| **Status** | Implemented — 2026-08-23 (pending deployment evidence) |
| **Scope** | OSS |
| **Owner** | `connect` |
| **Depends on** | Phase 1 Connect Case aggregate |
| **Consumers** | Soft-optional modules such as `connect_sla` |

## TLDR

**Key points:**

- Add one Connect-owned, atomic reparenting capability for splitting selected Conversations into a new Case, merging a source Case into a target Case, and undoing either operation while the affected records have not subsequently changed.
- Preserve Case and Conversation history through append-only binding intervals and reparenting audit rows. Never rewrite historical transitions or delete a merged source Case.
- Publish identifier-only, transactional events with explicit lineage semantics so optional consumers such as `connect_sla` can interpret a reparenting without querying Connect tables.

**Scope:**

- Additive Case lineage columns and a `connect_case_reparentings` audit entity.
- Split, merge, and guarded undo commands plus action APIs.
- Frozen reparenting event and DI read-facade contracts for optional consumers; consumer-owned clock mutation remains in the SLA spec.
- Tenancy, optimistic/pessimistic concurrency, audit, recovery, and integration coverage.

**Out of scope:**

- Identity linking/unlinking, customer-record merging, message-body movement, physical deletion, cross-organization moves, SLA policy or clock persistence, and UI beyond returning API capabilities for a later Inbox action surface.

**Concerns:**

- A wrong merge can expose one customer's conversation to another operator. Every reference is therefore organization-scoped, every mutation locks both Cases and all active bindings, and cross-scope records are indistinguishable from missing records.
- Undo is deliberately conditional. It must fail with `409` once later traffic or Case mutations make a mechanical reversal unsafe.

## Overview

Phase 1 Connect stores a Case as the unit of ownership and lifecycle, a Conversation as the durable link to an upstream channel conversation, and append-only `ConnectConversationCaseBinding` intervals describing which Case owned a Conversation at a point in time. It does not yet expose a supported way to correct a Case that groups unrelated Conversations or to consolidate two duplicate Cases.

This specification introduces that correction boundary inside `connect`, the only module that owns the affected aggregates. It does not let a consumer mutate Connect rows and does not couple Connect to SLA. Instead, Connect publishes sufficient, identifier-only lineage facts and exposes a scoped read facade. An optional consumer owns its subscriber and degrades cleanly when absent.

> **Market reference:** Zammad and similar open-source service desks preserve ticket merge history and redirect operators to the surviving ticket. We adopt the durable-source/surviving-target model and visible lineage. We reject destructive source deletion and unrestricted reversal because both erase audit evidence and can silently discard traffic received after the operation.

## Problem Statement

Connect currently has three unsupported failure modes:

1. Two unrelated Conversations may be associated with one Case after a mistaken customer match. There is no atomic split operation that creates a safe child Case and moves only selected active bindings.
2. Duplicate Cases for the same customer may remain separate. There is no merge operation that selects one canonical target while preserving the source Case and its history.
3. Downstream state such as SLA clocks cannot infer whether a new Case is truly new work, inherited work, or a terminal merged source. Inferring this from mutable rows would reset clocks, erase breaches, or double-count work.

Direct table updates are not acceptable. They would bypass access checks, transition audit, optimistic locking, binding interval history, transactional events, and undo constraints.

## Proposed Solution

Add a single Case reparenting aggregate and one canonical registered command:

- `connect.case.reparent` executes either `split` or `merge` in one database transaction. Its `CommandHandler.undo()` appends an inverse audit row and restores prior state only if every recorded version and active binding still matches.

Both commands use pessimistic row locks for serialization and require optimistic tokens from the UI/API. Conversation content remains in its upstream owner; Connect moves only its own active `ConnectConversation.currentCaseId` pointer and closes/opens its append-only binding intervals.

### Design Decisions

| Decision | Rationale |
|---|---|
| Connect owns the contract | Connect owns Cases and bindings; a peer mutating them would violate module isolation. |
| One command family for split and merge | They share validation, locking, audit, binding movement, mutation guards, and undo semantics. |
| Keep the merged source as `closed` | Avoids adding a new Case status to a frozen public enum while preserving the source record and terminal behavior. `mergedIntoCaseId` distinguishes a merge from an ordinary close. |
| Split creates a new Case | A split is new ownership of selected Conversations, but it inherits lineage and timing rather than pretending the work arrived at split time. |
| Events carry lineage instructions, not consumer state | Connect knows what moved but neither imports nor requires `connect_sla` or another consumer. |
| Undo is append-only and conditional | Later inbound/outbound work makes automatic reversal ambiguous. A conflict is safer than overwriting later work. |
| No physical cross-module foreign keys | Case and Conversation identifiers stay scalar UUIDs; existing module isolation is preserved. |

### Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Update `current_case_id` directly | Loses history and bypasses guards, events, audit, and concurrency control. |
| Delete the merged source | Destroys lifecycle/audit evidence and breaks old links. |
| Add a `merged` Case status | Expands the frozen status contract and every status consumer when an additive lineage field expresses the distinction. |
| Let SLA own split/merge | Reverses dependency direction and makes a core Case correction unavailable without SLA. |
| Always permit undo | Could discard inbound traffic or actions recorded after reparenting. |

## Requirements

### Functional requirements

- **REP-FR-001** A split MUST move one or more, but not all, active Conversations from a source Case into one newly created child Case.
- **REP-FR-002** A merge MUST move every active Conversation from one source Case into one existing target Case in the same tenant and organization.
- **REP-FR-003** A merge source MUST remain readable as a closed historical Case with `merged_into_case_id` set; it MUST NOT be deleted.
- **REP-FR-004** A split child MUST carry `split_from_case_id`, a new Case number, the source customer/channel/priority snapshot, and inherited timing semantics.
- **REP-FR-005** Every moved Conversation MUST close exactly one active binding interval and open exactly one replacement interval in the same transaction.
- **REP-FR-006** Split, merge, and undo MUST append a `connect_case_reparenting` audit row containing the actor, reason, affected identifiers, before versions, and resulting versions.
- **REP-FR-007** The registered command's sole `undo()` handler MUST restore the exact recorded active bindings and Case lifecycle snapshot only when no affected Case or Conversation has changed since the operation; otherwise it MUST return `409` without mutation. No second domain undo command or route is allowed.
- **REP-FR-008** The command MUST be idempotent by `(tenant_id, organization_id, client_command_key)` and return the original result on a byte-equivalent retry. Reuse with a different payload MUST return `409`.
- **REP-FR-009** Every mutation MUST publish its event through the existing Connect transactional domain outbox.
- **REP-FR-010** Optional consumers MUST receive explicit lineage instructions: `child_of_source` for split, `source_into_target` for merge, and `inverse_of_reparenting` for undo. This spec does not prescribe consumer-owned clock writes.
- **REP-FR-011** Cross-tenant, cross-organization, unreadable, or unknown Case/Conversation references MUST return `404`, never `403`.
- **REP-FR-012** The source and target MUST resolve to the same linked customer when both carry a customer. An unlinked source or target, or a mismatch, requires the supervisory override flag and an audit reason.
- **REP-FR-013** A closed or already-merged Case cannot be a split source or merge source. A merged source cannot be a merge target. A normal closed Case cannot be a target.
- **REP-FR-014** A split source MUST retain at least one active Conversation; empty-source split is rejected. Merge is the explicit operation for moving all Conversations.
- **REP-FR-015** No message row, upstream channel row, customer row, identity row, or SLA row may be written by these commands.

### Non-functional requirements

- **REP-NFR-001** A reparent operation is atomic across Cases, Conversation pointers, binding intervals, transitions, audit, and outbox entries.
- **REP-NFR-002** Lock acquisition order is deterministic by UUID to prevent split/merge deadlocks.
- **REP-NFR-003** API lists cap `pageSize` at 100; the audit list uses keyset pagination by `(created_at, id)`.
- **REP-NFR-004** Event payloads contain identifiers, enum tokens, versions, and timestamps only—no subject, message body, handle, wrap-up, or customer display data.
- **REP-NFR-005** The implementation adds no production dependency and no cache correctness dependency.

## User Stories / Use Cases

- A supervisor wants to split unrelated Conversations from a Case so that each customer interaction is isolated without losing history.
- A supervisor wants to merge duplicate Cases so that agents continue in one canonical Case while old links retain an audit trail.
- A supervisor wants to undo a mistaken correction immediately, provided no later work makes reversal unsafe.
- An optional SLA module wants deterministic lineage instructions so it never resets a response deadline or erases a merged source's outcome.

## Architecture

### Aggregate and transaction flow

```text
POST action route
  -> auth + feature metadata
  -> mutation guards (operation: update)
  -> connect.case.reparent command
       -> validate zod input
       -> begin transaction
       -> lock Cases in UUID order
       -> verify optimistic versions and access
       -> lock active Conversations/bindings in UUID order
       -> validate invariant set
       -> close old binding intervals
       -> update Conversation.currentCaseId
       -> open replacement binding intervals
       -> update Case lineage/lifecycle
       -> append Case transitions + reparenting audit
       -> stage identifier-only domain event
       -> commit
  -> run guard after-success callbacks
  -> return versions and undo capability
```

### Module isolation

- `connect` owns all writes and the `connectCaseReparentingReader` DI facade.
- Optional consumers register persistent subscribers for Connect events and `tryResolve('connectCaseReparentingReader')` only for reconciliation. They never import Connect entity classes or query Connect tables.
- Connect never resolves or imports a clock consumer. Absence of `connect_sla` changes no split/merge result.
- The read facade accepts a mandatory `{ tenantId, organizationId }` scope and returns plain projections only.
- Disabled-module behavior is covered by the module-decoupling suite.

### Authoritative inbound and reparent serialization

The existing ingest path is changed additively so a reparent remains stable when the next message arrives on a moved Conversation:

1. After resolving the envelope and identity, ingest begins its Case-decision transaction and locks an existing `ConnectConversation` by scoped `externalConversationId` with `PESSIMISTIC_WRITE`.
2. It then locks `ConnectIdentityCaseBinding`, preserving the current per-identity serialization for new Conversations.
3. When the locked Conversation has a live `currentCaseId`, that Case is the first attach candidate. A valid Conversation-specific binding wins over the identity binding. This is the supported correction override created by split/merge.
4. When no Conversation exists yet, or its Case is closed/merged/deleted, the existing identity/customer attach rule decides the Case.
5. The Conversation pointer and interval binding are updated inside the same transaction as the Case decision. The current post-transaction `upsertConversation()` split is removed; receipt completion and the outbox fact remain atomic with the decision.

Reparent locks Cases first in UUID order and then Conversations in UUID order. Ingest locks only its Conversation and identity binding before loading the Case; it never takes a Case write lock while holding them. Reparent never takes an identity-binding lock. This avoids a Case→Conversation / Conversation→Case deadlock while giving both paths the common Conversation lock. `ConnectIdentityCaseBinding.currentCaseId` continues to select a Case only for a new Conversation and is not rewritten by a partial split; rewriting it would incorrectly move every Conversation for that identity. Merge may update an identity binding from source to target only when it currently equals the source, but correctness does not depend on that optimization.

Reply already checks `ConnectConversation.currentCaseId === case.id` in `enqueue-outbound.ts`; the same Conversation lock prevents reply from racing reparenting into the former Case. Transition/assign commands lock the Case and therefore serialize with reparent's initial Case locks.

### Atomic Case-number allocation

Add `ConnectCaseNumberSequence(tenantId, organizationId, nextNumber, createdAt, updatedAt)` with a unique `(tenant_id, organization_id)` constraint. `allocateConnectCaseNumber(em, scope)` performs a parameterized upsert of the scope row, locks it `FOR UPDATE`, returns `next_number`, and increments it in the caller's transaction. Both inbound `openCase()` and split child creation MUST use this helper; `max(number)+1` is removed. Migration seeds each scope with `max(connect_cases.number)+1` using `INSERT ... SELECT ... ON CONFLICT DO UPDATE` whose update keeps the greater value, making reruns safe while traffic continues. The unique Case-number constraint remains the final invariant.

### Commands

#### `connect.case.reparent`

Input discriminated union:

```typescript
type ReparentCaseInput =
  | {
      operation: 'split'
      sourceCaseId: string
      conversationIds: string[]
      expectedSourceUpdatedAt: string
      clientCommandKey: string
      reason: string
      actor: ScopedCaseActor
    }
  | {
      operation: 'merge'
      sourceCaseId: string
      targetCaseId: string
      expectedSourceUpdatedAt: string
      expectedTargetUpdatedAt: string
      clientCommandKey: string
      reason: string
      allowCustomerMismatch?: boolean
      actor: ScopedCaseActor
    }
```

The zod schema requires UUIDs, non-empty trimmed reason (maximum 500 characters), a command key of 1–128 safe characters, unique Conversation IDs, and at most 100 Conversations per split request. `allowCustomerMismatch` exists only on merge and is accepted only for a caller with `connect.cases.reparent.override`; a split child always inherits the source customer snapshot.

Result union: `reparented`, `idempotent_replay`, `not_found`, `forbidden`, `invalid_state`, `customer_mismatch`, `conflict`, or `command_key_conflict`. Successful results return `reparentingId`, source/target/child IDs, moved Conversation IDs, and current `updatedAt` tokens.

The file exports and registers one `CommandHandler<ReparentCaseInput, ReparentCaseResult>` with `id: 'connect.case.reparent'`, `isUndoable: true`, `execute`, `buildLog`, and `undo`. APIs execute it through the DI-resolved `commandBus`; they do not call a helper directly. `buildLog` returns the scoped actor/resource metadata and stores `{ undo: ReparentUndoPayload }` in command payload. `undo()` calls `extractUndoPayload<ReparentUndoPayload>(logEntry)` and fails closed if it is absent or invalid.

The canonical audit-log undo endpoint is the only HTTP undo surface. The successful reparent response returns the command bus `undoToken`; there is no `/api/connect/case-reparentings/[id]/undo` route and no `connect.case.reparent.undo` command ID. Generic undo authorization (`audit_logs.undo_self` / `audit_logs.undo_tenant`) is intersected inside the handler's `undo()` with wildcard-aware `connect.cases.reparent.undo`, same tenant/organization, and normal Case visibility checks before locks or writes. Redo is explicitly unsupported: the handler defines `redo()` that rejects with `409 reparent_redo_unsupported`, because replay after subsequent activity is not equivalent to a new reviewed reparent.

Undo behavior:

| Original | Safe undo result |
|---|---|
| Split | Move the recorded Conversations from child to source, restore the source snapshot, mark the child deleted only if it has no later activity or additional bindings, and retain both audit rows. |
| Merge | Move the recorded Conversations from target back to source and restore the source lifecycle/lineage snapshot. The target retains any Conversations and changes unrelated to the merge only when its recorded version/fingerprint proves they are unchanged; otherwise return `409`. |

Undo is unavailable when any moved Conversation received later activity, changed Case again, or the affected Case version differs from the audit's post-version. There is no forced undo endpoint.

### Deterministic locking

1. Sort source and target/child Case IDs lexicographically; lock with `PESSIMISTIC_WRITE` in that order.
2. Sort Conversation IDs lexicographically; lock each `ConnectConversation` and its active binding in that order.
3. Re-read state after locks.
4. Compare `expectedUpdatedAt` tokens and audit post-fingerprints.
5. Persist/flush the newly created split child before any query needing its ID. Thereafter, do not run an ORM `find` after mutating a locked Case or Conversation: all required rows are loaded first, then scalar/entity writes are staged and flushed once with audit/outbox writes. If implementation requires a later query, wrap the mutation/query segment with `withAtomicFlush` or add an explicit flush before that query.

The command must not perform an unlocked `find` between scalar mutation and flush. Raw conditional updates, if used, are parameterized and remain inside the transaction.

### Case lifecycle semantics

#### Split

- The source status, assignee, timestamps, and current clock lineage remain unchanged.
- The child starts `in_progress` when the source is active, or `new` when the source is `new`.
- The child copies `priority`, `customerKind`, and `customerId`; it does not copy encrypted subject, display label, or wrap-up. Its required `channelId` is derived from the selected Conversation with the earliest `(createdAt, id)` and therefore represents the earliest moved channel, not the source Case's possibly unrelated originating channel. Every selected Conversation is already scope-validated and its own channel remains authoritative for reply.
- `firstInboundAt` and `lastInboundAt` on the child are inherited from the source at split time because Phase 1 does not persist a complete per-Conversation inbound range. The audit marks this provenance as `source_case_snapshot`, preventing false precision.
- The child `firstAssignedAt`, `firstOutboundSentAt`, `resolvedAt`, and `closedAt` are null. Clock consumers use the event's inheritance instruction rather than these presentation fields.

#### Merge

- The target's status, deadlines, first response, ownership, priority, and lifecycle timestamps do not reset.
- The target `lastInboundAt` becomes the later of source and target. `firstInboundAt` becomes the earlier non-null value for list/history coherence; consumers interpret the separate lineage event under their own contracts.
- The source becomes `closed`, receives `closedAt=occurredAt` and `mergedIntoCaseId=target.id`, and retains its prior `resolvedAt`, wrap-up, ownership, and other history.
- A `ConnectCaseTransition` records the source's prior status to `closed` with `{ trigger: 'merge', reparentingId }`.

### Events and clock-consumer contract

Add frozen, singular, past-tense events to `connect/events.ts` through `createModuleEvents`:

| Event | Broadcast | Payload purpose |
|---|---|---|
| `connect.case.split` | client | Announces source and child lineage after commit. |
| `connect.case.merged` | client | Announces canonical target and terminal source after commit. |
| `connect.case.reparenting_undone` | client | Announces the inverse operation and restored lineage. |

Every payload includes:

```typescript
type ConnectCaseReparentingEvent = {
  tenantId: string
  organizationId: string
  sourceEventId: string
  reparentingId: string
  reversesReparentingId: string | null
  operation: 'split' | 'merge' | 'undo_split' | 'undo_merge'
  sourceCaseId: string
  destinationCaseId: string
  movedConversationCount: number
  occurredAt: string
  sourceUpdatedAt: string
  destinationUpdatedAt: string
  lineageInstruction:
    | 'child_of_source'
    | 'source_into_target'
    | 'inverse_of_reparenting'
  lineageVersion: 1
}
```

Payloads are staged in `connect_domain_outbox` in the mutation transaction. Publication remains at least once; `sourceEventId` is stable from the reparenting row, so consumers deduplicate it.

The lineage instruction is normative only as a statement of what Connect did:

- `child_of_source`: the destination is a newly created child of the source.
- `source_into_target`: the source became historical and its active Conversations moved to the surviving destination.
- `inverse_of_reparenting`: this row reverses the operation named by `reversesReparentingId`.

How SLA clocks, analytics facts, search documents, or other derived state interpret those facts belongs to each consumer's own specification. A consumer failure never rolls back Connect.

### Existing Connect reader and side-effect impacts

The implementation MUST update and test these real call sites; lineage columns alone are insufficient:

| Surface | Required behavior |
|---|---|
| `api/cases/route.ts` | Add nullable `mergedIntoCaseId`, `splitFromCaseId`, and `lineageVersion` without removing existing keys. A merged source remains readable to an authorized caller and identifies its canonical target. |
| `api/inbox/route.ts` | Exclude `mergedIntoCaseId != null` from active/triage views even if a stale status exists; closed-history queries may include it with canonical target fields. Split child appears normally. |
| `api/cases/[id]/thread/route.ts` and reply | Merged source cannot read/reply through Conversations now owned by target. Return `409 case_merged` with canonical target only after normal visibility checks. Split/source thread reads follow current binding ownership. |
| `lib/customer-context.ts` and response enrichers | Do not count a merged source as an open Case or latest active Case. Historical totals, if exposed later, count the canonical target once. |
| operational metrics | Reparenting emits no synthetic opened/resolved/reopened operational facts and adds no Phase 1 metric fact types. Phase 1 volume denominators and existing response/resolution facts remain unchanged. Analytics consumes the new lineage events under its own spec. |
| customer projection/retraction | Do not create, hide, or move a `CustomerInteraction` merely because Cases reparent. A future consumer may project lineage from events; current pending projections retain their original Case/projection keys. |
| `workers/auto-close-cases.ts` | Exclude merged sources. Split children follow their own status/timestamps after creation. |
| search/query index | Connect currently declares no `search.ts` Case index, so implementation performs no invented indexing call. The command log/outbox events are sufficient for a future optional index consumer; no message body is indexed. |
| Case access/assign/transition | A merged source is read-only. Assign, priority, resolve, reopen, close, and outbound commands reject it with `409 case_merged` and canonical target after access checks. |
| ingest | Uses the Conversation-first rule above; selected moved Conversations stay with their destination on later inbound. |

Cache invalidation covers both affected Case IDs, Inbox, customer context for both customer snapshots, and lineage/audit tags. Outbox publication remains part of the same transaction; query-index/cache work runs through canonical after-commit side effects and is retryable.

### Read facade

Register `connectCaseReparentingReader` in Connect DI with methods:

```typescript
type ConnectCaseReparentingReader = {
  getById(scope: ConnectReparentingScope, id: string): Promise<ConnectReparentingProjection | null>
  listAfter(scope: ConnectReparentingScope, cursor: ConnectReparentingCursor | null, limit: number): Promise<ConnectReparentingPage>
  getCaseLineage(scope: ConnectReparentingScope, caseId: string): Promise<ConnectCaseLineageProjection | null>
}

type ConnectContactDenominatorReader = {
  countCanonicalRoots(input: Readonly<{
    tenantId: string
    organizationId: string
    from: string
    to: string
  }>): Promise<Readonly<{
    contractVersion: 'connect.contact_root_created.v1'
    generatedAt: string
    count: number
  }>>
}

type ConnectReparentingScope = Readonly<{ tenantId: string; organizationId: string }>
type ConnectReparentingCursor = Readonly<{ occurredAt: string; id: string }>
type ConnectReparentingProjection = Readonly<{
  id: string
  operation: 'split' | 'merge' | 'undo_split' | 'undo_merge'
  sourceCaseId: string
  destinationCaseId: string
  reversesReparentingId: string | null
  lineageInstruction: 'child_of_source' | 'source_into_target' | 'inverse_of_reparenting'
  lineageVersion: 1
  movedConversationCount: number
  sourceBefore: ReparentCaseSnapshotV1
  destinationBefore: ReparentCaseSnapshotV1 | null
  sourcePostUpdatedAt: string
  destinationPostUpdatedAt: string
  sourceEventId: string
  occurredAt: string
}>
type ConnectReparentingPage = Readonly<{
  items: readonly ConnectReparentingProjection[]
  nextCursor: ConnectReparentingCursor | null
}>
type ConnectCaseLineageProjection = Readonly<{
  caseId: string
  mergedIntoCaseId: string | null
  splitFromCaseId: string | null
  lineageVersion: number
  operations: readonly Pick<ConnectReparentingProjection, 'id' | 'operation' | 'sourceCaseId' | 'destinationCaseId' | 'reversesReparentingId' | 'occurredAt'>[]
}>
```

`limit` is capped at 100. The projection contains identifiers, operation, versions, lifecycle snapshots, `lineageInstruction`, event ID, and timestamps only. It excludes subject, wrap-up, display label, handles, message data, and actor display data. All methods require tenant and organization and query both predicates.

Register `connectContactDenominatorReader` beside the lineage reader. It validates a non-empty half-open UTC range capped at 366 days and counts scoped, non-deleted roots whose own `created_at` is in `[from,to)` and `split_from_case_id IS NULL`. It returns only the versioned scalar above, uses the partial root/date index, and exposes no Case identifiers. Split descendants never increase the denominator; merge semantics are intentionally excluded from v1.

## Data Models

### Additive `ConnectCase` fields

| Field | Type | Rules |
|---|---|---|
| `merged_into_case_id` | uuid nullable | Same-module logical link; set only on merge source; immutable until safe undo. |
| `split_from_case_id` | uuid nullable | Same-module logical link; set only on split child; immutable. |
| `lineage_version` | integer not null default 0 | Incremented on every reparent or undo affecting the Case; used in consumer reconciliation. |

Indexes:

- `(tenant_id, organization_id, merged_into_case_id)` where non-null.
- `(tenant_id, organization_id, split_from_case_id)` where non-null.

No ORM relationship decorator is needed; the UUID fields keep loading and locking explicit.

### `ConnectCaseNumberSequence`

Table: `connect_case_number_sequences`

| Field | Type | Rules |
|---|---|---|
| `id` | uuid | Primary key. |
| `tenant_id` | uuid | Required scope. |
| `organization_id` | uuid | Required scope. |
| `next_number` | integer | Greater than zero; next value to allocate. |
| `created_at` | timestamptz | Required. |
| `updated_at` | timestamptz | Required. |

Unique `(tenant_id, organization_id)`; the allocator is the sole writer after migration.

### `ConnectCaseReparenting`

Table: `connect_case_reparentings`

| Field | Type | Rules |
|---|---|---|
| `id` | uuid | Primary key. |
| `tenant_id` | uuid | Required scope. |
| `organization_id` | uuid | Required scope. |
| `operation` | text | `split`, `merge`, `undo_split`, or `undo_merge`; CHECK constrained. |
| `source_case_id` | uuid | Required same-scope Case ID. |
| `destination_case_id` | uuid | Split child or merge target. |
| `client_command_key` | text | Unique with tenant and organization. |
| `payload_fingerprint` | text | Canonical hash for retry conflict detection; not a secret. |
| `actor_user_id` | uuid | Logical auth user ID; no cross-module ORM relation. |
| `reason` | text | Required audit reason, maximum 500; sensitive free text. |
| `source_before` | jsonb | `ReparentCaseSnapshotV1`, maximum serialized size 4 KiB. |
| `destination_before` | jsonb | `ReparentCaseSnapshotV1`, maximum serialized size 4 KiB. |
| `source_post_updated_at` | timestamptz | Exact safe-undo token. |
| `destination_post_updated_at` | timestamptz | Exact safe-undo token. |
| `reverses_reparenting_id` | uuid nullable | Original row for an inverse operation. |
| `status` | text | `completed` or `reversed`; CHECK constrained. |
| `occurred_at` | timestamptz | Domain occurrence. |
| `created_at` | timestamptz | Persistence time. |
| `updated_at` | timestamptz | Optimistic version for an administrative read surface. |

Required constraints/indexes:

- Unique `(tenant_id, organization_id, client_command_key)`.
- Unique partial `reverses_reparenting_id` where non-null.
- Index `(tenant_id, organization_id, source_case_id, created_at, id)`.
- Index `(tenant_id, organization_id, destination_case_id, created_at, id)`.
- Index `(tenant_id, organization_id, created_at, id)` for keyset reconciliation.

Checks require `reverses_reparenting_id IS NULL` for `split|merge`, non-null for `undo_split|undo_merge`, and `status='reversed'` only after one inverse row exists. The inverse transaction inserts its row and changes the original from `completed` to `reversed` atomically.

Exact snapshot and undo payload contracts:

```typescript
type ReparentCaseSnapshotV1 = {
  schemaVersion: 1
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

type ReparentItemSnapshotV1 = {
  conversationId: string
  fromCaseId: string
  toCaseId: string
  beforeBindingId: string
  afterBindingId: string
  conversationUpdatedAtBefore: string
  conversationUpdatedAtAfter: string
  lastMessageAtAtExecution: string | null
}

type ReparentUndoPayload = {
  schemaVersion: 1
  reparentingId: string
  operation: 'split' | 'merge'
  sourceBefore: ReparentCaseSnapshotV1
  destinationBefore: ReparentCaseSnapshotV1 | null
  sourcePostUpdatedAt: string
  destinationPostUpdatedAt: string
  itemCount: number
  payloadFingerprint: string
}
```

The command reads normalized items by `reparentingId` during undo; the action-log payload does not embed an unbounded item array. The canonical SHA-256 fingerprint is computed before encryption over RFC-8785-style canonical JSON containing the validated operation, scoped IDs, sorted Conversation IDs, optimistic tokens, normalized reason, override flag, and schema version. It excludes actor/session metadata and never includes decrypted Case subject, wrap-up, message content, or handles. Equivalent retries compare this fingerprint; it is safe to log only as a hash.

Moved Conversation state is normalized into `connect_case_reparenting_items(id, reparenting_id, tenant_id, organization_id, conversation_id, from_case_id, to_case_id, before_binding_id, after_binding_id, before_conversation_updated_at, after_conversation_updated_at, last_message_at_at_execution, created_at)`. It has unique `(tenant_id, organization_id, reparenting_id, conversation_id)`, indexes on both scoped Case IDs, and scalar UUID links rather than ORM relationships. This avoids an unbounded array and gives undo an exact fingerprint per Conversation. API detail reads paginate these items; events carry only the moved count because consumers receive Case lineage rather than Conversation inventory.

Add a partial unique index on `connect_conversation_case_bindings(tenant_id, organization_id, conversation_id) WHERE unbound_at IS NULL`. Migration preflight queries duplicate active intervals and aborts with a named, actionable error rather than choosing a winner. After remediation, the retry-safe migration drops any invalid concurrent index stub before rebuilding it when online index creation is required.

### Sensitive data

Only `reason` is free text and encrypted through the existing `connect/data/encryption.ts` `defaultEncryptionMaps` entry `{ entityId: 'connect:connect_case_reparenting', fields: [{ field: 'reason' }] }`. The typed before snapshots contain identifiers, enums, and timestamps only; they deliberately exclude subject, display label, wrap-up, customer identifiers, and message data and remain plaintext JSON for deterministic safe-undo comparisons. Every read that can project `reason` uses `findWithDecryption`/`findOneWithDecryption` with tenant and organization scope. The command computes its fingerprint from validated plaintext before persistence/encryption. Audit list responses omit reason and snapshots; a feature-gated detail response may return decrypted reason. No encrypted value or plaintext reason is logged.

## API Contracts

All route files export per-method `metadata` and schema-backed `openApi`. Action routes use the mutation guard registry with operation `update`, merge modified payloads and re-parse the zod schema before command execution, execute through `commandBus`, and run after-success callbacks after commit with logged failure isolation.

### Split a Case

`POST /api/connect/cases/[id]/split`

Feature: `connect.cases.reparent`

Request:

```json
{
  "conversationIds": ["uuid"],
  "expectedUpdatedAt": "2026-08-22T12:00:00.000Z",
  "clientCommandKey": "uuid-or-client-token",
  "reason": "Incorrectly grouped conversations",
}
```

Success schema is `{ status:'reparented', operation:'split', reparentingId, sourceCaseId, destinationCaseId, movedConversationIds:string[], sourceUpdatedAt, destinationUpdatedAt, undoToken }`; first execution is `201`. A replay returns the byte-equivalent result as `200` with `idempotentReplay: true` and the original undo token.

### Merge Cases

`POST /api/connect/cases/[id]/merge`

Feature: `connect.cases.reparent`

Request schema is `{ targetCaseId:uuid, expectedSourceUpdatedAt:datetime, expectedTargetUpdatedAt:datetime, clientCommandKey:string(1..128), reason:string(1..500), allowCustomerMismatch?:boolean=false }`. Success schema is `{ status:'reparented', operation:'merge', reparentingId, sourceCaseId, destinationCaseId, movedConversationCount, sourceUpdatedAt, destinationUpdatedAt, undoToken }`.

### Undo reparenting

Use the existing `POST /api/audit_logs/audit-logs/actions/undo` contract with the `undoToken` returned by split/merge. The Connect handler's `undo()` performs the domain fingerprint checks and returns the standard structured `409 unsafe_undo` conflict through `CrudHttpError`. No Connect-specific undo URL is introduced.

### Read audit and lineage

- `GET /api/connect/case-reparentings?caseId=&cursor=&pageSize=` requires `connect.cases.reparent.audit`; query schema caps `pageSize` at 100 and cursor is base64url JSON `{ occurredAt, id }`. Response is `{ items:[{ id, operation, sourceCaseId, destinationCaseId, reversesReparentingId, movedConversationCount, occurredAt, status }], nextCursor }`. It omits reason and snapshots.
- `GET /api/connect/case-reparentings/[id]` requires `connect.cases.reparent.audit` and returns the minimized projection plus decrypted `reason`; items are separately keyset-paginated at `?itemCursor=&pageSize=`.
- `GET /api/connect/cases/[id]/lineage` requires normal Case read access and returns `ConnectCaseLineageProjection`; it never widens Case visibility. `canUndo` is not guessed here—the action log/undo token is authoritative.

### Error contract

| Status | Code | Meaning |
|---|---|---|
| `400` | `organization_required` | No selected organization. |
| `401` | `unauthorized` | No authenticated user. |
| `403` | `feature_required` / `override_required` | Caller lacks the operation or exceptional override feature. |
| `404` | `not_found` | Any referenced record is absent, out of scope, or unreadable. |
| `409` | `optimistic_lock_conflict` | A Case changed after load. |
| `409` | `unsafe_undo` | Post-operation fingerprints no longer match. |
| `409` | `command_key_conflict` | Same idempotency key, different canonical payload. |
| `409` | `case_merged` | The requested source is historical; response includes visible canonical target ID. |
| `422` | `invalid_state` / `invalid_selection` / `customer_mismatch` | Domain validation failed. |

Every `409` uses the standard optimistic-lock conflict shape where applicable: `{ error:'record_conflict', code, currentUpdatedAt?, conflictingFields?, details? }`. API responses return `updatedAt` for editable records. Validation uses zod and all JSON reads use `readJsonSafe`.

## Access Control

Add singular feature IDs to `connect/acl.ts` and synchronize defaults in `connect/setup.ts`:

| Feature | Default roles | Capability |
|---|---|---|
| `connect.cases.reparent` | manager, admin, superadmin | Split and merge visible Cases. |
| `connect.cases.reparent.override` | admin, superadmin | Override customer mismatch/unlinked safeguards with reason. |
| `connect.cases.reparent.undo` | manager, admin, superadmin | Safe conditional undo. |
| `connect.cases.reparent.audit` | manager, admin, superadmin | Read full reparent audit reasons. |

Wildcard-aware `authorizeFeatures` semantics apply. Existing tenants receive grants through the documented idempotent `auth sync-role-acls` path. Feature grants never widen organization scope or Case visibility.

## Cache Strategy

Correctness does not depend on cache. Initial implementation reads indexed tables directly because reparenting is supervisory and low-volume.

If existing Connect Case/inbox reads are cached when implementation lands, the command resolves cache through DI and invalidates `tenant:<tenantId>`, `org:<organizationId>`, `connect:case:<id>`, `connect:inbox`, and customer-context tags for both Cases after commit. Cache failure is logged and does not roll back committed data. No raw Redis or SQLite client is introduced.

## Internationalization

This API-first contract introduces no required UI. Any later UI must add keys in all five Connect locales (`en`, `pl`, `es`, `de`, `ko`) for split, merge, undo, reason, unsafe-undo, conflict, and customer-mismatch states. Internal-only errors use the `[internal]` prefix; user-facing messages resolve through `t('connect.errors.<key>')`.

## UI/UX Boundary

UI is deliberately deferred to a successor change. The APIs expose the action-log `undoToken` and standard conflicts so a later Inbox action can use `useGuardedMutation`, `apiCall`, `useConfirmDialog`, and the unified conflict bar. Any dialog must support Cmd/Ctrl+Enter and Escape, use semantic status tokens and shared primitives, and provide `aria-label` for icon-only controls. No raw `fetch`, raw form, inline SVG, arbitrary Tailwind values, or hard-coded user strings are permitted.

Because this spec does not add or change a Next.js page or client component, a Frontend Architecture Contract is N/A.

## Migration & Backward Compatibility

This change is additive:

- Existing Case status values, routes, commands, event IDs, and widget IDs are unchanged.
- New nullable lineage columns and a defaulted integer column permit a rolling deployment.
- The new entity, routes, command IDs, ACL IDs, DI name, and event IDs become public contract surfaces at first release and must be reviewed before merge.
- No lineage-history backfill is required. Existing Cases start with `lineage_version=0` and null lineage fields. The number-sequence migration performs the bounded grouped seed from existing Case maxima described above; it does not rewrite Case rows.
- Migration adds constraints and indexes without rewriting encrypted content. The defaulted lineage column must use a deployment-safe approach for the supported PostgreSQL version; if table size makes an immediate NOT NULL validation unsafe, add nullable/default, backfill in bounded batches, then validate/set NOT NULL.
- Update `packages/connect/src/modules/connect/migrations/.snapshot-open-mercato.json` with only intended Connect changes. Run `yarn db:generate` as a schema-diff probe; never apply `yarn db:migrate` without explicit approval.
- Rollback before any reparent rows exist may drop new tables/columns. After use, application rollback leaves additive data intact; down migration must not destroy reparent history automatically.

### Public surfaces introduced

| Surface | Additive contract |
|---|---|
| Entity IDs | `connect:connect_case_number_sequence`, `connect:connect_case_reparenting`, `connect:connect_case_reparenting_item` |
| Command IDs | `connect.case.reparent` (registered, undoable; no separate undo ID) |
| Event IDs | `connect.case.split`, `connect.case.merged`, `connect.case.reparenting_undone` |
| API URLs | Split, merge, audit detail/list, and lineage routes above; undo reuses the stable audit-log URL |
| DI key | `connectCaseReparentingReader` |
| ACL IDs | Four features above |
| DB schema | Additive Case columns and three tables |

## Implementation Plan

### Phase 1 — Persistence and pure invariants

1. Add zod schemas and pure split/merge/undo validation helpers with exhaustive unit tests.
2. Add the atomic Case number sequence, Case lineage fields, reparenting parent/item entities, active-binding uniqueness, indexes, checks, encryption map, migration preflight, and module snapshot.
3. Register entity classes and the fully typed read facade in Connect DI.
4. Run `yarn generate` and review generated discovery output.

Working result: the package builds with a migration-ready schema and tested domain decisions, but no route can mutate production data.

### Phase 2 — Atomic commands and events

1. Refactor inbound ingest to use the shared Conversation-first lock/attach rule and atomic Case number allocator; prove existing new-Conversation behavior remains unchanged.
2. Implement and register `connect.case.reparent` with deterministic locking, idempotency, binding intervals, transitions, audit, lineage versions, command logs, and transactional outbox staging.
3. Implement its conditional `undo()` with `extractUndoPayload`, post-fingerprint validation, an inverse audit row, and explicit redo rejection.
4. Add the three event definitions and facade-based reconciliation semantics.
5. Add unit tests including true concurrent transaction tests against PostgreSQL.

Working result: commands are safe and independently invocable through the command bus.

### Phase 3 — Guarded APIs and consumer facade

1. Add split and merge routes with metadata, mutation guards, command-bus execution, OpenAPI, undo tokens, and standard conflicts; verify the existing audit-log undo endpoint calls the handler.
2. Add keyset-paginated audit detail/list and scoped lineage reads; extend existing Case projections additively.
3. Update Inbox/thread/reply/access/customer-context/metrics/projection/auto-close/search behavior from the impact table.
4. Complete the DI facade and module-decoupling tests.
5. Add self-contained Playwright/API integration coverage for every path and tenancy edge.

Working result: the full API contract is usable, documented, isolated, and consumable by optional modules.

### Phase 4 — Compatibility and release gate

1. Run generator, package build/typecheck/lint/test and targeted integration gates with one recorded runner mode.
2. Inspect every generated migration/snapshot diff and remove unrelated churn.
3. Review frozen event, command, API, DI, entity, and ACL identifiers against `BACKWARD_COMPATIBILITY.md`.
4. Update this changelog with exact implementation evidence; do not move the spec to `implemented/` until deployed evidence exists.

## File Manifest

| File | Action | Purpose |
|---|---|---|
| `packages/connect/src/modules/connect/data/entities.ts` | Modify | Case lineage fields and reparenting entities. |
| `packages/connect/src/modules/connect/data/validators.ts` | Modify | Reparent and undo zod schemas. |
| `packages/connect/src/modules/connect/data/encryption.ts` | Modify | Encrypt reparenting audit reason only. |
| `packages/connect/src/modules/connect/commands/reparent-case.ts` | Create | Atomic split/merge command. |
| `packages/connect/src/modules/connect/lib/case-reparenting.ts` | Create | Pure invariant and fingerprint helpers. |
| `packages/connect/src/modules/connect/lib/case-number.ts` | Create | Atomic scope-number allocator shared by ingest and split. |
| `packages/connect/src/modules/connect/lib/case-reparenting-reader.ts` | Create | Scoped plain-projection DI facade. |
| `packages/connect/src/modules/connect/lib/contact-denominator-reader.ts` | Create | Scoped bounded canonical-root count contract. |
| `packages/connect/src/modules/connect/events.ts` | Modify | Frozen identifier-only events. |
| `packages/connect/src/modules/connect/di.ts` | Modify | Entity and facade registrations. |
| `packages/connect/src/modules/connect/acl.ts` | Modify | Reparent features. |
| `packages/connect/src/modules/connect/setup.ts` | Modify | Default role grants. |
| `packages/connect/src/modules/connect/api/cases/[id]/split/route.ts` | Create | Guarded split endpoint. |
| `packages/connect/src/modules/connect/api/cases/[id]/merge/route.ts` | Create | Guarded merge endpoint. |
| `packages/connect/src/modules/connect/api/case-reparentings/route.ts` | Create | Audit list. |
| `packages/connect/src/modules/connect/api/case-reparentings/[id]/route.ts` | Create | Audit detail and paginated item read. |
| `packages/connect/src/modules/connect/api/cases/[id]/lineage/route.ts` | Create | Scoped lineage read. |
| `packages/connect/src/modules/connect/api/cases/route.ts` | Modify | Add lineage projection fields and merged-source mutation rejection. |
| `packages/connect/src/modules/connect/api/inbox/route.ts` | Modify | Exclude merged sources from active triage. |
| `packages/connect/src/modules/connect/api/cases/[id]/thread/route.ts` | Modify | Enforce current binding/canonical target semantics. |
| `packages/connect/src/modules/connect/commands/ingest-inbound-message.ts` | Modify | Atomic number allocator and Conversation-first serialized attach. |
| `packages/connect/src/modules/connect/commands/enqueue-outbound.ts` | Modify | Lock Conversation and reject historical merged source. |
| `packages/connect/src/modules/connect/commands/{assign-case,transition-case}.ts` | Modify | Reject merged historical sources after scoped access. |
| `packages/connect/src/modules/connect/lib/customer-context.ts` | Modify | Canonical counting/latest Case semantics. |
| `packages/connect/src/modules/connect/workers/auto-close-cases.ts` | Modify | Exclude merged sources. |
| `packages/connect/src/modules/connect/migrations/Migration<timestamp>_connect.ts` | Create | Additive schema migration. |
| `packages/connect/src/modules/connect/migrations/.snapshot-open-mercato.json` | Modify | Post-change module schema. |
| `packages/connect/src/modules/connect/commands/__tests__/reparent-case.test.ts` | Create | Command and locking tests. |
| `packages/connect/src/modules/connect/lib/__tests__/case-reparenting.test.ts` | Create | Pure invariant tests. |
| `packages/connect/src/modules/connect/lib/__tests__/contact-denominator-reader.test.ts` | Create | Root cohort, scope, range, and privacy tests. |
| `packages/connect/src/modules/connect/__integration__/helpers/reparentingFixtures.ts` | Create | API-created fixtures and finally-safe cleanup. |
| `packages/connect/src/modules/connect/__integration__/TC-CONNECT-REP-001..013.spec.ts` | Create | One independently discoverable API/concurrency scenario per file. |
| `packages/connect/src/modules/connect/__tests__/module-decoupling.test.ts` | Create | Package-local optional-consumer/disabled-module proof without changing platform code. |

## Testing Strategy

### Unit and property tests

- Split selection: empty, duplicate, foreign, all-active, inactive, and more than 100 IDs.
- Merge lifecycle matrix: active/closed/merged source and target combinations.
- Customer safety: equal, mismatched, null/non-null, override grant, and wildcard grant.
- Canonical payload fingerprint stability and command-key mismatch.
- Earlier/later timestamp folding and lineage-version increments.
- Undo fingerprint acceptance and every later-change rejection.
- Event payload minimization: assert no subject, wrap-up, handle, body, customer label, or decrypted value.
- Command registry: the generated loader registers exactly `connect.case.reparent`; `buildLog` stores a valid `ReparentUndoPayload`; `undo()` uses `extractUndoPayload`; no second undo command exists; redo rejects predictably.
- Existing readers: merged source exclusion/canonical-target behavior across Inbox, Case mutation, thread, reply, customer context, metrics, projection, auto-close, and search indexing.

### Transaction and concurrency tests

- Two simultaneous splits of the same Conversation: one commits, one conflicts; one active binding remains.
- Opposing merge A→B and B→A: deterministic locking prevents deadlock and only one valid operation commits.
- Inbound attach racing split/merge: the shared Conversation lock serializes; inbound belongs to exactly one Case.
- First inbound after a completed split stays on the child because Conversation-specific ownership wins over the identity binding; a new Conversation for the same identity still follows the existing identity/customer attach rule.
- Split child creation racing inbound Case opening and two simultaneous inbound opens allocate distinct monotonically increasing Case numbers through `ConnectCaseNumberSequence`.
- Undo racing new inbound/outbound activity: undo returns `409` and preserves later work.
- Retried request after lost response returns the original result and creates no duplicate binding, transition, audit, or event.
- Simulated failure after each write stage rolls back all aggregate and outbox changes.

### Integration coverage

| Test | Path / behavior |
|---|---|
| `REP-INT-001` | Split success; source and child lists, bindings, transitions, audit, and event agree. |
| `REP-INT-002` | Merge success; source remains historical/closed, target remains canonical. |
| `REP-INT-003` | Safe split/merge undo through the existing audit-log undo URL appends inverse audit rows and requires both audit and Connect undo features. |
| `REP-INT-004` | Unsafe undo after later activity returns standard `409`. |
| `REP-INT-005` | Cross-tenant and sibling-organization IDs return identical `404` on every route. |
| `REP-INT-006` | Missing feature is denied; override requires its dedicated feature. |
| `REP-INT-007` | Mutation guard denial/modification/after-success behavior is honored. |
| `REP-INT-008` | Duplicate publication preserves one stable `sourceEventId`; a fixture subscriber can deduplicate without importing Connect entities. |
| `REP-INT-009` | `connect_sla` absent: all Connect operations still succeed and no hard dependency resolves. |
| `REP-INT-010` | Audit keyset pagination has no duplicates or omissions under concurrent inserts. |
| `REP-INT-011` | OpenAPI exposes all routes and documented response statuses. |
| `REP-INT-012` | Existing Case/Inbox/thread/reply/customer-context/metrics/projection/auto-close/search behavior matches the downstream impact table. |
| `REP-INT-013` | Number sequence migration seeds from existing maxima and concurrent split/inbound allocations never collide. |

Each row is a separate `TC-CONNECT-REP-###.spec.ts` file. Module-local helpers create the tenant, organization, users, Cases, Conversations, and bindings through APIs/commands where possible and clean them in `finally`; no seeded/demo data is assumed. Tests import shared helpers from `@open-mercato/core/helpers/integration/*`, declare Connect module metadata if needed, and are listed with `npx playwright test --config .ai/qa/tests/playwright.config.ts --list` before execution.

## Risks & Impact Review

### Data Integrity Failures

#### Partial binding movement
- **Scenario**: A crash occurs after closing an old binding but before opening its replacement, orphaning a Conversation.
- **Severity**: Critical
- **Affected area**: Connect Inbox, thread access, optional clock consumers
- **Mitigation**: Case, Conversation, binding, audit, transition, and outbox writes share one database transaction; failure-injection tests cover each stage.
- **Residual risk**: PostgreSQL/storage failure may abort the transaction, but leaves no committed partial operation.

#### Concurrent reparent operations
- **Scenario**: Two supervisors split or merge the same Case and both believe they moved the same Conversation.
- **Severity**: Critical
- **Affected area**: Case isolation and conversation visibility
- **Mitigation**: Optimistic Case tokens plus deterministic pessimistic locks on Cases, Conversations, and active bindings; database constraints and concurrency tests.
- **Residual risk**: One operator must reload and retry after a legitimate conflict.

#### Later inbound reverses a correction
- **Scenario**: A moved Conversation receives a new inbound while its identity binding still names the former Case.
- **Severity**: Critical
- **Affected area**: Case isolation, Inbox, and customer disclosure
- **Mitigation**: Ingest and reparent share the scoped Conversation write lock; existing Conversation ownership wins over identity binding; pointer, interval, receipt, Case decision, and outbox fact commit atomically.
- **Residual risk**: A brand-new Conversation for the identity still follows the identity/customer attach rule by design.

#### Concurrent Case-number allocation
- **Scenario**: Split and inbound opening allocate the same human-facing Case number.
- **Severity**: High
- **Affected area**: Split and inbound Case creation
- **Mitigation**: Both paths use the locked `ConnectCaseNumberSequence`; migration seeds from the greatest existing number; the Case unique constraint remains a final guard.
- **Residual risk**: Allocation serializes briefly within one organization, which is acceptable and measured.

#### Unsafe undo overwrites later work
- **Scenario**: An undo moves a Conversation after new inbound traffic or agent action occurred.
- **Severity**: Critical
- **Affected area**: Case history, ownership, customer disclosure
- **Mitigation**: Exact post-operation Case and Conversation fingerprints; fail closed with `409`; no force undo.
- **Residual risk**: Complex corrections after later work require a new explicit reparent action, not automatic undo.

#### Oversized merge audit
- **Scenario**: A Case with many Conversations creates an unbounded JSON/array row or event.
- **Severity**: High
- **Affected area**: Database row size, event transport, worker memory
- **Mitigation**: Normalized item rows, count-only event payloads, facade reconciliation, `pageSize<=100`.
- **Residual risk**: Very large merges take longer while locks are held; operational UI should warn and a later worker-based preparation flow may be warranted from measured cardinality.

### Cascading Failures & Side Effects

#### Optional consumer misses an event
- **Scenario**: SLA or analytics is disabled or its persistent subscriber fails while a reparent commits.
- **Severity**: High
- **Affected area**: Derived clocks and reporting
- **Mitigation**: Transactional Connect outbox, stable source event ID, persistent subscriber retries, keyset read facade for reconciliation.
- **Residual risk**: Derived views can lag until retry/reconciliation; Connect remains correct.

#### Event loop or circular dependency
- **Scenario**: A clock consumer reacts by mutating Connect, producing a loop.
- **Severity**: High
- **Affected area**: Events and queue throughput
- **Mitigation**: Consumer contract is one-way; consumers write only their own state and never call reparent commands as a side effect.
- **Residual risk**: Third-party consumers can violate guidance; stable source IDs allow loop detection and dedupe.

### Tenant & Data Isolation Risks

#### Cross-organization merge disclosure
- **Scenario**: An attacker supplies a target Case UUID from a sibling organization and gains its Conversations.
- **Severity**: Critical
- **Affected area**: Every reparent API and read facade
- **Mitigation**: Scope from authenticated context only; all Case, Conversation, binding, audit, and facade queries include tenant and organization; inaccessible references return `404`.
- **Residual risk**: A future query missing either predicate remains dangerous; dedicated isolation tests cover every route.

#### Customer mismatch within an organization
- **Scenario**: Two customers' Cases are merged by mistake, exposing unrelated threads to an agent.
- **Severity**: Critical
- **Affected area**: Inbox and customer context
- **Mitigation**: Same-customer invariant by default; dedicated override feature and non-empty audit reason; reversible while unchanged.
- **Residual risk**: An authorized supervisor can still make a mistaken override; audit and conditional undo reduce but cannot eliminate human error.

### Migration & Deployment Risks

#### Table rewrite or migration drift
- **Scenario**: Adding a defaulted non-null lineage column locks a large table, or schema generation emits unrelated migrations.
- **Severity**: Medium
- **Affected area**: Deployment availability and repository schema history
- **Mitigation**: Deployment-safe staged constraint when required; use `db:generate` only as probe; retain only intended SQL; update the Connect snapshot.
- **Residual risk**: Exact lock duration depends on production cardinality and PostgreSQL version and must be checked before deploy.

#### Frozen identifier mistake
- **Scenario**: A shipped event/API/ACL/DI ID later proves ambiguous and cannot be renamed without deprecation.
- **Severity**: High
- **Affected area**: Third-party modules and stored grants
- **Mitigation**: Explicit public-surface inventory and compatibility review before first merge.
- **Residual risk**: Additive fields may still be needed later; existing semantics remain stable.

### Operational Risks

#### Lock contention and noisy neighbor
- **Scenario**: A large merge holds locks while inbound processing targets the same Conversations.
- **Severity**: High
- **Affected area**: One organization's inbound latency
- **Mitigation**: Deterministic locks, normalized bounded writes, maximum split batch, query indexes, transaction duration metrics, and timeout logging without PII.
- **Residual risk**: A pathological Case can delay its own traffic; blast radius remains the locked records, not other tenants.

#### Audit storage growth
- **Scenario**: Frequent correction churn grows parent/item audit tables indefinitely.
- **Severity**: Medium
- **Affected area**: Connect database storage
- **Mitigation**: Compact identifier/version snapshots, normalized indexes, no duplicated message content, and measurable row counts.
- **Residual risk**: Audit is intentionally durable; retention requires a later legal/operational policy and cannot delete evidence silently.

## Final Compliance Report — 2026-08-22

### AGENTS.md Files Reviewed

- `AGENTS.md` (root)
- `.ai/specs/AGENTS.md`
- `.ai/qa/AGENTS.md`
- `packages/core/AGENTS.md`
- `packages/cli/AGENTS.md`
- `BACKWARD_COMPATIBILITY.md`
- `.ai/docs/module-development.md`
- `.ai/skills/om-spec-writing/SKILL.md` and required checklist/compliance references

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|---|---|---|---|
| Root architecture | No direct ORM relationships between modules | Compliant | Reparenting is Connect-owned; peer IDs are scalar and consumers use events/facade. |
| Root data/security | Every scoped query filters tenant and organization | Compliant | Commands, APIs, audit, items, and facade require both. |
| Root optimistic locking | Editable entities/actions return and enforce versions | Compliant | Both Cases require expected tokens; audit rows expose `updatedAt` where editable/read. |
| Root mutation rules | Do not bypass guards, commands, or side effects | Compliant | Custom routes run mutation guards and delegate to commands. |
| Core API Routes | Every route exports `openApi` and metadata | Compliant | Required for all five routes. |
| Core Events | Use `createModuleEvents`; stable singular IDs | Compliant | Three identifier-only outbox events are declared. |
| Core Cross-Module Coupling | Optional consumer owns glue and degrades when absent | Compliant | Connect has no consumer dependency; consumer uses persistent subscriber and `tryResolve`. |
| Core Encryption | Sensitive fields use encryption map and decrypted reads | Compliant | Only audit `reason` is sensitive/encrypted; typed identifier/timestamp snapshots exclude PII. |
| Shared command contract | Undoable writes use a registered handler and `extractUndoPayload` | Compliant | One `connect.case.reparent` handler owns execute/undo; generic audit-log undo is the only HTTP inverse. |
| CLI migrations | Generate, review, and update module snapshot; do not migrate | Compliant | Migration workflow is explicit. |
| Backward compatibility | Existing frozen surfaces unchanged; new surfaces inventoried | Compliant | All additions listed for pre-merge review. |
| UI/DS rules | Canonical primitives/tokens and guarded mutations | N/A | No UI file is added or changed; successor UI constraints are recorded. |
| Integration testing | Self-contained fixtures and all affected paths | Compliant | Thirteen separate TC files cover writes, reads, downstream consumers, tenancy, guards, events, numbering, and OpenAPI. |

### Internal Consistency Check

| Check | Status | Notes |
|---|---|---|
| Data models match API contracts | Pass | Parent/item audit and lineage fields support every response and undo predicate. |
| API contracts match UI/UX section | Pass | API-first; UI explicitly deferred. |
| Risks cover all write operations | Pass | Split, merge, undo, event publication, and migration failures are covered. |
| Commands defined for all mutations | Pass | One registered reparent handler owns execute and the sole canonical undo. |
| Cache strategy covers all read APIs | Pass | Direct indexed reads; conditional invalidation if existing Case cache is present. |
| Undo matches execute | Pass | Exact binding/lifecycle snapshots and post-fingerprints are specified. |
| Optional consumer semantics are non-circular | Pass | Events flow outward; facade is read-only; Connect never resolves consumer code. |

### Non-Compliant Items

None identified.

### Verdict

**Fully compliant: Approved — ready for implementation after maintainer approval of the new frozen contract identifiers.**

## Changelog

### 2026-08-23 — Implemented

Implemented across five commits on `cez/598f0587`. The file manifest shipped as written, with the
deviations and discoveries below.

**Executed evidence.** 402 Connect unit tests and 41 Connect integration tests pass, the latter against a
live app (Next dev on a disposable PostgreSQL, admin session, `OM_INTEGRATION_MODULES=connect`). The
migration was applied to that database rather than only generated, and `yarn db:generate` then reported
`connect: no changes`, proving the refreshed snapshot matches entity metadata.

**Deviations from the written spec:**

- **Interval write ordering.** The spec did not anticipate that `connect_conversation_case_bindings_active_uq`
  is checked *per statement*. MikroORM's unit of work ordered the replacement INSERT ahead of the UPDATE
  closing the old interval, so every split failed on the constraint. `moveConversation` was therefore split
  into `closeConversationInterval` + `openReplacementIntervals` with an explicit flush between them. Both
  halves still commit in one transaction. **Found by the first executed integration spec, not by review.**
- **Deadlock ordering is a residual risk, not eliminated.** The spec claims the lock orders "avoid a
  Case→Conversation / Conversation→Case deadlock". They do not fully: reparent takes Cases then
  Conversations, while ingest takes its Conversation first and then writes its Case, which is an AB/BA
  pair. The Conversation-first ingest rule is required for correctness (a moved Conversation must stay
  with its destination), so it was kept; PostgreSQL's deadlock detector aborts one side and both callers
  treat that as retryable. Worst case is a retryable abort, never a partial write.
- **Codepoint sorting.** The canonical fingerprint and the deterministic lock order sort identifiers, and
  the repo's explicit-comparator guard (#3620) surfaced that a bare `.sort()` uses locale collation — which
  would make the same request hash differently, and two nodes lock in different orders, depending on the
  server's `LANG`. `compareIdentifiers` was added and applied; the pre-existing identical bug in the
  principal-classification fingerprint was fixed in passing.
- **Replay undo token.** A replayed request returns `undoToken: null` rather than re-issuing the original
  token: the replay performs nothing and mints no action-log entry, and the caller already holds the token
  from its first response. Minting a second token for one operation would let it be reversed twice.
- **Spec typo carried forward, not shipped.** The spec's split request example has a trailing comma and
  omits nothing else; the implemented schema is `{ conversationIds, expectedUpdatedAt, clientCommandKey,
  reason }` as described in prose.

**Known-unimplemented / deferred:**

- Cache invalidation is not wired. Connect Case and Inbox reads are not cached today, so as the spec's Cache
  Strategy section allows, correctness does not depend on it and no invalidation call was invented.
- The operational-metrics, customer-projection and search rows of the impact table required no code: Connect
  declares no `search.ts` Case index, reparenting emits no synthetic metric facts, and projections retain
  their original keys. Their *absence* is asserted by `TC-CONNECT-REP-012`.
- UI remains deferred by design.

**Pre-existing failures in the repository gate, unrelated to this change** (both scan files this branch does
not meaningfully alter):

- `packages/cli` module-facts anti-drift fixture expects 25 `customers` entities and finds 26. `packages/cli`
  and `packages/core/src/modules/customers` are byte-identical to the base commit.
- `optimistic-lock-command-coverage` wants an allowlist entry with a `record_locks` decision for
  `connect/commands/principal-classifications.ts`. That file has the same two
  `enforceCommandOptimisticLock(` call sites at base as at HEAD — this branch only changed a sort
  comparator in it — so the guard's verdict is unaffected by this work. Recording a `record_locks`
  decision for another change's command is left to its owners.

Note for reviewers reproducing locally: `yarn test` must run with `NODE_ENV` unset. A leaked
`NODE_ENV=production` makes React resolve its production build (`React.act is not a function`) and trips
test-only guards, producing failures unrelated to any change.

### 2026-08-22

- Initial implementation-ready specification for Connect-owned split, merge, conditional undo, and optional clock-consumer lineage semantics.
- Remediated pre-implementation blockers: Conversation-first inbound serialization, shared atomic Case numbering, canonical registered `CommandHandler.undo()` with `extractUndoPayload`, exact bounded snapshot/item/fingerprint schemas, deterministic child channel derivation, encrypted reason-only audit storage, complete API/event/DI types, downstream reader/metrics/projection behavior, and thirteen isolated integration scenarios.

### Review — 2026-08-22

- **Reviewer**: Agent self-review plus independent fresh-context scope review
- **Security**: Passed — scope, mismatch, PII minimization, and access rules explicit
- **Performance**: Passed — deterministic locks, normalized items, keyset pagination, and bounded batches
- **Cache**: Passed — no correctness dependency; conditional scoped invalidation documented
- **Commands**: Passed — one registered handler owns execute and `undo()`; no parallel undo command/route exists
- **Risks**: Passed — critical partial-write, disclosure, concurrency, and unsafe-undo scenarios covered
- **Verdict**: Approved after narrowing the optional-consumer section to a generic Connect lineage contract; SLA-owned clock mutation was moved back to the SLA spec boundary

### Independent scope review — 2026-08-22

- **Initial finding**: Split — the draft prescribed both Connect reparenting and independently deployable SLA clock mutations.
- **Remediation**: Replaced clock-state instructions with generic lineage facts (`child_of_source`, `source_into_target`, `inverse_of_reparenting`); removed consumer-owned clock persistence, recovery, and outcome rules.
- **Final result**: Pass — the spec now covers one Connect-owned reparenting capability and its required outward event/read contract.

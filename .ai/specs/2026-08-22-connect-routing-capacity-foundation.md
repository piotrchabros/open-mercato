# Mercato Connect — Routing Capacity Foundation

## TLDR

**Key points:**

- Pre-create the `connect_routing` agent-presence storage needed by Phase 3 and initialize its derived `current_case_count` from Phase 1 Case ownership before routing can offer work.
- Keep the counter reconcilable rather than transactionally mirroring assignments: Connect owns a scoped count reader; `connect_routing` owns the persisted projection and idempotent backfill.

**Scope:**

- A minimal `connect_agent_presence` entity containing identity, live-state defaults, capacity defaults, and `current_case_count`.
- A Connect-owned, tenant-and-organization-scoped active-case count reader registered through DI.
- Enable-time, idempotent, bounded backfill and reconciliation worker primitives.

**Explicit non-goals:**

- No service queues, routing offers, assignment interception, capacity enforcement, presence heartbeat UI/API, wallboard, live channels, or automatic routing.
- No change to Phase 1 assignment behavior; until Phase 3, assignments remain unconstrained.

**Concern:** The table is intentionally deployed one phase before its behavioral owner. Its API and navigation remain absent, and its rows remain internal projections until Phase 3 activates routing.

## Overview

Issue #25 requires `current_case_count` to be backfilled in Phase 2 so Phase 3 cannot enable routing against zeroed capacity. Phase 1 already stores Case ownership in `connect_cases.assignee_user_id`, but no routing or presence entity exists. This specification establishes only the persistence and reconciliation boundary necessary to bridge that gap.

The design follows the derived-state pattern used by mature routing systems: workload is recomputed from authoritative work ownership and reconciled, not maintained as a fragile multi-module increment/decrement mirror. The `record_locks` participant model is a repository-local analogue for later heartbeat/TTL behavior, but this phase deliberately does not introduce presence liveness.

This is one independently deployable capability: preparing routing-owned capacity state from existing Connect assignments. It is separated from SLA and analytics because neither needs this storage to function, and separated from Phase 3 routing because offers and queues must not become active early.

## Problem Statement

Phase 1 can contain hundreds of assigned, active Cases when Phase 3 is enabled. Creating agent-presence rows with `current_case_count = 0` would make every agent appear empty and allow the first routing evaluation to over-push them. Updating a counter in every Phase 1 assignment transaction would instead couple `connect` to an optional future module and still drift after crashes, imports, repairs, or disabled-module periods.

The ownership boundary must therefore answer four questions:

1. Which Cases count as current work?
2. Which module computes the authoritative count?
3. Which module owns the persisted projection?
4. How does enablement converge safely while assignment traffic continues?

## Proposed Solution

Add a minimal `connect_routing` module that owns `connect_agent_presences`. Add an additive `connectCurrentCaseCountReader` DI service to `connect`; it groups active, non-deleted Cases by assignee within exactly one tenant and organization. During `connect_routing.setup.seedDefaults`, an idempotent reconciliation invokes that reader and upserts one presence row per returned agent. A routing-owned worker uses the same operation for explicit retries and later periodic reconciliation.

The backfill does not freeze assignments. Each run computes a fresh authoritative snapshot and performs scoped upserts in one transaction. A final run immediately before Phase 3 routing activation is a Phase 3 gate; offer evaluation must also recompute the candidate's count before making the first offer, as required by the app-spec invariant. This Phase 2 foundation reduces the enablement gap but does not claim to eliminate concurrency without the Phase 3 evaluation guard.

### Design Decisions

| Decision | Rationale |
|---|---|
| Storage belongs to `connect_routing` | `agent_presence.current_case_count` is a routing projection, even when its table ships early. Analytics must not own operational capacity. |
| Connect exposes a scoped DI reader | Connect owns Case semantics and storage. The consumer never imports or queries `ConnectCase` directly. |
| Active means `new`, `in_progress`, or `waiting_customer` | `resolved` and `closed` Cases are no longer current workload; soft-deleted Cases and null assignees never count. |
| Reconciliation replaces counts | Absolute recomputation is idempotent and repairs missed events; increments/decrements amplify drift. |
| No assignment subscriber in Phase 2 | A subscriber would imply near-live capacity semantics before routing exists. Phase 3 adds its own evaluation/reconciliation cadence. |
| No public route or page | Gated-off routing must expose no API/navigation surface; this phase is storage and setup only. |

### Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Store the counter in `connect_analytics` | Wrong domain ownership and creates a hard runtime dependency from routing to reporting. |
| Add `current_case_count` to each Case or user | The value is per agent and organization, and is derived from many Cases; a Case/user column cannot represent that grain. |
| Increment/decrement within assignment commands | Direct cross-module writes violate isolation and drift when the optional module is disabled or a write path is missed. |
| Wait until Phase 3 to create/backfill storage | Leaves the exact zero-count activation hazard that issue #25 requires Phase 2 to remove. |

## User Stories / Use Cases

- As an operator enabling Phase 2, I want existing assigned work reflected in routing capacity storage so later routing does not begin from zero.
- As an administrator rerunning setup after interruption, I want the same counts and no duplicate presence rows.
- As a Phase 3 routing evaluator, I want a routing-owned presence row and an authoritative Connect reader so I can reconcile before offering work.
- As a tenant with multiple organizations, I want sibling organizations and tenants to remain invisible to every count and reconciliation operation.

## Architecture

```text
connect.connect_cases
        |
        | scoped aggregate owned by Connect
        v
connectCurrentCaseCountReader (DI contract)
        |
        | soft-optional resolution by consumer
        v
connect_routing capacity reconciler
        |
        +--> setup.seedDefaults (enable-time attempt)
        +--> connect.routing_capacity.reconcile worker (retry/operator primitive)
        v
connect_agent_presences.current_case_count
```

### Module Boundaries

- `connect` owns the Case query and the definition of active Case status. It registers an additive DI key, `connectCurrentCaseCountReader`.
- `connect_routing` owns the entity, upsert/reconciliation transaction, queue, setup integration, and logs.
- `connect_routing` resolves the reader inside `try/catch`. If Connect is absent, setup records a structured warning and does not create misleading zero rows. It never declares a hard module dependency or imports Connect entities.
- No event is required in this phase because reconciliation is pull-based derived state. Phase 3 may add events for wake-up latency, but events cannot replace authoritative recomputation.

### DI Contract

```ts
type ConnectCurrentCaseCount = {
  assigneeUserId: string
  currentCaseCount: number
}

type ConnectCurrentCaseCountReader = {
  listByAssignee(input: {
    tenantId: string
    organizationId: string
  }): Promise<ConnectCurrentCaseCount[]>
}
```

The implementation uses a parameterized grouped query equivalent to:

```sql
select assignee_user_id, count(*)
from connect_cases
where tenant_id = :tenantId
  and organization_id = :organizationId
  and assignee_user_id is not null
  and deleted_at is null
  and status in ('new', 'in_progress', 'waiting_customer')
group by assignee_user_id
```

The existing `connect_cases_assignee_idx` supports the scope/assignee/status access pattern. If query planning shows the soft-delete predicate materially degrades the scan, an additive partial index may be introduced in the Connect migration; it is not required without evidence.

### Reconciliation Algorithm

1. Resolve `connectCurrentCaseCountReader`; if unavailable, return `dependency_unavailable` without writing.
2. Read grouped counts for one explicit tenant and organization.
3. In a routing-owned transaction, lock existing presence rows for that same scope.
4. Upsert returned assignees with their absolute counts, preserving all operator/live-state fields.
5. Set `current_case_count = 0` on existing scoped rows absent from the authoritative result.
6. Set `count_reconciled_at` and increment `count_generation` for every changed row.
7. Commit, then emit structured completion telemetry. A retry repeats the computation and converges.

The operation is serialized per `(tenant_id, organization_id)` using the platform's database/advisory-lock convention selected during implementation. It processes only one scope per job; no global reconciliation transaction is allowed.

## Data Models

### `ConnectAgentPresence` (table `connect_agent_presences`)

| Column | Type | Rules |
|---|---|---|
| `id` | UUID | Primary key, generated |
| `tenant_id` | UUID | Required scope |
| `organization_id` | UUID | Required authorization boundary |
| `user_id` | UUID | Logical auth user ID; no cross-module ORM relation |
| `status` | text | `offline` in Phase 2; reserved Phase 3 values `available`, `busy`, `away`, `offline` |
| `current_case_count` | integer | Required, default `0`, check `>= 0`; system-derived |
| `count_generation` | integer | Required, default `0`, check `>= 0`; increments on changed reconciliation |
| `count_reconciled_at` | timestamptz | Nullable until a successful scoped reconciliation |
| `created_at` | timestamptz | Required |
| `updated_at` | timestamptz | Required optimistic-lock/version timestamp for future user-editable presence state |
| `deleted_at` | timestamptz | Nullable soft-delete lifecycle |

Constraints and indexes:

- Unique `(tenant_id, organization_id, user_id)`.
- Index `(tenant_id, organization_id, status)` for future candidate lookup.
- Check `status in ('available', 'busy', 'away', 'offline')`.
- Check both count fields are non-negative.

Rows contain no PII, names, contact data, message content, or credentials. `user_id` is an authorization-sensitive logical identifier but does not require field encryption. Reads remain scoped and no public read exists in this phase.

### Projection Semantics

- A row may exist for an inactive/deleted user because Connect deliberately does not query peer auth storage. Phase 3 validates agent eligibility through its sanctioned auth/staff seam before routing.
- Unassigned Cases do not create a row and do not count.
- A Case transferred between agents is reflected on the next reconciliation; rerunning sets both absolute counts.
- Presence `status` is never inferred from Case ownership. All new rows remain `offline` until Phase 3 introduces authenticated liveness writes.

## API Contracts

No HTTP API is added in this phase. The only callable contract is the internal DI reader above and the routing worker payload:

```ts
const reconcileCapacityPayloadSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
})
```

Worker queue: `connect.routing_capacity.reconcile`.

Worker outcomes are structured internal results: `reconciled` with examined/created/updated/zeroed counts, `dependency_unavailable`, or a thrown retryable failure. Payload scope is validated with Zod before resolution or database access.

Any future HTTP trigger/status endpoint is Phase 3 scope and must export `metadata`, `openApi`, feature guards, mutation guards for writes, and organization-scoped responses.

## Access Control

No new ACL feature is exposed in Phase 2 because there is no user-facing route or action. Setup invokes reconciliation only for the organization supplied by the trusted module-setup context. Queue payloads are internal and still validate both UUID scopes.

Phase 3 will add routing feature keys under `connect_routing.<resource>.<verb>`; it must not reuse Phase 1's frozen `connect.metrics.*` keys or the analytics namespace.

## Internationalization and UI/UX

Not applicable. This phase adds no navigation, page, form, dialog, toast, or user-facing string. Consequently there is no client component, hydration surface, frontend bundle, or design-system change.

## Performance, Scheduling, and Operations

- Reader query cardinality is one row per assignee, not one row per Case; no N+1 lookup occurs.
- Each worker handles one organization. Large organizations may be processed in a single grouped scan; the subsequent upsert/zeroing work is batched at at most 500 rows per statement while retaining one transaction.
- `seedDefaults` performs the bounded reconciliation directly only when the scoped Case cardinality is below the implementation's measured foreground threshold. Above it, setup enqueues the scoped worker and reports initialization pending; the exact threshold is documented from benchmark evidence and must not exceed 1,000 mutated rows without worker use.
- Setup must not fail all tenant initialization solely because the reader, scheduler, or queue is unavailable. It logs the scope and dependency state without user IDs.
- Phase 2 does not register an endless periodic schedule. The worker exists for setup retry and explicit orchestration. Phase 3 owns the reconciliation cadence because only Phase 3 can define routing freshness SLOs.
- No cache is used. The count is safety-sensitive derived state, reads are infrequent in Phase 2, and cache invalidation would add a second stale projection.

Operational telemetry fields: tenant ID, organization ID, duration, authoritative-assignee count, created/updated/zeroed row counts, outcome, and error code. User IDs and Case IDs are excluded from logs.

## Migration & Backward Compatibility

- Add a new `connect_routing` module directory, table, indexes, queue worker, setup hook, DI registration, migration, and module snapshot. All are additive.
- Add the `connectCurrentCaseCountReader` DI registration to `connect`. DI keys become STABLE once published; its required method and fields cannot later be narrowed.
- Do not rename or remove existing Connect tables, columns, APIs, ACL IDs, event IDs, or metric formulas.
- The migration creates empty storage only; the setup/reconciliation path performs the idempotent data backfill. Do not encode cross-module `INSERT ... SELECT connect_cases` SQL in the migration because it would bypass module isolation and fail when Connect is absent.
- `yarn db:generate` is a diff probe. Keep only the intended migration and update `connect_routing/migrations/.snapshot-open-mercato.json`; never apply it with `yarn db:migrate` through automation.
- Rollback disables the new module/worker and leaves its table intact. Existing Connect behavior is byte-for-byte unchanged except for the additive read service.
- Phase 3 activation gate: every organization must have a successful reconciliation recorded after the latest Phase 2 migration, then offer evaluation recomputes the candidate count before its first offer. A missing/stale reconciliation fails routing closed; it never assumes zero.

## Testing Strategy and Integration Coverage

### Unit Tests

- Reader includes `new`, `in_progress`, and `waiting_customer`; excludes `resolved`, `closed`, soft-deleted, and unassigned Cases.
- Reconciler creates missing rows, updates changed absolute counts, zeroes absent assignees, preserves status and timestamps unrelated to count, and makes a second run a data no-op.
- Reader unavailable returns `dependency_unavailable` with no writes.
- Negative counts and invalid status/payload values fail validation/constraints.

### Integration Tests

- **CAP-INT-001:** two tenants and two organizations with the same user IDs prove grouped reads and writes cannot cross either boundary.
- **CAP-INT-002:** enable/setup against existing mixed-status Cases produces exact presence counts and `offline` rows.
- **CAP-INT-003:** rerunning setup and redelivering the worker job produces no duplicates; unique scope constraint holds.
- **CAP-INT-004:** transfer, resolve, reopen, close, soft-delete, and unassign Cases between reconciliations converge both old and new assignees.
- **CAP-INT-005:** failure after read/before commit changes nothing; failure after commit followed by retry converges without double counting.
- **CAP-INT-006:** concurrent jobs for one scope serialize; sibling scopes proceed independently.
- **CAP-INT-007:** Connect disabled/unregistered degrades explicitly and never creates zero rows that appear reconciled.
- **CAP-INT-008:** a large scoped fixture follows the worker/batching path within the benchmarked query and memory budget.
- **CAP-INT-009:** module decoupling test proves `connect_routing` has no Connect entity import, ORM relation, or hard module requirement.
- **CAP-INT-010:** Phase 3 activation-gate contract fails closed for missing/stale reconciliation and accepts a fresh completed generation.

There is no browser coverage because this specification adds no UI path. Integration fixtures create and clean up their own Cases and presence rows; they never rely on demo/seed data.

## Phasing

### Phase 1 — Authoritative Count Reader

1. Add the scoped Connect reader and pure active-status predicate.
2. Register the additive DI service and cover scope/status semantics.
3. Verify module decoupling and existing Connect behavior.

### Phase 2 — Routing-Owned Projection

1. Add the minimal presence entity, checks, indexes, migration, and snapshot.
2. Implement transactional absolute reconciliation with scoped serialization.
3. Add the validated worker and setup invocation/deferred path.

### Phase 3 — Verification and Activation Contract

1. Add isolation, concurrency, crash/retry, scale, and module-absence integration coverage.
2. Publish the internal freshness/activation result consumed by Phase 3 routing.
3. Run generation and the smallest complete validation gate.

## Implementation Plan

- **CAP-CON-01:** Create `connect/lib/current-case-count-reader.ts` with typed contract, grouped scoped query, and unit tests.
- **CAP-CON-02:** Register `connectCurrentCaseCountReader` additively in `connect/di.ts`; add module-decoupling coverage.
- **CAP-DATA-01:** Create `ConnectAgentPresence`, validators, intended SQL migration, indexes/checks, and snapshot.
- **CAP-REC-01:** Implement a routing-owned reconciliation service with per-scope serialization, transaction, absolute upsert/zeroing, generation, and structured result.
- **CAP-WRK-01:** Register `connect.routing_capacity.reconcile` with validated payload, bounded concurrency, retry-safe behavior, and structured logs.
- **CAP-SETUP-01:** Invoke/defer reconciliation from idempotent `seedDefaults`; absence of optional infrastructure is explicit and non-destructive.
- **CAP-TEST-01:** Ship CAP-INT-001 through CAP-INT-010 in the same change.
- **CAP-VAL-01:** Run `yarn generate`, the Connect workspace tests/typecheck/build, relevant integration tests, `yarn typecheck`, and `yarn lint`; probe migrations with `yarn db:generate` but do not apply them.

### File Manifest

| File | Action | Purpose |
|---|---|---|
| `packages/connect/src/modules/connect/lib/current-case-count-reader.ts` | Create | Connect-owned scoped aggregate contract/implementation |
| `packages/connect/src/modules/connect/lib/__tests__/current-case-count-reader.test.ts` | Create | Status and scope unit coverage |
| `packages/connect/src/modules/connect/di.ts` | Modify | Add stable reader registration |
| `packages/connect/src/modules/connect_routing/index.ts` | Create | Early module metadata with no UI/API |
| `packages/connect/src/modules/connect_routing/di.ts` | Create | Register presence entity and reconciliation service |
| `packages/connect/src/modules/connect_routing/setup.ts` | Create | Idempotent enable-time reconciliation/defer logic |
| `packages/connect/src/modules/connect_routing/data/entities.ts` | Create | Minimal routing-owned presence projection |
| `packages/connect/src/modules/connect_routing/data/validators.ts` | Create | Worker and internal input schemas |
| `packages/connect/src/modules/connect_routing/lib/reconcile-capacity.ts` | Create | Transactional absolute reconciliation |
| `packages/connect/src/modules/connect_routing/lib/queue.ts` | Create | Stable queue constant |
| `packages/connect/src/modules/connect_routing/workers/reconcile-capacity.ts` | Create | Scoped retryable worker |
| `packages/connect/src/modules/connect_routing/migrations/Migration*_connect_routing.ts` | Create | Additive table/index/check migration |
| `packages/connect/src/modules/connect_routing/migrations/.snapshot-open-mercato.json` | Create | Post-change module schema snapshot |
| `packages/connect/src/modules/connect_routing/**/__tests__/*` | Create | Unit tests |
| `.ai/qa/tests/connect-routing-capacity-foundation.spec.ts` | Create | Self-contained integration coverage |

## Risks & Impact Review

#### Assignment changes during reconciliation
- **Scenario**: A Case transfers after the reader snapshot but before the presence transaction commits, leaving the projection briefly stale.
- **Severity**: High
- **Affected area**: Future routing capacity decisions
- **Mitigation**: Absolute idempotent reruns, scoped serialization, required final reconciliation at Phase 3 activation, and mandatory recomputation during offer evaluation.
- **Residual risk**: Phase 2 rows may be temporarily stale because no routing decision consumes them yet; Phase 3 must enforce its freshness gate.

#### False zero when Connect is unavailable
- **Scenario**: Setup interprets a missing reader as no assigned Cases and writes zeros.
- **Severity**: High
- **Affected area**: All agents in the organization when routing later enables
- **Mitigation**: Distinct `dependency_unavailable` outcome, no writes, nullable reconciliation timestamp, and fail-closed Phase 3 activation.
- **Residual risk**: An operator must restore the dependency and rerun; structured telemetry exposes the scope.

#### Cross-organization count leakage
- **Scenario**: A grouped query or zeroing update omits organization scope and contaminates a sibling organization's capacity.
- **Severity**: Critical
- **Affected area**: Tenant isolation and future routing
- **Mitigation**: Required tenant and organization inputs, both predicates on every read/write/lock, scoped unique key, and CAP-INT-001/006 isolation tests.
- **Residual risk**: A future query could regress; same-change integration coverage and code review remain mandatory.

#### Duplicate or concurrent reconciliation
- **Scenario**: Setup and a retry worker run together and race on inserts or generation values.
- **Severity**: Medium
- **Affected area**: Presence projection integrity
- **Mitigation**: Scoped serialization, unique constraint, absolute values, single transaction, and retry tests.
- **Residual risk**: Lock timeout delays convergence but cannot create duplicate logical rows.

#### Large enable-time workload
- **Scenario**: A large organization blocks tenant setup or exhausts memory while materializing Cases.
- **Severity**: Medium
- **Affected area**: Deployment and tenant initialization
- **Mitigation**: Database-side grouped count, one result per assignee, measured foreground threshold, worker deferral, bounded batches, per-scope jobs.
- **Residual risk**: A pathological number of assignees can still make reconciliation slow; telemetry and retry isolate it to one organization.

#### Premature interpretation as live presence
- **Scenario**: A later caller treats Phase 2 `offline` rows and counts as proof of agent availability.
- **Severity**: High
- **Affected area**: Routing correctness
- **Mitigation**: No API/UI, status always `offline`, explicit module metadata/docs, and Phase 3 eligibility checks through sanctioned auth/staff presence seams.
- **Residual risk**: Direct database consumers can misuse internal tables; they are unsupported and Phase 3 tests pin the supported contract.

#### Migration or setup interruption
- **Scenario**: Schema creation succeeds but setup/backfill crashes midway.
- **Severity**: Medium
- **Affected area**: One organization's readiness
- **Mitigation**: Migration has no cross-module data copy, reconciliation is transactional and idempotent, and missing `count_reconciled_at` fails activation closed.
- **Residual risk**: Manual/automated retry is required; existing Connect inbox behavior remains unaffected.

## Final Compliance Report — 2026-08-22

### AGENTS.md Files Reviewed

- `AGENTS.md`
- `.ai/specs/AGENTS.md`
- `packages/core/AGENTS.md`
- `packages/core/src/modules/customers/AGENTS.md`
- `packages/cli/AGENTS.md`
- `BACKWARD_COMPATIBILITY.md`
- `.ai/skills/om-spec-writing/SKILL.md` and required checklist/template references

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|---|---|---|---|
| root AGENTS.md | No direct ORM relationships between modules | Compliant | Connect exposes a DI reader; routing owns scalar IDs and its entity |
| root AGENTS.md | Tenant and organization scoping | Compliant | Both are mandatory in every read, lock, upsert, zeroing update, and test |
| root AGENTS.md | Optimistic locking on new user-editable entities | Compliant | `updated_at` is present for future status edits; Phase 2 system writes are serialized |
| root AGENTS.md | Zod validation | Compliant | Worker/internal payload schema is explicit |
| root AGENTS.md | Preserve gated-off API/navigation behavior | Compliant | No page, route, or ACL surface ships |
| core AGENTS.md | DI and optional-module coupling | Compliant | Consumer soft-resolves an additive reader and degrades explicitly |
| core AGENTS.md | Commands/guards for user writes | N/A | No user-triggered mutation or API exists |
| customers AGENTS.md | Standard lifecycle/version columns | Compliant | Entity includes UUID, scope, timestamps, and soft deletion |
| CLI AGENTS.md | Generated discovery and migration snapshots | Compliant | New conventional files run through generation; intended migration and snapshot only |
| BACKWARD_COMPATIBILITY.md | Database schema additive-only | Compliant | New table/indexes/checks only |
| BACKWARD_COMPATIBILITY.md | DI keys are stable | Compliant | New reader key and contract are declared additive and stable |
| root Design System/UI rules | Canonical UI, i18n, accessibility | N/A | No UI or user-facing string |

### Internal Consistency Check

| Check | Status | Notes |
|---|---|---|
| Data model matches reconciliation contract | Pass | One scoped row per user holds absolute derived count and freshness metadata |
| API contracts match UI/UX | Pass | Neither API nor UI is introduced |
| Risks cover all write operations | Pass | Concurrent, interrupted, absent-dependency, migration, and scale cases covered |
| Commands defined for all mutations | Pass | System-only reconciliation service/worker owns the sole mutation; no user command exists |
| Cache strategy covers reads | Pass | Explicit no-cache decision avoids stale safety data |
| Scope is independently deployable | Pass | One capacity-foundation capability; offers/queues/live presence remain Phase 3 |

### Non-Compliant Items

None.

### Verdict

- **Fully compliant**: Approved — ready for pre-implementation audit.

## Changelog

### 2026-08-22

- Initial implementation-ready specification: routing-owned presence storage, Connect-owned scoped count reader, idempotent enable-time reconciliation, and explicit exclusion of Phase 3 routing behavior.

### Review — 2026-08-22

- **Reviewer**: Agent; scope-cohesion adversarial review still required by the spec workflow before implementation.
- **Security**: Passed — mandatory dual scope and no PII/public surface.
- **Performance**: Passed — grouped query, bounded per-scope work, thresholded worker deferral.
- **Cache**: Passed — no-cache safety decision.
- **Commands**: Passed — one system reconciliation operation; no user writes.
- **Risks**: Passed — concurrency, drift, absence, isolation, scale, and deployment covered.
- **Verdict**: Approved for pre-implementation audit after independent scope-cohesion review.

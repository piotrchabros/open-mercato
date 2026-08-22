# Pre-Implementation Analysis: Mercato Connect — Case Reparenting Contract

## Executive Summary

The remediated specification is ready for implementation, subject to maintainer approval of its new frozen identifiers. Its public surfaces remain additive, and the revised design now coordinates reparenting with inbound through a shared Conversation lock and Conversation-first attach rule, serializes all Case numbers through one scope sequence, uses one registered `CommandHandler` with canonical `undo()`/`extractUndoPayload`, and defines exact bounded persistence, API, event, DI, downstream-consumer, migration, and test contracts.

This re-audit verified the revised text against the actual Phase 1 Connect entities, commands, APIs, events, outbox, DI, encryption map, migrations, tests, command-bus undo contract, and all thirteen `BACKWARD_COMPATIBILITY.md` categories. No implementation code was used as evidence; readiness means the contract is implementable and internally consistent, not that code exists.

## Evidence Reviewed

- Target spec: `.ai/specs/2026-08-22-connect-case-reparenting-contract.md`
- Compatibility contract: `BACKWARD_COMPATIBILITY.md`
- Guides: root `AGENTS.md`, `.ai/specs/AGENTS.md`, `packages/core/AGENTS.md`, `packages/cli/AGENTS.md`, `.ai/qa/AGENTS.md`, `.ai/docs/module-development.md`
- Actual Connect source: `data/entities.ts`, `data/encryption.ts`, `data/extensions.ts`, `data/enrichers.ts`, `events.ts`, `di.ts`, `acl.ts`, `setup.ts`, all Case APIs, ingest/assign/transition/outbound commands, lifecycle helpers, domain outbox, migrations, and current tests
- Command reference: `packages/shared/src/lib/commands/{types,undo,registry,command-bus}.ts` and Customers command implementations
- Matching lessons only: stale migration snapshots, duplicate migrations, concurrent-index recovery, flush-before-query, centralized `extractUndoPayload`, enqueue-then-stamp, and ACL setup grants
- Requested code-review checklist path `.agents/skills/om-code-review/references/review-checklist.md` is absent in this checkout; no substitute checklist was invented. The pre-implement skill, spec-writing checklist, and repository guides were applied directly.

## Backward Compatibility

### Violations Found

No removal, rename, narrowing, or semantic repurposing of an existing contract is proposed. All new surfaces are additive and fully inventoried; maintainer review is still required before their first release because they become frozen/stable contracts immediately.

| # | Surface | Issue | Severity | Proposed Fix |
|---|---|---|---|---|
| 1 | Auto-discovery file conventions | Additive recognized paths; one registered handler is explicitly required and generated discovery is verified. | None | Preserve existing conventions and run `yarn generate`. |
| 2 | Type definitions & interfaces | Exact event, facade, cursor/page, snapshot, item, undo, and result contracts are additive. | None | Freeze only after maintainer review. |
| 3 | Function signatures | Exact `CommandHandler`, `undo()`, and DI reader signatures are specified additively. | None | Preserve after release. |
| 4 | Import paths | No existing path moves; facade is DI-only and types remain module-local unless a later explicit export is added. | None | No bridge required. |
| 5 | Event IDs | Three additive non-colliding IDs; version, inverse reference, and required fields are exact. | None | Preserve payload fields after release. |
| 6 | Widget injection spot IDs | No widget or spot ID is changed or added. | None | N/A. UI is deferred. |
| 7 | API route URLs | Additive non-colliding routes with exact schemas; existing Case responses gain nullable lineage keys without removing fields. | None | Preserve URLs/keys after release. |
| 8 | Database schema | Additive columns/tables/constraints with exact V1 schemas, sequence seed, duplicate-binding preflight, and safe DDL order. | None | Keep existing status/table/column meanings unchanged. |
| 9 | DI service names | Additive non-colliding `connectCaseReparentingReader` with exact DI-only projection contract and absent-module tests. | None | Preserve key/semantics after release. |
| 10 | ACL feature IDs | Four additive IDs do not collide with current Connect features and setup grants are planned. | None | Run the idempotent ACL sync for existing tenants and test wildcard grants. |
| 11 | Notification type IDs | No notification types are proposed. | None | N/A. |
| 12 | CLI commands | No CLI command is proposed or changed. | None | N/A. |
| 13 | Generated file contracts | No generated export is renamed; new registrations are additive. | None | Run `yarn generate`, inspect registries/module facts, and refresh standalone harness coverage. |

### Missing BC Section

The specification contains a substantive `Migration & Backward Compatibility` section, exact type/DI boundary decisions, existing Case response additions, and a public-surface inventory. It is not missing.

## Spec Completeness

### Missing Sections

None of the mandatory top-level sections is absent. UI is explicitly and reasonably deferred; a Frontend Architecture Contract is N/A for this API-only change.

### Incomplete Sections

None remain after remediation. Mandatory sections and implementation contracts are complete; optional UI remains explicitly deferred.

## AGENTS.md Compliance

### Violations

None remain in the revised specification. Implementation must follow the specified command registration/undo extraction, Conversation locking, atomic flush ordering, reason-only encryption, setup grants, and isolated integration tests.

## Actual-Code Findings

### Resolved Critical Finding 1 — Reparenting controls the next inbound attachment

`ingest-inbound-message.ts` makes its attach decision under a pessimistic lock on `ConnectIdentityCaseBinding` (`currentCaseId`, `version`). It does not lock or consult `ConnectConversation.currentCaseId` when selecting the Case. Only after the Case transaction commits does `upsertConversation()` update the Conversation pointer and binding interval.

The proposed reparent command locks `ConnectConversation` and `ConnectConversationCaseBinding`, but not the identity binding. Consequently:

1. A split can move Conversation C from source A to child B.
2. The contact identity still points to A.
3. The next inbound for C selects A under the identity lock.
4. `upsertConversation()` moves C back to A and closes the split binding, silently defeating the correction.

**Resolution verified in the revised spec:** ingest and reparent now share a scoped `ConnectConversation` write lock; an existing live Conversation's `currentCaseId` wins over the identity binding; pointer/binding/receipt/Case/outbox writes move into one transaction; a partial split does not rewrite the identity binding. The spec also defines lock order and tests both the first inbound after split and a new Conversation for the same identity.

### Resolved Critical Finding 2 — Case numbering is serialized

`nextCaseNumber()` currently has the recorded race. **Resolution verified in the revised spec:** `ConnectCaseNumberSequence` is uniquely scoped by tenant/organization; a parameterized upsert plus `FOR UPDATE` allocator is the sole writer for both inbound open and split; migration seeds with the greater existing maximum; unique Case number remains the final invariant; concurrency and migration tests are explicit.

### Resolved Critical Finding 3 — Undo uses the platform command model

**Resolution verified in the revised spec:** only `connect.case.reparent` is registered; APIs use `commandBus`; `buildLog` persists a bounded `ReparentUndoPayload`; `undo()` uses `extractUndoPayload`, performs Connect ACL/scope/fingerprint checks, and appends the inverse audit; the existing audit-log undo URL is the sole HTTP path; no second command or route exists; redo explicitly rejects.

### Resolved Critical Finding 4 — Undo snapshot/fingerprint schema is exact

The revised spec enumerates `ReparentCaseSnapshotV1`, `ReparentItemSnapshotV1`, and `ReparentUndoPayload`, bounds parent snapshots to 4 KiB, normalizes unbounded items, defines pre/post version fields, and specifies canonical plaintext fingerprint inputs/exclusions. Sensitive free-text `reason` alone is encrypted; snapshots exclude PII and remain deterministic.

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Split is undone by next inbound due to identity-binding authority | Incorrect conversation grouping returns immediately; possible customer disclosure | Define a shared conversation-aware attach override/lock contract across ingest and reparent, then test true races and subsequent inbound behavior. |
| Duplicate Case number race | Split or inbound fails with unique violation under normal concurrency | Replace `max+1` with an atomic shared allocator and retry-safe transaction behavior. |
| Ambiguous undo mechanism | Audit UI may expose unsafe or broken undo; permissions can diverge | Use one registered command/undo contract and central `extractUndoPayload`, or explicitly suppress generic undo and document the sole guarded inverse route. |
| Wrong-customer supervisory override | Authorized mistake exposes another customer's thread | Keep dedicated override feature, require reason, minimize visibility, and make safe undo immediately available. Consider whether override should be excluded from MVP. |
| Large merge lock duration | Inbound/reply actions on affected Cases block or time out | Measure actual cardinality; lock deterministically; consider a documented hard bound or prepared background workflow rather than an unbounded interactive transaction. |
| Active-binding migration encounters existing duplicates | New partial unique index cannot be created | Migration preflight aborts with an actionable error; remediate duplicates before retry-safe index creation. |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Child `channelId` copied from unrelated source origin | Incorrect filtering/reporting and reply context | Derive from selected Conversations using a specified deterministic rule. |
| Opaque encrypted JSON snapshots | Schema drift, hard-to-query undo, oversized ciphertext | Define typed, versioned, bounded snapshot structure; store scalar undo tokens where possible. |
| Existing Case/inbox reads expose stale canonical state if implementation misses a call site | Operators open a merged historical Case without knowing target | Required impact matrix and `REP-INT-012` cover Case, Inbox, thread, reply, and access commands. |
| Optional consumer reconciliation lags | Derived state temporarily misses lineage | Versioned events include inverse reference and stable source ID; exact keyset facade supports recovery. |
| Existing customer-context metrics count merged source | Open/resolved counts can double-count or misstate latest status | Required impact matrix excludes merged sources from active context without rewriting immutable Phase 1 facts; integration coverage pins behavior. |
| Migration index creation on a populated binding table | Existing duplicate active bindings can make migration fail | Add a preflight query/remediation and retry-safe index migration; do not rely on `IF NOT EXISTS` after an interrupted concurrent build. |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| No UI in first increment | API exists without an operator surface | Accept only if the issue/spec explicitly allows API-first delivery; otherwise create a separate UI spec. |
| Direct reads without cache | Supervisory audit queries add database load | Existing indexes/keyset pagination are sufficient initially; measure before caching. |
| New generated registry entries | Standalone package discovery may drift | Run generation, package build, module facts, and standalone harness coverage. |

## Gap Analysis

### Critical Gaps (Block Implementation)

None remain after remediation.

### Important Gaps (Should Address)

None remain in the implementation contract. The revised spec defines the item entity/indexes, active-binding constraint/preflight, child channel/timestamp/customer rules, all existing reader/metrics/projection effects, exact API/event/DI types, reason-only encryption/decryption, thirteen isolated TC files, and a corrected compliance review.

### Nice-to-Have Gaps

- Define non-PII structured metrics for lock wait, operation duration, moved count, conflicts, unsafe undo, and consumer reconciliation lag.
- Add an operator-facing UI successor spec if API-only delivery is not independently useful.
- Document a measured threshold at which merge should move from an interactive transaction to a prepared/background workflow.

## Remediation Plan

### Before Implementation (Must Do)

1. **Maintainer contract approval**: approve the additive command, event, API, DI, ACL, entity, and schema identifiers before their first release.

### During Implementation (Add to Spec)

1. Record actual migration/snapshot names and review only intended SQL; do not apply migrations locally without approval.
2. Record generator outputs and the chosen local/Docker validation runner.
3. Add true PostgreSQL concurrency tests rather than mocked lock assertions.
4. Create one integration test file per scenario with API-created fixtures and `finally` cleanup.
5. Verify absence of Connect consumers and duplicate persistent event delivery.

### Post-Implementation (Follow Up)

1. Add the operator UI only through a separately scoped, DS-reviewed successor if still desired.
2. Measure merge cardinality/lock latency before introducing background preparation.
3. Update changelog with implementation evidence; move to `implemented/` only after deployment evidence and maintainer approval.

## Re-Audit Closure Matrix

| Original blocker / important gap | Revised spec evidence | Status |
|---|---|---|
| Identity-binding/inbound race | Authoritative Conversation-first attach, shared Conversation lock, atomic ingest transaction, explicit identity-binding semantics and race tests | Resolved |
| Case number race | `ConnectCaseNumberSequence`, shared allocator, safe seed migration, concurrent allocation tests | Resolved |
| Parallel/noncanonical undo | One registered `connect.case.reparent` handler, `buildLog`, `extractUndoPayload`, handler `undo()`, existing audit-log URL only, redo rejection | Resolved |
| Vague snapshots/fingerprint | Exact V1 types, normalized items, bounds, canonical fingerprint inputs and exclusions | Resolved |
| Downstream behavior | Explicit Case/Inbox/thread/reply/customer-context/metrics/projection/auto-close/search/ingest matrix | Resolved |
| Child channel derivation | Earliest selected Conversation by `(createdAt,id)` | Resolved |
| Encryption ambiguity | Reason-only encryption map; PII-free deterministic snapshots; scoped decrypted detail read | Resolved |
| API/event/DI incompleteness | Exact facade types, inverse reference, request/response/error/cursor contracts, additive Case projections | Resolved |
| Integration granularity | Thirteen separate `TC-CONNECT-REP` files plus module-local fixtures and cleanup | Resolved |

## Recommendation

**Ready to implement after maintainer approval of the new frozen contract identifiers.** All original blockers and important gaps are resolved in the specification, all thirteen backward-compatibility categories remain additive, and remaining items are implementation evidence/validation tasks rather than design gaps.

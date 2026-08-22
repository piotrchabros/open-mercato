# Pre-Implementation Analysis: Mercato Connect — Case Reparenting Contract

## Executive Summary

The specification is not ready to implement. Its additive public surfaces are broadly backward-compatible, but three critical design gaps remain: reparenting does not coordinate with the identity-binding lock that actually decides future inbound attachment; child Case numbering reuses the existing unlocked `max(number)+1` allocator and can race inbound creation; and the proposed undo endpoint is not integrated with the platform command/undo contract. Several important contract details—exact undo snapshots, audit encryption/query behavior, integration test granularity, and merged/split read projections—also need to be made implementation-exact before code begins.

Recommendation: update the specification first, rerun this audit, and only then enter implementation. This report verified the actual Phase 1 Connect entities, commands, APIs, events, outbox, DI, encryption map, migrations, tests, and all thirteen `BACKWARD_COMPATIBILITY.md` categories.

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

No removal, rename, narrowing, or semantic repurposing of an existing contract is proposed. The new surfaces are additive, but the warnings below must be resolved before their first release because they become frozen/stable contracts immediately.

| # | Surface | Issue | Severity | Proposed Fix |
|---|---|---|---|---|
| 1 | Auto-discovery file conventions | New routes/entities/events/commands use recognized locations, but the spec never states how command files are auto-loaded and registered with `registerCommand`. A plain exported function, as several current Connect commands use, does not satisfy the proposed public command IDs by itself. | Warning | Specify command-handler exports/registration using the canonical registry and verify `yarn generate` discovers the files. |
| 2 | Type definitions & interfaces | `ConnectCaseReparentingEvent`, reader projections, cursor/page types, snapshot shapes, item projections, and result unions are described but not fully defined. The facade text still says `clock instruction` although the event was narrowed to `lineageInstruction`. | Warning | Define exact exported structural types, field optionality, cursor encoding, error unions, and use `lineageInstruction` consistently before freezing. |
| 3 | Function signatures | The DI facade signatures refer to undefined `Scope`, `ReparentingProjection`, `ReparentingCursor`, `ReparentingPage`, and `CaseLineageProjection`. Command handler signatures/context and undo handler signature are not specified. | Warning | Add exact TypeScript contracts and handler signatures, including command runtime context and undo log entry. |
| 4 | Import paths | No existing import moves are proposed. New public types/facade imports are not assigned stable package export paths. | Warning | Name the intended `@open-mercato/connect/...` export paths or explicitly keep the contract DI-only and non-importable. Do not move them after release without bridges. |
| 5 | Event IDs | Three additive IDs do not collide with current `connect/events.ts`. Payload versioning is present, but payload optionality and undo reference (`reversesReparentingId`) are not included in the declared event type. | Warning | Add the missing inverse reference and exact per-event schemas; freeze fields only after consumer review. Existing event IDs remain unchanged. |
| 6 | Widget injection spot IDs | No widget or spot ID is changed or added. | None | N/A. UI is deferred. |
| 7 | API route URLs | Five additive routes do not collide with current Connect routes. Response schemas are prose-only, and the existing `/api/connect/cases` and `/api/connect/inbox` projections are not updated to expose merged/split state despite the promise that historical sources remain understandable. | Warning | Add exact zod/OpenAPI response schemas and specify additive lineage fields or redirect/canonical-target fields on existing Case reads. Preserve all existing response keys. |
| 8 | Database schema | Changes are additive, but `source_before`/`destination_before` schemas, item-table columns/constraints, active-binding uniqueness, and deployment-safe DDL are incomplete. | Warning | Specify full entities/checks/indexes, including one-active-binding enforcement and exact migration order. Keep existing tables/columns/status meanings intact. |
| 9 | DI service names | `connectCaseReparentingReader` is additive and does not collide with current `connectCapabilityReporter` or entity keys. Its semantics are not complete enough to freeze. | Warning | Define complete projection/error/authorization semantics and add DI collision/disabled-module tests before first release. |
| 10 | ACL feature IDs | Four additive IDs do not collide with current Connect features and setup grants are planned. | None | Run the idempotent ACL sync for existing tenants and test wildcard grants. |
| 11 | Notification type IDs | No notification types are proposed. | None | N/A. |
| 12 | CLI commands | No CLI command is proposed or changed. | None | N/A. |
| 13 | Generated file contracts | No generated export is renamed. New entities/routes/events/ACL/DI registrations will alter generated registries additively. | Warning | Run `yarn generate`; inspect generated registries and module facts; never hand-edit generated output. Refresh standalone harness coverage if the public extension/contract inventory requires it. |

### Missing BC Section

The specification contains a substantive `Migration & Backward Compatibility` section and a public-surface inventory. It is not missing. It should be expanded with the exact type/import-path decisions and existing Case response additions described above.

## Spec Completeness

### Missing Sections

None of the mandatory top-level sections is absent. UI is explicitly and reasonably deferred; a Frontend Architecture Contract is N/A for this API-only change.

### Incomplete Sections

| Section | Gap | Recommendation |
|---|---|---|
| Architecture — inbound coordination | Actual ingest chooses a Case while holding `ConnectIdentityCaseBinding`, then updates `ConnectConversation` afterward. The reparent design locks Conversations/bindings only and falsely states this serializes with inbound. | Define a shared serialization point and attach rule for reparenting. See Critical Gap 1. |
| Architecture — number allocation | Split creates a new numbered Case but does not address the existing `max(number)+1` allocator in `ingest-inbound-message.ts`, which is not serialized and is protected only by a unique constraint. | Introduce/reuse an atomic per-organization sequence allocator shared by ingest and split, with retry semantics. |
| Commands & undo | Two function-like commands are named, but there is no `registerCommand`, `CommandHandler`, `UndoPayload`, `extractUndoPayload`, audit-log undo/redo policy, or explicit no-redo decision. | Specify canonical command-bus handlers. Either make the reparent command's `undo()` use the central payload or document why the domain inverse route is separate and how audit undo is disabled without creating two undo paths. |
| Data Models | `source_before`, `destination_before`, and `ConnectCaseReparentingItem` lack exact typed schemas; no maximum snapshot size; no CHECK tying operation to reversal fields; no unique active binding constraint. | List every persisted property and constraint. Prefer typed scalar snapshot columns where possible over opaque JSON. |
| Case lifecycle | Split child copies the source `channelId`, but a Case may contain Conversations from several channels. The selected child may not originate on that channel. | Define channel derivation (for example earliest selected Conversation) or make the field nullable/add a tested invariant; do not copy an unrelated channel. |
| API Contracts | Requests are mostly prose and success/error response bodies lack exact schemas. `allowCustomerMismatch` behavior differs between split (where child necessarily shares source snapshot) and merge. | Provide zod schemas per route, remove irrelevant split override input, and specify standard conflict bodies exactly. |
| Encryption | The spec encrypts reason and JSON snapshots but does not state how canonical idempotency fingerprints are computed relative to encryption, nor whether snapshots contain PII. | Minimize snapshots to non-PII scalar lifecycle fields; encrypt only required free text. Compute the fingerprint from canonical validated plaintext before encryption and never log it with payload content. |
| Testing | Eleven behaviors are packed into one proposed Playwright file, contrary to the QA convention of one scenario per test file. There is no fixture-helper manifest or route activation metadata. | Split into `TC-CONNECT-REP-001...` files, add module-local fixtures/cleanup and discovery metadata as needed. |
| Operational detection | Risks mention metrics/logging but define no concrete logger fields, latency metric, reconciliation signal, or operator query for stuck consumers. | Define non-PII structured diagnostics and measurable thresholds, or explicitly defer observability with an owner. |
| Final Compliance Report | It says fully compliant although canonical command undo and the actual inbound serialization seam are unresolved. | Change verdict to blocked until critical remediation is incorporated and independently re-audited. |

## AGENTS.md Compliance

### Violations

| Rule | Location | Fix |
|---|---|---|
| Domain writes use canonical commands; undoable commands reuse `extractUndoPayload` | Proposed Solution, Commands, File Manifest | Define registered `CommandHandler`s and central `UndoPayload` extraction, or explicitly declare the command non-audit-undoable and make the guarded inverse command the only undo surface with rationale. Avoid two competing undo mechanisms. |
| Preserve real call-site behavior and find root cause | Architecture / concurrency test claim | Reparent and ingest do not share the asserted lock. Update the attach algorithm and both call sites, not just the test. |
| Every query after scalar mutation must respect atomic-flush rules | Deterministic locking step 5 says flush once “where practical” | State the exact flush/query ordering. Reparenting performs multiple reads after Case/Conversation scalar changes; use `withAtomicFlush`, explicit flush boundaries, or raw conditional writes consistent with Core guidance. |
| Integrations tests are self-contained and one scenario per `.spec.ts` | File Manifest / Testing Strategy | Replace the single `case-reparenting.spec.ts` with separately named TC files and module-local helpers; create/cleanup every fixture in `finally`. |
| Encryption maps and decrypted reads must be implementation-exact | Sensitive data | Define exact entity property/map field names and all encrypted read paths, including list/detail facade projections and command undo reads. |
| Existing and new default-role feature gates must match setup grants | Access Control | Planned correctly; add setup/ACL sync tests and explicitly run `auth sync-role-acls` after implementation. |
| Backward-compatible public contracts must be complete before first ship | Public surfaces | Resolve undefined facade/event/API types before freezing IDs and paths. |

## Actual-Code Findings

### Critical Finding 1 — Reparenting does not control the next inbound attachment

`ingest-inbound-message.ts` makes its attach decision under a pessimistic lock on `ConnectIdentityCaseBinding` (`currentCaseId`, `version`). It does not lock or consult `ConnectConversation.currentCaseId` when selecting the Case. Only after the Case transaction commits does `upsertConversation()` update the Conversation pointer and binding interval.

The proposed reparent command locks `ConnectConversation` and `ConnectConversationCaseBinding`, but not the identity binding. Consequently:

1. A split can move Conversation C from source A to child B.
2. The contact identity still points to A.
3. The next inbound for C selects A under the identity lock.
4. `upsertConversation()` moves C back to A and closes the split binding, silently defeating the correction.

This also invalidates the proposed test claim that “identity/conversation locks serialize.” The spec must choose and implement one authoritative rule. Options include adding a conversation-first attach decision under a shared lock, or defining a per-Conversation routing/reparent override consulted by ingest. Updating the one identity binding to B is unsafe when the same identity legitimately owns Conversations remaining in A.

### Critical Finding 2 — Split Case numbering races the existing inbound allocator

`nextCaseNumber()` currently executes `select coalesce(max(number), 0) + 1` without a scope-level lock or sequence. `connect_cases_number_uq` prevents duplicates but does not retry them. A split and an inbound open in the same organization can allocate the same number, causing one valid operation to fail unpredictably. Reparenting cannot become implementation-ready without a single atomic allocator used by both paths (for example a locked organization-scoped sequence row/numbering service) and a real concurrency test.

### Critical Finding 3 — Undo contract conflicts with the platform command model

The spec calls `connect.case.reparent.undo` a separate command and action route, but does not define `registerCommand`, command-bus execution, `UndoPayload`, `extractUndoPayload`, `undo()`/`redo()`, or how the audit-log generic undo route treats `connect.case.reparent`. This creates the possibility of two undo paths with different authorization and TOCTOU behavior, or a public command ID that is never registered. The spec must select one canonical model and test its audit/undo authorization and conflict semantics.

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Split is undone by next inbound due to identity-binding authority | Incorrect conversation grouping returns immediately; possible customer disclosure | Define a shared conversation-aware attach override/lock contract across ingest and reparent, then test true races and subsequent inbound behavior. |
| Duplicate Case number race | Split or inbound fails with unique violation under normal concurrency | Replace `max+1` with an atomic shared allocator and retry-safe transaction behavior. |
| Ambiguous undo mechanism | Audit UI may expose unsafe or broken undo; permissions can diverge | Use one registered command/undo contract and central `extractUndoPayload`, or explicitly suppress generic undo and document the sole guarded inverse route. |
| Wrong-customer supervisory override | Authorized mistake exposes another customer's thread | Keep dedicated override feature, require reason, minimize visibility, and make safe undo immediately available. Consider whether override should be excluded from MVP. |
| Large merge lock duration | Inbound/reply actions on affected Cases block or time out | Measure actual cardinality; lock deterministically; consider a documented hard bound or prepared background workflow rather than an unbounded interactive transaction. |
| Missing exact active-binding constraint | Bugs can create two open intervals for one Conversation | Add a partial unique index on scoped Conversation where `unbound_at IS NULL`, after checking/backfilling existing duplicates. |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Child `channelId` copied from unrelated source origin | Incorrect filtering/reporting and reply context | Derive from selected Conversations using a specified deterministic rule. |
| Opaque encrypted JSON snapshots | Schema drift, hard-to-query undo, oversized ciphertext | Define typed, versioned, bounded snapshot structure; store scalar undo tokens where possible. |
| Existing Case/inbox reads hide canonical lineage | Operators open a merged historical Case without knowing target | Add stable additive fields/lineage links to existing Case projections or an explicit canonical response. |
| Event contract incompleteness | Optional consumers cannot reconcile undo deterministically | Include `reversesReparentingId`, exact event-specific required fields, and reconciliation cursor semantics. |
| Existing customer-context metrics count merged source | Open/resolved counts can double-count or misstate latest status | Audit `readCustomerContexts`, operational metrics, projection, auto-close, inbox, and cases queries for `mergedIntoCaseId`; define whether historical merged sources are excluded. |
| Migration index creation on a populated binding table | Existing duplicate active bindings can make migration fail | Add a preflight query/remediation and retry-safe index migration; do not rely on `IF NOT EXISTS` after an interrupted concurrent build. |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| No UI in first increment | API exists without an operator surface | Accept only if the issue/spec explicitly allows API-first delivery; otherwise create a separate UI spec. |
| Direct reads without cache | Supervisory audit queries add database load | Existing indexes/keyset pagination are sufficient initially; measure before caching. |
| New generated registry entries | Standalone package discovery may drift | Run generation, package build, module facts, and standalone harness coverage. |

## Gap Analysis

### Critical Gaps (Block Implementation)

- **Future inbound ownership after split/merge**: define the authoritative conversation-aware attach rule, its persisted override/lineage state, and a lock shared with ingest.
- **Atomic Case number allocation**: specify and use one allocator for both inbound `openCase()` and split child creation.
- **Canonical command/undo integration**: define registered handlers, command-bus invocation, central undo payload extraction, audit visibility, redo policy, and one authorization path.
- **Exact undo snapshot/fingerprint schema**: enumerate all fields and postconditions needed to prove safe undo; “lifecycle snapshot” is not implementable enough.

### Important Gaps (Should Address)

- Add exact `ConnectCaseReparentingItem` entity definition and active-binding uniqueness constraint.
- Define channel/customer/timestamp derivation for a child from selected Conversations.
- Define how merged sources affect Inbox, Case reads, customer context, metrics, projections, auto-close, search, and reply eligibility.
- Add exact zod/OpenAPI request/response/error schemas and `reversesReparentingId` to the event/facade contract.
- Reconcile encryption-map property names and decrypted read paths; minimize encrypted JSON.
- Split integration coverage into independently discoverable module-local TC files with helpers and cleanup.
- Correct the spec's Final Compliance verdict after remediation.

### Nice-to-Have Gaps

- Define non-PII structured metrics for lock wait, operation duration, moved count, conflicts, unsafe undo, and consumer reconciliation lag.
- Add an operator-facing UI successor spec if API-only delivery is not independently useful.
- Document a measured threshold at which merge should move from an interactive transaction to a prepared/background workflow.

## Remediation Plan

### Before Implementation (Must Do)

1. **Repair the aggregate boundary**: design the Conversation-specific post-reparent attach rule and update the ingest/reparent lock order so a later inbound cannot reverse a split.
2. **Specify atomic numbering**: introduce a shared organization-scoped Case number allocator and include both split-vs-open and open-vs-open concurrency tests.
3. **Choose one undo architecture**: integrate with `registerCommand`/`UndoPayload`/`extractUndoPayload`, or explicitly make generic audit undo unavailable and justify the sole domain inverse command.
4. **Complete persistence schemas**: define every reparenting/item/snapshot field, check, unique/partial index, encryption field, and migration preflight.
5. **Audit existing consumers**: state exact behavior for cases/inbox/customer-context/metrics/projections/auto-close/reply/search when `mergedIntoCaseId` or `splitFromCaseId` is set.
6. **Complete public contracts**: exact exported types, DI signatures, event payloads, API schemas, response additions, and stable import paths.
7. **Change readiness verdict and rerun pre-implementation analysis**.

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

## Recommendation

**Needs spec updates first.** The public additions are compatible in principle, but implementation must not begin until the inbound ownership, number allocation, undo architecture, and exact persistence contracts are resolved and the revised spec passes a fresh readiness audit.

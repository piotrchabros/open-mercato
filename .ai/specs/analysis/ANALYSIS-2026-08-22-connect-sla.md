# Pre-Implementation Analysis: Mercato Connect — SLA and Business Calendars

## Executive Summary

**Ready after named maintainer approval and implementation of the Connect source-facts and reparenting prerequisites.** After the owner-selected split, this spec is cohesive: `connect_sla` alone owns calendars, policies, clocks, due/rebuild workers, APIs and optional UI. It consumes exact external facts without importing or modifying Connect/Auth persistence.

Verified against actual Connect facades/events absence, the new source-contract spec, reparenting contract, repository guides, matching lessons and all thirteen BC categories. The canonical code-review checklist path is absent; no substitute was invented. No code was changed.

## Backward Compatibility

### Violations Found

None. All consumer surfaces are additive and require approval before release.

| # | Surface | Result |
|---:|---|
| 1 | Discovery | Additive `connect_sla` module/files; generate/disable/decoupling tests. |
| 2 | Types | Additive exact states, calendar/policy and event contracts. |
| 3 | Signatures | New commands/readers only; no existing narrowing. |
| 4 | Imports | No moves; DI/scalar peer boundary. |
| 5 | Events | Seven additive SLA IDs; source IDs belong to prerequisite. |
| 6 | Widget | Additive named Inbox host/DTO. |
| 7 | API | Additive policy/calendar/clock/rebuild URLs. |
| 8 | DB | Additive SLA-owned schema only. |
| 9 | DI | Additive SLA services; Connect reader is prerequisite. |
| 10 | ACL | Six additive IDs plus setup synchronization. |
| 11 | Notification | None; warnings presentation-only. |
| 12 | CLI | None. |
| 13 | Generated | Additive registries; narrow diff/harness refresh. |

### Missing BC Section

Not missing. The spec separates prerequisite surfaces, inventories all thirteen consumer categories and defines rollout/rollback/approval.

## Spec Completeness

### Missing Sections

None. Required architecture, data/state, normative calendar, commands/events/workers, reconciliation, APIs/UI, migration/phasing/tests, risks, compliance/review/changelog are present.

### Incomplete Sections

None blocking or important. Concrete migration timestamps and runtime measurements remain implementation evidence.

## AGENTS.md Compliance

### Violations

None.

| Rule | Result |
|---|---|
| Isolation/scoping | DI/scalar IDs, both scope predicates, source absence 503/no-op, hidden Case 404. |
| Zod/types | Strict inferred commands and exact V1 state/event contracts. |
| Data/encryption | Plural scoped tables; holiday free text encryption map/decrypted reads. |
| Commands/undo | Canonical logs/extraction; immutable versions supersede; source facts idempotent. |
| Locking | Editable identities updatedAt; conditional due state; rebuild lease/version. |
| APIs/UI | CRUD factory where fitting, guarded custom writes, apiCall/shared conflict/DS/i18n/a11y. |
| Events/workers | createModuleEvents, receipts/outbox, named queues, bounded SKIP LOCKED. |
| Setup/tests | Exact ACL sync and self-contained API/UI/concurrency coverage. |

## Actual-Code and Prerequisite Reconciliation

The consumer does not claim missing Phase 1 facts exist. It explicitly gates on `2026-08-22-connect-sla-source-contract.md`, whose reader supplies immutable evidence, generation and wait intervals, and on reparenting lineage. Historical unknown remains unknown. Subscriber-first watermark, stable three-stream pages and deterministic receipts make live/backfill races converge. Missing/old facades do not trigger direct-table fallback.

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Incorrect DST deadline | Compliance error | Normative gap/fold/boundary/horizon algorithm and property tests. |
| Live/backfill race | Missing/duplicate clock | Subscriber-first watermark, stable cursors and receipts. |
| Mixed response/resolution result | Rewritten attainment | Independent terminal state machines and immutable late-breach behavior. |
| Missing prerequisite | Unsafe inference/outage | Hard health gate, 503/no-op; never direct-read/infer. |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Due-worker contention | Delayed transitions | Indexed ≤100 SKIP LOCKED claims and conditional update. |
| Policy/calendar deletion | Broken history | Immutable referenced versions and guarded deletion. |
| Reparent undo after later facts | Incorrect restoration | Lineage-version check, audited revision/manual review. |

### Low Risks

No v1 notifications; warnings remain available through API/UI. Tzdata affects only new clocks because due instants are persisted.

## Gap Analysis

### Critical Gaps (Block Implementation)

None remain in this consumer contract.

### Important Gaps (Should Address)

None. Prerequisite implementation and contract approval are explicit gates, not design gaps.

### Nice-to-Have Gaps

- Measure due-scan/rebuild throughput and expose non-PII unknown/lag/contention metrics.

## Remediation Plan

### Before Implementation

1. Approve new SLA event/API/DI/ACL/widget/schema contracts.
2. Implement and verify source-facts and reparenting prerequisites.

### During Implementation

1. Preserve exact calendar/state/watermark semantics; generate intended-only migration/snapshot.
2. Run true database concurrency, API/UI, decoupling, generate, build/typecheck and harness tests.

### Post-Implementation

1. Install subscribers before watermark reconciliation and monitor progress/unknowns without PII.

## Recommendation

**Ready to implement after named maintainer approval and prerequisite implementation.**

## Re-Audit Changelog

- 2026-08-22: Initial combined audit blocked, then advanced after contract remediation.
- 2026-08-22: Owner selected SPLIT; re-audited narrowed consumer across all thirteen categories and retained Ready verdict.

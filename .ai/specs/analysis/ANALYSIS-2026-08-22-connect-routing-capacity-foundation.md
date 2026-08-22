# Pre-Implementation Analysis: Mercato Connect — Routing Capacity Foundation

## Executive Summary

**Ready to implement.** The remediated specification matches the actual Connect status/index/setup/DI conventions, remains additive across all 13 backward-compatibility categories, and now closes every previous critical and important gap. Organization-level checkpoints prove empty and unchanged runs, projection identity is unambiguous, and setup has a concrete safe path when the queue is unavailable.

## Evidence Reviewed

- Full revised specification, including data models, algorithms, manifest, tests, compliance report, review, and changelog.
- `BACKWARD_COMPATIBILITY.md` and all 13 contract categories.
- Root/spec/core/CLI/queue/QA agent guides, module-development guidance, and repository review checklist.
- Actual Connect Case entity/status checks, composite assignee index in migration/snapshot, DI registration, organization-scoped setup hook, queue constants/workers, and CLI/onboarding setup call sites.
- Matching lesson index entries for workers, reconciliation, generated discovery, and integration tests.

## Backward Compatibility

### Violations Found

None.

| # | Surface | Verified Result |
|---:|---|---|
| 1 | Auto-discovery file conventions | New conventional module, DI, setup, CLI, entity, validator, and worker files are additive; generation/review is required. |
| 2 | Type definitions & interfaces | New reader/checkpoint contracts are additive; required fields are explicitly treated as stable after publication. |
| 3 | Function signatures | No existing signature changes; the new reader method is additive. |
| 4 | Import paths | No existing path moves/removals; module coupling remains through DI. |
| 5 | Event IDs | No event change. |
| 6 | Widget injection spot IDs | No widget change. |
| 7 | API route URLs | No HTTP API change. |
| 8 | Database schema | Two new tables, checks, and indexes only; normal generated `down()` is distinguished from operational disable/data preservation. |
| 9 | DI service names | New `connectCurrentCaseCountReader` is additive and pinned stable. |
| 10 | ACL feature IDs | No ACL change. |
| 11 | Notification type IDs | No notification change. |
| 12 | CLI commands | One additive, explicitly named operator retry command; it becomes stable when shipped. |
| 13 | Generated file contracts | Only additive module/entity/worker/CLI discovery is expected; exact generated diff must be reviewed. |

### Missing BC Section

None. `Migration & Backward Compatibility` covers additive surfaces, migration generation, schema versus operational rollback, DI stability, and the Phase 3 activation gate.

## Spec Completeness

### Missing Sections

None. API/UI are explicitly not applicable; every required spec-writing subject is present.

### Incomplete Sections

None blocking or important. The implementation must record the prescribed 500-row benchmark evidence, but the threshold and unit are already fixed, so this is verification rather than an architectural choice.

## AGENTS.md Compliance

### Violations

None.

- Dual tenant/organization scope is mandatory on reader, checkpoint, lock, presence writes, worker, setup, and CLI.
- Optional Connect coupling is a soft-resolved DI reader; there is no cross-module ORM relationship/import.
- Worker metadata is fixed at database-heavy concurrency 3, jobs are idempotent, and local/async strategy plus connection-budget tests are required.
- Zod owns internal/worker/CLI input schemas and TypeScript input types are derived via `z.infer`.
- Entity/migration/snapshot/generation and self-contained integration coverage are specified.
- No API, UI, ACL, event, cache, search, encryption, user command/undo, or i18n mechanism is applicable in this internal phase.

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Assignment changes after authoritative read | Projection can briefly lag current ownership. | Phase 2 does not route; Phase 3 requires fresh checkpoint and authoritative candidate recomputation before first offer. |
| Cross-scope leakage | Capacity corruption and tenant isolation failure. | Both scope predicates on every seam, scope-keyed advisory lock/uniques, and CAP-INT-001/006/014. |
| False freshness for empty/no-op scope | Unsafe Phase 3 activation. | Atomic organization checkpoint advances on every successful run; CAP-INT-010/011 fail closed for every other state/version. |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Same-scope concurrency/lock wait | Duplicate or delayed reconciliation. | Exact transaction advisory key, 5-second local lock timeout, fixed lock order, retryable code, sibling-scope test. |
| Queue unavailable for large setup | Deferred backfill could be stranded. | Durable pending checkpoint, synchronous bounded fallback, idempotent setup rerun, and explicit scoped CLI retry. |
| Aggregate coercion/overflow | Invalid integer projection. | Safe-integer parsing and `0..2147483647` validation before writes; DB check and CAP-INT-016. |
| Worker pool pressure | Web connection starvation. | Concurrency 3, queue connection-budget verification, one scope/job, 500-row statements. |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Additive generated registry changes | Snapshot/discovery expectations need updates. | Run `yarn generate`, inspect exact diff, run decoupling and workspace gates. |
| Internal rows mistaken for live presence | Unsupported direct DB consumer could misread `offline`. | No API/UI, explicit non-live semantics, Phase 3 eligibility seam. |

## Gap Analysis

### Critical Gaps (Block Implementation)

None.

### Important Gaps (Should Address)

None.

### Nice-to-Have Gaps

- A future implementation may expose an internal typed `unchanged` telemetry counter; this is not required for correctness because checkpoint generation proves completion.

## Remediation Verification

| Previous Finding | Revised Contract | Status |
|---|---|---|
| Row-local freshness cannot prove empty/unchanged runs | `connect_routing_capacity_checkpoints`, version `2026-08-22-v1`, positive generation, atomic completion | Resolved |
| Soft delete conflicts with unconditional unique/upsert | Presence identity is retained and never soft-deleted; absent assignees become zero | Resolved |
| Queue-unavailable deferral can remain stranded | Durable pending state, synchronous bounded fallback, setup rerun, exact CLI retry command | Resolved |
| Advisory lock unspecified | Exact key, `hashtextextended`, transaction scope, 5-second timeout, fixed order/code | Resolved |
| Worker strategy/metadata incomplete | Queue/worker ID, concurrency 3, local+async and DB-budget tests | Resolved |
| Count coercion/overflow undefined | Deterministic ordering, safe-integer parse, int32 bounds/error/test | Resolved |
| Foreground threshold ambiguous | Exact 500 authoritative-assignee rows and benchmark obligation | Resolved |
| Rollback semantics ambiguous | Generated schema `down()` separated from operational disable/data retention | Resolved |

## Remediation Plan

### Before Implementation (Must Do)

None; the contract is implementation-ready.

### During Implementation (Required by Spec)

1. Implement the two entities and two-stage pending/projection-completion transaction exactly as specified.
2. Generate and inspect migration, snapshot, and discovery output without applying migrations automatically.
3. Ship CAP-INT-001 through CAP-INT-016, including local/async worker modes and the 500-row benchmark evidence.

### Post-Implementation (Follow Up)

1. Phase 3 consumes the routing-owned checkpoint contract and still recomputes the candidate count before the first offer.
2. Phase 3, not this foundation, defines periodic freshness SLO/cadence.

## Recommendation

**Ready to implement.** No critical or important readiness gap remains after re-audit.

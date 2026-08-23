# Pre-Implementation Analysis: Mercato Connect — Allocated Cost Source Contract

## Executive Summary

The specification is **Ready to implement before the cost-reporting consumer**. It is a cohesive source-owned capability with exact bounded rational DTOs, scoped/private projection, required overlap index and performance evidence, module-local tests, and additive versioning. Actual code contains no released cost reader, so replacing the earlier planned row reader before publication breaks no contract.

## Verified As-Built Context

- `connect_analytics` and cost inputs are not implemented; no DI reader/import/API/index is released.
- The cost-input spec owns the future entity/migration/snapshot and already defines nonnegative bigint amounts, half-open timestamps, currency/type, soft deletion, encryption and scope.
- No Case/SLA/routing source is needed; this contract reads only its owning cost table.

## Backward Compatibility

### Violations Found

None.

### All 13 Contract Categories

| # | Surface | Result |
|---|---|
| 1 | Auto-discovery | Existing module DI modification only; additive/pass. |
| 2 | Types/interfaces | New exact strict DTO/types; additive/pass. |
| 3 | Function signatures | New exact method; additive/pass. |
| 4 | Import paths | New public contract paths, no move; pass. |
| 5 | Event IDs | None; N/A. |
| 6 | Widget IDs | None; N/A. |
| 7 | API URLs | No API; N/A. |
| 8 | DB schema | Additive index in not-yet-published cost migration/snapshot; pass. |
| 9 | DI names | New stable `connectAllocatedCostReader`; additive/pass. |
| 10 | ACL IDs | None; N/A. |
| 11 | Notification IDs | None; N/A. |
| 12 | CLI commands | None; N/A. |
| 13 | Generated contracts | Standard DI/entity/migration discovery with explicit tests; pass. |

Migration/BC correctly pins additive index, stable key/DTO/formula/version, no removal of a released row reader, and module-disable behavior.

## Spec Completeness

Required TLDR/Overview/problem/solution/architecture, exact schemas/formula/data/index, API/ACL N/A explanations, performance/cache, migration/BC, tests, Phasing, implementation/manifest, risks, compliance, and changelog are complete.

## AGENTS.md Compliance

No violations. Source owns its table query; both scopes are mandatory; Zod is exact; sensitive/encrypted columns are never selected; parameterized query/index/EXPLAIN are required; no HTTP/UI/write/event/cache; tests are module-local/self-contained; migration/snapshot/generation discipline is explicit.

## Risk Assessment

### High

| Risk | Mitigation |
|---|---|
| Precision drift | Arbitrary-precision reduced rationals/property tests. |
| Cross-scope financial disclosure | Required scopes, predicates, sanitized projection and isolation tests. |

### Medium

| Risk | Mitigation |
|---|---|
| Wide overlap scan | Required index, one projection query, >10k EXPLAIN/memory gate. |
| Consumer version skew | Literal version, strict parse, source-first rollout. |

### Low

| Risk | Mitigation |
|---|---|
| Platform-specific query plan | Record PostgreSQL plan; additive GiST fallback allowed in same migration review. |

## Gap Analysis

Critical gaps: none. Important gaps: none. Nice-to-have: record exact EXPLAIN output and standalone build artifact in PR evidence.

## Remediation Plan

Before implementation: no spec changes; implement before consumer. During: record migration/snapshot/generated diff, property/privacy/isolation/10k plan and runner evidence. Post: monitor p95; new materialization/cache requires evidence/new spec.

## Recommendation

**Ready to implement.** All 13 compatibility categories are additive/N/A and no blocking/important gap remains.

## Re-Audit — 2026-08-22

- BC: Pass 13/13.
- Exact arithmetic/schema/version: Pass.
- Scope/privacy/index/performance: Pass.
- QA/generated/standalone: Pass.
- Verdict: Ready before consumer.

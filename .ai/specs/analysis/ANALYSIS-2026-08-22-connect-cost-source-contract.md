# Pre-Implementation Analysis: Mercato Connect — Allocated Cost Source Contract

## Executive Summary

The spec is ready to implement in the dedicated `packages/connect` extension package. The current code contains the planned row-level reader that this spec explicitly supersedes before publication; no released surface must be removed, and the database change is additive.

## Backward Compatibility

### Violations Found

None. All contract categories were checked. The new DI key, exported schemas/types, required DTO fields, allocation formula, and version literal become stable on publication; the existing cost-input entity/API/ACL/events and generated conventions remain unchanged.

### Missing BC Section

None. The spec includes a Migration & Backward Compatibility section and explicitly constrains future evolution to additive optional fields or a new version.

## Spec Completeness

### Missing Sections

None applicable. There is intentionally no UI and no HTTP API.

### Incomplete Sections

None blocking. The performance target requires runtime PostgreSQL evidence after implementation rather than additional design detail.

## AGENTS.md Compliance

### Violations

None. The design keeps storage/query/arithmetic within the owning extension, validates with Zod, enforces tenant and organization predicates, selects no PII, adds no ACL, and places executable integration coverage module-locally.

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Precision drift | Incorrect downstream financial totals | Bigint numerator/denominator arithmetic, canonical GCD reduction, and property/edge tests |
| Cross-scope disclosure | Financial data crosses tenant or organization boundaries | Mandatory UUID scope plus both predicates and isolation integration coverage |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Large overlap scan | Report latency or memory growth | Partial composite overlap index, projection allowlist, one query, three-entry accumulator, and >10k plan evidence |
| Contract skew | Consumers parse a different formula or DTO | Strict schemas and literal `connect_analytics.allocated_cost.v1` |
| Migration drift | Unrelated generated changes enter the PR | Modify the original cost-input migration and matching snapshot only; inspect the db diff |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Module disabled | Optional consumer cannot resolve service | Registration exists only with `connect_analytics`; test omission when disabled |

## Gap Analysis

### Critical Gaps (Block Implementation)

None.

### Important Gaps (Should Address)

- Runtime plan evidence: execute the integration/performance scenario against PostgreSQL and retain the `EXPLAIN (ANALYZE, BUFFERS)` result in PR evidence.

### Nice-to-Have Gaps

None within this issue's scope.

## Remediation Plan

### Before Implementation (Must Do)

1. Synchronize with `origin/mercato-connect` and inspect the current cost-input reader, DI registration, migration, and snapshot. Completed.

### During Implementation (Add to Spec)

1. Record implementation status and any behavior divergence in the spec changelog.

### Post-Implementation (Follow Up)

1. Run the generated/standalone discovery gates before a downstream reporting consumer adopts the stable key.

## Recommendation

Ready to implement.

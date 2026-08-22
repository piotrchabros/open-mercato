# Pre-Implementation Analysis: Mercato Connect — Cost per Contact Reporting

## Executive Summary

The split specification is **Ready to implement after its two source prerequisites land**. It now covers only independent `connect_cost_reporting`: strict consumption/version/timeout/capability contracts, rational division/report composition, API/UI, and generated/live activation. Allocated-cost source aggregation lives in its own audited spec; split-lineage denominator/index remains a Connect prerequisite. No existing contract is changed incompatibly.

## Verified As-Built Context

- Phase 1 Connect has scoped Cases but no split lineage/root-date index; report implementation is explicitly gated on the landed denominator prerequisite.
- Allocated-cost source is separated into `2026-08-22-connect-cost-source-contract.md` and independently audited Ready; the consumer does not implement its query/index.
- Existing Connect metrics/API/UI/ACL/event/import/generated contracts remain untouched.

## Backward Compatibility

### Violations Found

None after remediation.

### All 13 Contract Categories

| # | Surface | Verification | Result |
|---|---|---|---|
| 1 | Auto-discovery | New conventional report module/API/backend/ACL/setup/DI files. | Additive/pass. |
| 2 | Types/interfaces | Exact strict reader/report/error schemas and literal versions. | Additive/pass. |
| 3 | Function signatures | Two new exact reader methods only. | Additive/pass. |
| 4 | Import paths | No existing move/removal; public contracts only. | Pass. |
| 5 | Event IDs | Report adds none; prerequisite reparenting owns its command/events separately. | N/A/pass. |
| 6 | Widget IDs | No injection; distinct auto-discovered page. | N/A/pass. |
| 7 | API URLs | New `/api/connect_cost_reporting/report`; existing APIs unchanged. | Additive/pass. |
| 8 | DB schema | Consumer has none; landed lineage prerequisite owns additive migration/index. | N/A/pass for consumer. |
| 9 | DI names | Consumer resolves two prerequisite exact readers; adds no source key. | Pass. |
| 10 | ACL IDs | New report view; existing cost-input view reused as source authorization. | Additive/pass. |
| 11 | Notification IDs | None. | N/A. |
| 12 | CLI commands | None. | N/A. |
| 13 | Generated contracts | No generator change; generated module/API/page/ACL/DI assertions required. | Additive/pass. |

Migration & Backward Compatibility is present, correctly declares consumer no-schema, source-owned prerequisites, and new report IDs/formula stable.

## Spec Completeness

All required consumer sections are complete: TLDR/Overview, problem/solution/decisions, architecture/prerequisites, consumed exact schemas, formula, API/ACL/UI, performance/cache, migration/BC, integration/browser/property tests, explicit Phasing, implementation/manifest, risks, compliance, and changelog.

Initial blockers remediated:

- Canonical non-deleted root-created cohort collapses all split descendants and labels merge as out of v1.
- Real independently activatable report module/API/page/ACL.
- Exact strict source/API/capability/reason/version schemas and two-second source behavior.
- Landed cost-source contract transfers at most three rational rows; consumer remains constant-memory.
- Root-date index/migration stays explicitly owned by the lineage prerequisite.
- Module-local integration path, generated/live/version-skew/split/performance tests.

## AGENTS.md Compliance

### Violations

None.

### Verified Compliance

- Correct module placement/discovery and package-local tests.
- Consumer-owned optional DI glue; no cross-module ORM/hard requirement.
- Server-derived tenant/organization scope, adapter and financial-source ACL checks, wildcard policy.
- Exact Zod/OpenAPI/API errors and sanitized DTO allowlists.
- Read-only report needs no command/mutation guard/optimistic lock/encryption/event/cache.
- Consumer has no migration; prerequisite ownership/order is explicit.
- Separate server-first UI uses named shared components, `apiCall`, five locales, DS/accessibility/bundle gates.

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Incorrect split lineage/root | Wrong denominator | Same-scope acyclic commands, root-only definition/index, multi-level/scope tests, explicit v1. |
| Precision/allocation drift | Wrong money | Source reduced rationals, bigint consumer, exact round-once property tests. |
| Cross-scope financial disclosure | Tenant/org leak | Pre-call dual ACL, both source scopes, strict sanitized DTOs, denial tests. |
| Source version/outage | Wrong partial report | Literal versions, strict parse, two-second bounds, reason matrix, no partial totals. |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Large cost cardinality | Source load | Landed source contract owns aggregation/index/>10k evidence; consumer accepts at most three rows. |
| Historical corrections/root deletion | Old result changes | Freshness, no cache, audited sources, explicit current-recomputation semantics. |
| Migration order | Reader queries missing lineage/index | Source prerequisite phase and generated/migration tests before adapter. |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Bundle regression | Optional page slower | 20 kB budget and recorded build/browser evidence. |

## Gap Analysis

### Critical Gaps (Block Implementation)

None.

### Important Gaps (Should Address)

None.

### Nice-to-Have Gaps

- Record exact bundle/EXPLAIN commands and query plans in implementation PR evidence.

## Remediation Plan

### Before Implementation (Must Do)

No further consumer-spec remediation. Verify both landed reader versions before adapter API/UI.

### During Implementation (Add to Spec)

1. Record prerequisite version checks, generated manifests, strict schema/version matrix, consumer arithmetic properties, privacy/ACL/isolation, bundle and runner evidence. Source specs own migration/EXPLAIN evidence.
2. Keep existing cost CRUD and analytics/SLA/Connect responses unchanged.

### Post-Implementation (Follow Up)

1. Monitor adapter p95 and source version-unavailable rates; source query monitoring belongs to its owner. Do not add report storage/cache without evidence/new spec.
2. Do not mark implemented until split-collapse, enable/disable, integration/browser/performance gates pass.

## Recommendation

**Ready to implement after prerequisites.** The consumer split is cohesive; all 13 compatibility categories are additive/N/A and no blocking/important gap remains.

## Re-Audit — 2026-08-22

- BC categories: Pass (13/13 checked).
- Split-collapse and allocated-cost prerequisites: Pass (externally owned, explicitly gated).
- Exact schemas/formula/timeout/version matrix: Pass.
- Performance/index/bounded transfer: Pass.
- QA/generated/live/activation/UI: Pass.
- Verdict: Ready to implement in pinned phase order.

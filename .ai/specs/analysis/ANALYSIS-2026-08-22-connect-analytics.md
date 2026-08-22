# Pre-Implementation Analysis: Mercato Connect — Operational Reporting

## Executive Summary

The remediated specification is **Ready to implement**. It preserves Phase 1 metrics, uses a source-owned scoped DI reader, adds only new contract surfaces, and explicitly avoids PII and cross-module ORM coupling. The re-audit verified exact strict DTO/API schemas and range/error/order/nullability rules, correct module-local integration-test placement, explicit delivery phases, deferred inert agent ACL, distinct coexistence with Metrics, exact shared UI/page metadata, and generated/live-route/Phase 1 parity coverage.

## Verified As-Built Context

- `packages/connect/src/modules/connect/data/entities.ts` already defines `ConnectOperationalFact` and `ConnectMetricDaily`; the latter is unique per `(tenant_id, organization_id, utc_date)` and includes the counters, daily percentiles/sample counts, suppression values, `generated_at`, and `stale` proposed for reuse.
- `packages/connect/src/modules/connect/lib/metrics-aggregate.ts` already owns deterministic daily aggregation, nearest-rank percentiles, latest outbound outcome, suppression arithmetic, and scoped `rebuildDay`.
- Existing stable routes are `/api/connect/metrics/summary`, `/exceptions`, and `/rebuild`; the summary clamps to yesterday, limits ranges to 92 days, and exposes null/unavailable semantics.
- Existing UI is `/backend/connect/metrics`; existing ACL IDs are `connect.metrics.view` and `connect.metrics.manage`; five locale files already contain Phase 1 metric strings.
- `packages/connect/src/modules/connect/di.ts` registers metric entity classes but no metrics reader. No `connect_analytics` module, route, ACL, DI key, page, entity, event, notification, CLI command, or widget exists.
- Existing metrics tests are unit/subscriber/worker tests. The Phase 1 operational-metrics spec records integration/browser coverage as not started.

## Backward Compatibility

### Violations Found

No direct backward-compatibility violation is proposed. The change is additive. The two initially incomplete new contracts are now fully specified before publication.

| # | Surface | Issue | Severity | Proposed Fix |
|---|---|---|---|---|
| 2 | Type definitions/interfaces | Initial exact-schema gap is remediated with strict Zod DTO/report/error schemas and derived types. | Remediated | Preserve required fields; evolve additively/version formulas. |
| 9 | DI service names | Initial semantic gap is remediated: validated inclusive range, ascending order, complete-day ownership, exact DTO, and API error behavior are pinned. | Remediated | Treat the published key/interface as stable. |

### All 13 Contract Categories

| # | Surface | Actual-code verification | Result |
|---|---|---|---|
| 1 | Auto-discovery conventions | New conventional `index/acl/setup/di`, `api/.../route`, and backend page files; no existing convention renamed. | Additive; compliant, subject to correcting test placement (not an auto-discovery BC surface). |
| 2 | Types/interfaces | No existing public type changes; new strict DTO/report/error schemas are exact. | Additive/compliant. |
| 3 | Function signatures | Existing aggregation/API functions are preserved; new `listDaily` is additive. | Compliant; new signature semantics must be completed. |
| 4 | Import paths | No move/removal/re-export change proposed. | Compliant. |
| 5 | Event IDs | Existing `connect.*` metric source events/subscriber IDs remain unchanged; no new event. | Compliant. |
| 6 | Widget spot IDs | No existing spot touched and no widget proposed. | Compliant. |
| 7 | API URLs | Existing `/api/connect/metrics/*` preserved; `/api/connect_analytics/reports/operational` is new and file placement `api/reports/operational/route.ts` correctly relies on module prefixing. | Compliant; response contract incomplete. |
| 8 | Database schema | No entity/migration/schema change. | Compliant. |
| 9 | DI names | `connectOperationalMetricsReader` is new with finalized semantics. | Additive/compliant. |
| 10 | ACL IDs | Existing `connect.metrics.*` preserved; only used `connect_analytics.view` is new. | Additive/compliant; agent ACL deferred. |
| 11 | Notification IDs | None touched/added. | N/A/compliant. |
| 12 | CLI commands | None touched/added. | N/A/compliant. |
| 13 | Generated contracts | Generator implementation/exports unchanged; new module discovery only. | Compliant; `yarn generate` and generated-manifest assertions required. |

### Migration & Backward Compatibility Section

Present and correct about preserving Phase 1 and declaring the new API/ACL/DI identifiers stable; formula versioning and additive DTO evolution are pinned.

## Spec Completeness

### Missing Sections

| Section | Impact | Recommendation |
|---|---|---|
None. Explicit reader, API, and UI phases now end in testable working gates.

### Incomplete Sections

| Section | Gap | Recommendation |
|---|---|---|
None. The re-audit verified exact schemas/contracts, responsibility boundaries, deferred agent ACL, exact component/page metadata, correct test placement, generated/live route coverage, and updated compliance verdict.

## AGENTS.md Compliance

### Violations

| Rule | Location | Fix |
|---|---|---|
None. The planned executable test is module-local, explicit Phasing is present, and the compliance report records remediation.

### Compliant Decisions

- Correct package placement under `packages/connect/src/modules/connect_analytics`.
- Correct module ID/ACL namespace using snake case (`connect_analytics.*`).
- No direct cross-module ORM relation or peer table query; source-owned DI facade matches the relevant lesson.
- Server-derived tenant and organization scope, explicit denial tests, PII-minimized DTO, no new sensitive storage.
- Read-only API correctly avoids command/mutation-guard/optimistic-lock requirements.
- API metadata/features/OpenAPI, `apiCall`, i18n, shared loading/error/empty primitives, semantic tokens, Lucide/accessibility requirements are planned.
- No cache is a justified bounded-read choice; no raw cache/backend dependency.
- No existing event, notification, CLI, widget, API, schema, import, or generated contract is mutated.

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| New stable DTO freezes before definition | Divergent implementations/clients and later breaking correction | Exact Zod/TS response and DI DTO before code; additive-only version policy. |
| Duplicate product surface | Existing `/backend/connect/metrics` and new analytics page can show nearly identical data, confusing navigation and ownership. | Specify differentiated user outcome or intentional coexistence labels; browser test both entries and no route replacement. |
| Cross-scope disclosure | Organization-wide reports leak sibling data. | Source- and consumer-side dual scope plus same-ID cross-tenant/org integration fixtures. |
| PII/identifier expansion | A future “sanitized” reader accidentally exposes fact dimensions. | Explicit allowlist DTO/schema, projection query, forbidden-key and serialized/log tests. |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Range semantics diverge from Phase 1 | Same dates yield different results on two pages. | Share or pin date utilities/constants and parity tests against `/connect/metrics/summary`. |
| Source rebuilding during read | Mixed generation snapshots confuse users. | Preserve per-day `stale/generatedAt`; define whether mixed rows are allowed and test them. |
| Auto-discovery path mistake | Compiles but generated route 404s. | Assert generated manifests and booted API/backend routes; follow module-prefix lesson. |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Bundle budget lacks measurement command | Performance claim cannot be reproduced. | Name the bundle analyzer/build evidence recorded in PR. |
| No UI screenshot/manual evidence requirement | DS regressions may escape automation. | Add screenshot/high-contrast evidence to validation/PR checklist. |

## Gap Analysis

### Critical Gaps (Block Implementation)

None after remediation.

### Important Gaps (Should Address)

None after remediation. All initial important findings are incorporated into normative spec text and tests.

### Nice-to-Have Gaps

- State a reproducible bundle measurement command and screenshot evidence.
- State whether formula version is a string literal enum in Zod/OpenAPI.

## Remediation Plan

### Before Implementation (Must Do)

No further spec remediation required. Implement the pinned phases/contracts without widening scope.

### During Implementation (Add to Spec)

1. Verify generated API/backend/ACL/DI registries after `yarn generate`.
2. Add parity tests against Phase 1 summary semantics and tests for both old/new navigation routes.
3. Record the chosen runner, bundle measurement, accessibility results, and PII forbidden-field evidence.

### Post-Implementation (Follow Up)

1. Observe response size/p95 before proposing caching/materialization.
2. Do not move this spec to `implemented/` until API/UI integration and browser coverage pass in a deployed/ephemeral environment.

## Recommendation

**Ready to implement.** All initial blockers and important findings are remediated and verified against actual code and all 13 backward-compatibility surfaces. No existing contract break is proposed.

## Re-Audit — 2026-08-22

- **Backward compatibility**: Pass — all 13 categories rechecked; additive only.
- **Schemas/contracts**: Pass — strict field/nullability/order/range/error schemas are normative.
- **AGENTS/QA**: Pass — executable test path corrected; phases and generated/live routing checks added.
- **ACL/module boundaries**: Pass — inert agent grant deferred; source-owned DI reader retained.
- **UI**: Pass — Metrics coexistence, exact page metadata/components, accessibility and performance gates pinned.
- **Verdict**: Ready to implement.

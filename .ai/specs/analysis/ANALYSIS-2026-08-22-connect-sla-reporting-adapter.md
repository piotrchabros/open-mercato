# Pre-Implementation Analysis: Mercato Connect — SLA Reporting Adapter

## Executive Summary

The remediated specification is **Ready to implement in its pinned phase order**. It now defines a real independently activatable `connect_sla_reporting` module, preserves core analytics' strict response by using a separate endpoint/page, pins exact source/adapter schemas and SLA formula semantics, and supplies dual ACL, module-local integration, generated/live activation, and compatibility coverage. No existing contract is changed incompatibly.

## Verified As-Built Context

- No SLA, analytics, adapter, registry, or adapter route currently exists in code; every surface is additive.
- Existing Connect metrics routes/entities/events/ACLs remain untouched.
- Core analytics spec's strict operational response remains unchanged; adapter route is separate.
- SLA source spec is the declared Phase 1 prerequisite and must own the reader/formula/ACL before adapter code.

## Backward Compatibility

### Violations Found

None after remediation.

### All 13 Contract Categories

| # | Surface | Verification | Result |
|---|---|---|---|
| 1 | Auto-discovery | New conventional module/index/ACL/setup/DI/API/backend files. | Additive/pass. |
| 2 | Types/interfaces | Exact strict source/adapter/error schemas; no existing type altered. | Additive/pass. |
| 3 | Function signatures | New exact `summarize` only. | Additive/pass. |
| 4 | Import paths | No move/removal; public source contract only. | Pass. |
| 5 | Event IDs | No event. | N/A/pass. |
| 6 | Widget spot IDs | No widget/phantom host; page discovery composes navigation. | N/A/pass. |
| 7 | API URLs | New `/api/connect_sla_reporting/report`; core operational API unchanged. | Additive/pass. |
| 8 | Database schema | No adapter schema/migration. | N/A/pass. |
| 9 | DI names | New exact `connectSlaAnalyticsReader`; stable/additive. | Pass. |
| 10 | ACL IDs | New source `connect_sla.reports.view` and adapter `.view`; owners/grants pinned. | Additive/pass. |
| 11 | Notification IDs | None. | N/A. |
| 12 | CLI commands | None. | N/A. |
| 13 | Generated contracts | No generator change; generated module/API/page/ACL/DI assertions required. | Additive/pass. |

The Migration & Backward Compatibility section is present and correctly declares new identifiers stable, formula versions explicit, and disable behavior data-preserving.

## Spec Completeness

All required sections are present: TLDR/Overview, problem/solution/decisions, architecture, exact data/schema/formula, API, ACL, UI/i18n, performance/cache, compatibility, tests, explicit Phasing, detailed plan/manifest, risks, compliance, and changelog.

Previously blocking gaps are remediated:

- Real module/activation owner instead of phantom registry.
- Separate API/page instead of changing the strict core response.
- Exact Zod DTOs, reasons, cohort, units, generation/outcome/exclusion/null semantics.
- Source-owned ACL/reader and explicit source-first landing order.
- Package `__integration__` path, generated/live activation and core-compatibility tests.

## AGENTS.md Compliance

### Violations

None.

### Verified Compliance

- Correct package/module placement and auto-discovery paths.
- Consumer-owned optional DI glue, no cross-module ORM or hard dependency.
- Server-derived tenant/organization scope and dual wildcard-aware ACL before source call.
- Read-only capability correctly requires no commands, guards for writes, optimistic lock, encryption, event, cache, migration, or search.
- Exact API metadata/OpenAPI/Zod/error contract and module-local integration tests.
- Server-first UI uses named shared components, `apiCall`, five locales, semantic DS/accessibility constraints.
- Generated/live route tests guard against doubled module prefixes and disabled-module leakage.

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| SLA formula error | Misstated attainment | Source-owned versioned exact cohort/equation/business seconds and exhaustive outcome/DST source tests. |
| Cross-scope/ACL disclosure | Organization SLA leak | Both ACLs before call, server dual scope, source predicates, denial fixtures. |
| False success on absence/open | Incorrect management decision | Discriminated unavailable states; open/exclusions/sample equation; never numeric defaults. |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Source outage/timeout | Adapter unavailable | Two-second bound/fail-soft; separate route leaves core analytics untouched. |
| Source/adapter version skew | Strict parse failure | Source-first phase, soft resolve, source_error reason, generated/activation tests. |
| Late outcome revises historical cohort | Historical values change | Stable start cohort, sticky breach, `generatedAt`, no cache, explicit tests. |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Bundle regression | Slower optional page | 20 kB incremental budget and recorded build/browser evidence. |

## Gap Analysis

### Critical Gaps (Block Implementation)

None.

### Important Gaps (Should Address)

None.

### Nice-to-Have Gaps

- Record the exact bundle-analysis command in the implementation PR evidence.

## Remediation Plan

### Before Implementation (Must Do)

No further spec changes. Respect Phase 1 source-contract prerequisite before Phase 2 adapter work.

### During Implementation (Add to Spec)

1. Record generated registry diff, live activation matrix, strict-schema parse, dual-ACL/privacy, timeout, and runner evidence.
2. Keep the core operational response byte-shape compatible as required by SRA-INT-010.

### Post-Implementation (Follow Up)

1. Monitor adapter source timeout/error rate and p95 without adding cache until evidence justifies it.
2. Do not move specs to implemented until source and adapter integration/browser gates pass.

## Recommendation

**Ready to implement**, beginning with the source reader/formula/ACL phase. All initial blockers and important findings are remediated; all 13 backward-compatibility categories are additive or not applicable.

## Re-Audit — 2026-08-22

- BC categories: Pass (13/13 checked).
- Architecture/activation: Pass.
- Exact schemas/formula/API/ACL: Pass.
- QA path/generated/live/disable matrix: Pass.
- UI/i18n/accessibility/performance contract: Pass.
- Verdict: Ready to implement in pinned phase order.

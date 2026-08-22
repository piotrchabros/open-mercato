# Mercato Connect — Operational Reporting

## TLDR

- Add `connect_analytics` reporting over sanctioned Phase 1 operational aggregates without copying message content, handles, sender hashes, or customer/Case identifiers.
- Preserve existing `connect` metrics entities, formulas, APIs, UI, and ACLs; consume them through a scoped DI facade.
- Consume SLA reporting through a soft-optional facade. Missing SLA is unavailable, never zero.

Scope is response time, resolution time, delivery, suppression, reconciliation, and optional SLA attainment. Cost inputs/cost-per-contact, capacity backfill, SLA writes, routing, raw-fact duplication, AI, and live channels are separate/non-goals.

## Overview

Phase 1 already owns immutable operational facts, deterministic `connect_metric_daily` rows, bounded summary/exception/rebuild APIs, and an admin metrics page. Phase 2 adds an independently gated, formula-versioned reporting surface over those aggregates and optional SLA summaries. It adopts explicit cohort/sample/unavailable semantics and rejects transactional peer-table queries or hidden duplication.

## Problem Statement

Operators lack a dedicated analytics contract that can compose operational and optional SLA outcomes. Moving Phase 1 metrics would break stable routes and ACLs; direct entity imports would violate module isolation. Missing days, empty percentile populations, or disabled SLA can also become misleading zeros unless the contract distinguishes them.

## Proposed Solution

Add a sanitized `connectOperationalMetricsReader` to `connect`. `connect_analytics` soft-resolves that reader and a future `connectSlaAnalyticsReader`, composes bounded reports, and owns only the new API/UI/ACL/formula metadata. No new reporting table is needed: a request reads at most 92 daily rows. Materialization requires later performance evidence and a separate spec update.

### Decisions and Alternatives

| Decision | Rationale |
|---|---|
| Keep Phase 1 metrics in `connect` | Existing schemas, routes, formulas, event IDs, and ACLs remain stable. |
| DI read facades, consumer-owned glue | Source modules own storage/semantics; optional modules degrade cleanly. |
| UTC complete days | Matches Phase 1 cohorts; timezone changes do not reinterpret history. |
| Version every formula | Published meaning cannot change silently. |
| Do not average daily percentiles | A mean of p50/p90 values is not a valid range percentile. |

Rejected: copying facts/aggregates (drift/retention), direct ORM access (coupling), HTTP loopback (auth/latency), and hard SLA dependency (unnecessary deployment coupling).

## User Stories

- A manager compares inbound disposition, delivery, response, and resolution for a bounded date range.
- An administrator sees unreconciled receipts, unknown sends, and suppression violations without PII.
- A manager sees SLA attainment when available and an explicit unavailable state otherwise.
- An auditor identifies UTC cohort, sample count, generation state, and formula version.

## Architecture

```text
connect_metric_daily -> connectOperationalMetricsReader --+
                                                         +-> report composer -> guarded API/UI
connect_sla source -> connectSlaAnalyticsReader ----------+   (soft optional)
```

`connect` registers:

```ts
type ConnectOperationalMetricsReader = {
  listDaily(input: {
    tenantId: string
    organizationId: string
    fromUtcDate: string
    toUtcDate: string
  }): Promise<ConnectOperationalMetricDay[]>
}
```

The DTO preserves Phase 1 counters, reconciliation inputs, outbound outcomes/unknown age, daily response/resolution percentiles with sample counts, optional projection lag, suppression result, `generatedAt`, and `stale`. It forbids source IDs, sender hash, body, subject, handle, and customer data.

`connect_sla` may register `connectSlaAnalyticsReader.summarize(ScopedUtcRange)`. `connect_analytics` resolves both locally with `try/catch`; absent Connect is `operationalMetrics: unavailable`, absent SLA is `sla: unavailable`. There are no cross-module entity imports, ORM relations, or side-effect imports.

## Data Models

No persisted entity is added.

The report envelope contains `from`, `to`, `requestedDays`, `completeDays`, `formulaVersion: connect_analytics.operational.v1`, capability states, sanitized `days`, additive `totals` (null with no aggregates), daily percentile series/sample counts, and optional source-versioned SLA summary. It never fabricates a range percentile from daily percentiles.

## API Contracts

### `GET /api/connect_analytics/reports/operational`

Query: `from` and `to` as `YYYY-MM-DD`; ordered, maximum 92 days, clamped to yesterday UTC. Metadata requires auth and `connect_analytics.view`; route exports Zod-derived OpenAPI.

Response is the report envelope. Errors: 400 missing organization, 401, 403, 422 invalid/oversized range, 503 required Connect reader unavailable. SLA absence remains a successful response with unavailable capability.

Agent-grain reporting is deferred: existing facts do not carry a sanctioned agent dimension. `connect_analytics.view.agents` is reserved but guards no route until Connect exposes an additive authorized aggregate; analytics never approximates it by querying Cases.

## Access Control

- `connect_analytics.view`: aggregate operational reports; manager default.
- `connect_analytics.view.agents`: future sensitive agent reports; admin only and inert in MVP.
- Admin/superadmin receive `connect_analytics.*`; employees receive neither.
- Framework wildcard matching applies; server-derived organization scope cannot be widened by query input.

## UI/UX and Internationalization

Add `/backend/connect/analytics`, guarded by `connect_analytics.view`. The server page loads initial data; one bounded `OperationalReport.client.tsx` owns date controls/refresh. Reuse shared KPI/detail/table, `Alert`, `EmptyState`, and loading/error primitives. Every trend has a synchronized table/text equivalent; UTC/cohort/sample/stale/formula labels are visible and unavailable never renders as zero.

All strings use `useT`/`resolveTranslations`; `en/de/es/ko/pl` are complete. Use `apiCall`, semantic DS tokens, Lucide icons and labelled icon buttons. No raw fetch, inline SVG, arbitrary sizes, or hardcoded status colors.

Frontend contract: server shell plus the single justified client island; no provider/bootstrap change or new dependency; route-attributable bundle under 60 kB gzip; no hydration warnings; keyboard, screen-reader, high-contrast, and non-color tests.

## Performance and Cache

- One indexed source query plus one optional SLA query, run concurrently after authorization; no N+1.
- Maximum 92 rows and 250 kB uncompressed response; p95 composition target 250 ms excluding cold DB startup.
- No cache in MVP because bounded reads expose `stale/generatedAt` and caching can conceal rebuilds. Any future cache must use DI with tenant/org/source-rebuild tags.

## Migration & Backward Compatibility

No migration/backfill. Add module, page, route, ACL IDs, and DI facade only. Existing `/api/connect/metrics/*`, `/backend/connect/metrics`, `connect.metrics.*`, entity schemas, and formulas remain unchanged. The reader DI name/required DTO fields become stable. Disabling analytics removes its API/navigation and preserves source data; disabling SLA omits only SLA families.

## Testing Strategy and Integration Coverage

- Unit: composition, totals, range/clamp, capability states, formula versions, and rejection of percentile averaging.
- **AN-INT-001:** tenant and sibling-organization isolation with overlapping dates.
- **AN-INT-002:** complete/incomplete/missing/stale day semantics.
- **AN-INT-003:** empty response/resolution populations remain unavailable with sample counts.
- **AN-INT-004:** delivery revisions, unknown age, reconciliation, and suppression match source DTOs.
- **AN-INT-005:** SLA enabled/disabled behavior and source formula version.
- **AN-INT-006:** Connect reader absent produces explicit 503, never zero totals.
- **AN-INT-007:** ACL/wildcard denial matrix and organization switching.
- **AN-INT-008:** response/log/search contain no forbidden PII or identifiers.
- **AN-UI-001:** keyboard, screen reader, table equivalents, error/empty/unavailable/high contrast, hydration.
- **AN-UI-002:** maximum range response/bundle/performance budgets.

Fixtures are self-contained and cleaned in `finally`; existing Phase 1 integration gaps are not relabeled complete.

## Implementation Plan

1. **AN-CON-01:** sanitized scoped Connect reader, registration, DTO/privacy/decoupling tests.
2. **AN-MOD-01:** module metadata, ACL, setup grants, DI helper, locales; run `yarn generate`.
3. **AN-CMP-01:** pure versioned composer and optional SLA adapter.
4. **AN-API-01:** guarded/OpenAPI report route and Zod schemas.
5. **AN-UI-01:** accessible server-first page and bounded client island.
6. **AN-TEST-01:** ship AN-INT/AN-UI tests in the same change.
7. **AN-VAL-01:** package test/typecheck/build, integration tests, generate, root typecheck/lint; record runner mode.

### File Manifest

| File | Action |
|---|---|
| `packages/connect/src/modules/connect/lib/operational-metrics-reader.ts` | Create |
| `packages/connect/src/modules/connect/di.ts` | Modify |
| `packages/connect/src/modules/connect_analytics/{index,acl,setup,di}.ts` | Create |
| `packages/connect/src/modules/connect_analytics/lib/report-composer.ts` | Create |
| `packages/connect/src/modules/connect_analytics/api/reports/operational/route.ts` | Create |
| `packages/connect/src/modules/connect_analytics/backend/connect/analytics/{page.tsx,page.meta.ts}` | Create |
| `packages/connect/src/modules/connect_analytics/components/OperationalReport.client.tsx` | Create |
| `packages/connect/src/modules/connect_analytics/i18n/{en,de,es,ko,pl}.json` | Create |
| `.ai/qa/tests/connect-analytics-operational.spec.ts` | Create |

## Risks & Impact Review

#### Misleading mathematics
- **Scenario**: daily percentiles are averaged or empty samples become zero.
- **Severity**: High
- **Affected area**: operator decisions
- **Mitigation**: daily series, sample counts, versioned formulas, unavailable states.
- **Residual risk**: small samples may be over-read; maturity/sample labels remain visible.

#### Cross-scope disclosure
- **Scenario**: a source/composition query omits tenant or organization.
- **Severity**: Critical
- **Affected area**: API/UI
- **Mitigation**: server-derived dual scope at both layers and isolation/denial tests.
- **Residual risk**: future report families must repeat the matrix.

#### Optional SLA becomes false success
- **Scenario**: disabled SLA appears as perfect/zero attainment.
- **Severity**: High
- **Affected area**: SLA report
- **Mitigation**: explicit unavailable capability and omitted numeric values.
- **Residual risk**: users must understand the labelled unavailable state.

#### PII propagation
- **Scenario**: raw fact dimensions enter DTOs/logs.
- **Severity**: Critical
- **Affected area**: privacy/retention
- **Mitigation**: aggregate-only DTO, forbidden-field tests, no peer storage access.
- **Residual risk**: every additive DTO field needs privacy review.

#### Rebuild race
- **Scenario**: reports read stale/in-flight source aggregates.
- **Severity**: Medium
- **Affected area**: temporary accuracy
- **Mitigation**: preserve per-day `stale/generatedAt`, no cache, explicit UI labels.
- **Residual risk**: mixed generation times are possible and disclosed.

## Final Compliance Report — 2026-08-22

### AGENTS.md Files Reviewed

- Root, `.ai/specs`, core, UI/backend UI, shared, `BACKWARD_COMPATIBILITY.md`, and spec-writing guides.

### Compliance Matrix

| Rule | Status | Notes |
|---|---|---|
| No cross-module ORM; optional peers degrade | Compliant | Sanitized DI facades |
| Tenant/organization scope | Compliant | Server-derived at source/consumer |
| API metadata/features/OpenAPI | Compliant | AN-API-01 |
| Shared UI/i18n/DS/accessibility | Compliant | Explicit UI contract/tests |
| Additive backward compatibility | Compliant | Phase 1 surfaces unchanged |
| Encryption and optimistic CRUD | N/A | No storage/write API |

### Internal Consistency Check

Data/API/UI, risks, no-write command status, no-cache strategy, and operational-only scope: **Pass**. Non-compliant items: none.

### Verdict

Fully compliant; ready for independent scope review and pre-implementation audit.

## Changelog

### 2026-08-22

- Replaced combined skeleton with operational-reporting-only implementation spec; split cost and capacity work.
- Review: security, performance, cache, commands, and risks passed; fresh-context scope review remains required.

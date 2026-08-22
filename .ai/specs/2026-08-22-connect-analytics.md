# Mercato Connect — Operational Reporting

## TLDR

- Add `connect_analytics` reporting over sanctioned Phase 1 operational aggregates without copying message content, handles, sender hashes, or customer/Case identifiers.
- Preserve existing `connect` metrics entities, formulas, APIs, UI, and ACLs; consume them through a scoped DI facade.
- Remain independent of SLA, cost accounting, and routing modules.

Scope is response time, resolution time, delivery, suppression, and reconciliation. SLA reporting (separate adapter spec), cost inputs/cost-per-contact, capacity backfill, routing, raw-fact duplication, AI, and live channels are non-goals.

## Overview

Phase 1 already owns immutable operational facts, deterministic `connect_metric_daily` rows, bounded summary/exception/rebuild APIs, and an admin metrics page. Phase 2 adds an independently gated, formula-versioned reporting surface over those aggregates. It adopts explicit cohort/sample/unavailable semantics and rejects transactional peer-table queries or hidden duplication.

## Problem Statement

Operators lack a dedicated analytics contract for operational outcomes. Moving Phase 1 metrics would break stable routes and ACLs; direct entity imports would violate module isolation. Missing days and empty percentile populations can become misleading zeros unless the contract distinguishes them.

## Proposed Solution

Add a sanitized `connectOperationalMetricsReader` to `connect`. `connect_analytics` resolves that reader, composes bounded reports, and owns only the new API/UI/ACL/formula metadata. No new reporting table is needed: a request reads at most 92 daily rows. Materialization or cross-module adapters require later evidence and separate specs.

### Decisions and Alternatives

| Decision | Rationale |
|---|---|
| Keep Phase 1 metrics in `connect` | Existing schemas, routes, formulas, event IDs, and ACLs remain stable. |
| DI read facade | Connect owns storage/semantics; analytics owns composition. |
| UTC complete days | Matches Phase 1 cohorts; timezone changes do not reinterpret history. |
| Version every formula | Published meaning cannot change silently. |
| Do not average daily percentiles | A mean of p50/p90 values is not a valid range percentile. |

Rejected: copying facts/aggregates (drift/retention), direct ORM access (coupling), and HTTP loopback (auth/latency).

## User Stories

- A manager compares inbound disposition, delivery, response, and resolution for a bounded date range.
- An administrator sees unreconciled receipts, unknown sends, and suppression violations without PII.
- An auditor identifies UTC cohort, sample count, generation state, and formula version.

## Architecture

```text
connect_metric_daily -> connectOperationalMetricsReader -> report composer -> guarded API/UI
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

The reader accepts an already validated **inclusive** complete-day range, returns rows ordered by `utcDate ASC`, and does not clamp or widen it. Invalid dates/ranges are rejected by the API before the reader call. Its exact stable DTO is derived from these Zod schemas (all objects are `.strict()`):

```ts
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const percentileSchema = z.object({
  p50: z.number().nonnegative().nullable(),
  p90: z.number().nonnegative().nullable(),
  sampleCount: z.number().int().nonnegative(),
}).strict()
const projectionSchema = z.object({
  p50Ms: z.number().nonnegative().nullable(),
  p90Ms: z.number().nonnegative().nullable(),
  maxMs: z.number().nonnegative().nullable(),
  sampleCount: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
}).strict()
const operationalMetricDaySchema = z.object({
  utcDate: dateSchema,
  inboundClaimed: z.number().int().nonnegative(),
  casesOpened: z.number().int().nonnegative(),
  casesAttached: z.number().int().nonnegative(),
  inboundSuppressed: z.number().int().nonnegative(),
  inboundDeadLettered: z.number().int().nonnegative(),
  unreconciled: z.number().int(),
  outboundAttempted: z.number().int().nonnegative(),
  outboundSent: z.number().int().nonnegative(),
  outboundFailed: z.number().int().nonnegative(),
  outboundUnknown: z.number().int().nonnegative(),
  unknownMaxAgeSeconds: z.number().int().nonnegative().nullable(),
  casesAssigned: z.number().int().nonnegative(),
  casesResolved: z.number().int().nonnegative(),
  casesReopened: z.number().int().nonnegative(),
  firstResponse: percentileSchema.nullable(),
  elapsedAssignedToResolution: percentileSchema.nullable(),
  projectionLag: projectionSchema.nullable(),
  suppression: z.object({
    observedMaxPermittedPerSender: z.number().int().nonnegative(),
    appliedCountLimit: z.number().int().positive().nullable(),
    withinLimit: z.boolean().nullable(),
  }).strict(),
  generatedAt: z.string().datetime(),
  stale: z.boolean(),
}).strict()
type ConnectOperationalMetricDay = z.infer<typeof operationalMetricDaySchema>
```

The DTO preserves Phase 1 counters, reconciliation inputs, outbound outcomes/unknown age, daily response/resolution percentiles with sample counts, optional projection lag, suppression result, `generatedAt`, and `stale`. It forbids source IDs, sender hash, body, subject, handle, and customer data.

`connect_analytics` resolves the reader locally through DI; absent Connect is `operationalMetrics: unavailable`, never a fabricated zero dataset. There are no cross-module entity imports, ORM relations, or side-effect imports.

## Data Models

No persisted entity is added.

The report envelope is the exact `operationalReportSchema` below. It never fabricates a range percentile from daily percentiles.

```ts
const operationalTotalsSchema = z.object({
  inboundClaimed: z.number().int(), casesOpened: z.number().int(),
  casesAttached: z.number().int(), inboundSuppressed: z.number().int(),
  inboundDeadLettered: z.number().int(), unreconciled: z.number().int(),
  outboundAttempted: z.number().int(), outboundSent: z.number().int(),
  outboundFailed: z.number().int(), outboundUnknown: z.number().int(),
  casesAssigned: z.number().int(), casesResolved: z.number().int(),
  casesReopened: z.number().int(),
}).strict()
const operationalReportSchema = z.object({
  from: dateSchema, to: dateSchema,
  requestedDays: z.number().int().nonnegative(),
  completeDays: z.number().int().nonnegative(),
  formulaVersion: z.literal('connect_analytics.operational.v1'),
  operationalMetrics: z.object({ capability: z.literal('available') }).strict(),
  days: z.array(operationalMetricDaySchema),
  totals: operationalTotalsSchema.nullable(),
}).strict()
const apiErrorSchema = z.object({
  error: z.string(),
  code: z.enum(['organization_required', 'invalid_range', 'range_too_large',
    'metrics_reader_unavailable', 'unauthorized', 'forbidden']),
}).strict()
```

## API Contracts

### `GET /api/connect_analytics/reports/operational`

Query schema is strict `{ from: dateSchema, to: dateSchema }`. Dates are inclusive; `from <= to`; maximum 92 calendar days. `to` is clamped to yesterday UTC exactly as Phase 1. If the clamp makes `from > to`, return 200 with the requested `from`, clamped `to`, `requestedDays: 0`, `completeDays: 0`, empty `days`, and null `totals`. Metadata requires auth and `connect_analytics.view`; route exports `operationalReportSchema`/`apiErrorSchema` in OpenAPI.

The 200 response is exactly `operationalReportSchema`; days are ascending and `completeDays === days.length`. Missing aggregate days are omitted, not synthesized. Errors use `apiErrorSchema`: 400 `organization_required`, 401 `unauthorized`, 403 `forbidden`, 422 `invalid_range|range_too_large`, and 503 `metrics_reader_unavailable`.

Agent-grain reporting and its ACL ID are deferred: existing facts do not carry a sanctioned agent dimension, and analytics never approximates it by querying Cases.

## Access Control

- `connect_analytics.view`: aggregate operational reports; manager default.
- Admin/superadmin receive `connect_analytics.*`; managers receive `connect_analytics.view`; employees receive neither.
- Framework wildcard matching applies; server-derived organization scope cannot be widened by query input.

## UI/UX and Internationalization

Add `/backend/connect/analytics`, guarded by `connect_analytics.view`. It **coexists** with `/backend/connect/metrics`: Metrics remains the operational/recovery surface (including exceptions and rebuild); Analytics is read-only, formula-versioned trend reporting and never links/actions a rebuild. Neither route, label, ACL, or navigation item replaces/aliases the other.

Exact `page.meta.ts`: `requireAuth: true`, `requireFeatures: ['connect_analytics.view']`, `pageTitle: 'Connect analytics'`, `pageTitleKey: 'connect_analytics.nav.title'`, `pageGroup: 'Integrations'`, `pageGroupKey: 'connect.nav.group'`, `pageOrder: 31`, `icon: 'chart-no-axes-combined'`, `pageContext: 'main'`, and matching breadcrumb key.

The page uses `Page/PageHeader/PageBody` from `@open-mercato/ui/backend/Page`; `KpiCard` from `@open-mercato/ui/backend/charts`; `SectionHeader`; semantic native table markup for exact daily values (not `DataTable`, because this is a bounded non-entity report); `Alert`, `EmptyState`, and `LoadingMessage/ErrorMessage`. The server page loads initial data; one bounded `OperationalReport.client.tsx` owns date controls/refresh. Every trend has a synchronized table/text equivalent; UTC/cohort/sample/stale/formula labels are visible and unavailable never renders as zero.

All strings use `useT`/`resolveTranslations`; `en/de/es/ko/pl` are complete. Use `apiCall`, semantic DS tokens, Lucide icons and labelled icon buttons. No raw fetch, inline SVG, arbitrary sizes, or hardcoded status colors.

Frontend contract: server shell plus the single justified client island; no provider/bootstrap change or new dependency; route-attributable bundle under 60 kB gzip; no hydration warnings; keyboard, screen-reader, high-contrast, and non-color tests.

## Performance and Cache

- One indexed source query after authorization; no N+1.
- Maximum 92 rows and 250 kB uncompressed response; p95 composition target 250 ms excluding cold DB startup.
- No cache in MVP because bounded reads expose `stale/generatedAt` and caching can conceal rebuilds. Any future cache must use DI with tenant/org/source-rebuild tags.

## Migration & Backward Compatibility

No migration/backfill. Add module, page, route, ACL IDs, and DI facade only. Existing `/api/connect/metrics/*`, `/backend/connect/metrics`, `connect.metrics.*`, entity schemas, and formulas remain unchanged. The reader DI name/required DTO fields become stable. Disabling analytics removes its API/navigation and preserves source data.

## Testing Strategy and Integration Coverage

- Unit: composition, totals, range/clamp, capability states, formula versions, and rejection of percentile averaging.
- **AN-INT-001:** tenant and sibling-organization isolation with overlapping dates.
- **AN-INT-002:** complete/incomplete/missing/stale day semantics.
- **AN-INT-003:** empty response/resolution populations remain unavailable with sample counts.
- **AN-INT-004:** delivery revisions, unknown age, reconciliation, and suppression match source DTOs.
- **AN-INT-005:** Connect reader absent produces explicit 503, never zero totals.
- **AN-INT-006:** ACL/wildcard denial matrix and organization switching.
- **AN-INT-007:** response/log/search contain no forbidden PII or identifiers.
- **AN-INT-008:** generated API/backend/metadata/ACL/DI manifests contain the exact new route/page/feature/service, and a booted app serves both new routes without a doubled module prefix.
- **AN-INT-009:** parity fixtures prove the new report matches `/api/connect/metrics/summary` for range clamp, missing/empty days, every shared counter, percentile nullability/sample counts, suppression, stale, and ordering.
- **AN-INT-010:** existing `/backend/connect/metrics` remains navigable with its exceptions/rebuild behavior while Analytics remains read-only at distinct page order 31.
- **AN-UI-001:** keyboard, screen reader, table equivalents, error/empty/unavailable/high contrast, hydration.
- **AN-UI-002:** maximum range response/bundle/performance budgets.

Fixtures are self-contained and cleaned in `finally`; existing Phase 1 integration gaps are not relabeled complete.

Executable tests live under `packages/connect/src/modules/connect_analytics/__integration__/`, use published integration helpers, and never under `.ai/qa/tests` (config only).

## Phasing

### Phase 1 — Stable Source Contract

Add the exact reader DTO/service and scoped projection; finish with unit, privacy, decoupling, Phase 1 parity, and generated DI tests passing while all existing metrics tests remain green.

### Phase 2 — Report API

Add module metadata/ACL/setup, composer, strict schemas, guarded/OpenAPI route, and generated route assertions; finish with AN-INT-001 through 009 passing against a booted app.

### Phase 3 — Read-Only Analytics UI

Add exact page metadata, server-first shared-component page, client date island, five locales, coexistence/accessibility/performance coverage; finish with AN-UI and AN-INT-010 passing and the validation gate recorded.

## Implementation Plan

1. **AN-CON-01:** sanitized scoped Connect reader, registration, DTO/privacy/decoupling tests.
2. **AN-MOD-01:** module metadata, ACL, setup grants, DI helper, locales; run `yarn generate`.
3. **AN-CMP-01:** pure versioned operational composer.
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
| `packages/connect/src/modules/connect_analytics/__integration__/TC-CONNECT-ANALYTICS-OPERATIONAL.spec.ts` | Create |

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
| API metadata/features/OpenAPI | Compliant | Exact strict schemas and AN-API-01 |
| Shared UI/i18n/DS/accessibility | Compliant | Explicit UI contract/tests |
| Additive backward compatibility | Compliant | Phase 1 surfaces unchanged |
| Encryption and optimistic CRUD | N/A | No storage/write API |

### Internal Consistency Check

Data/API/UI, risks, no-write command status, no-cache strategy, phasing, test placement, and core operational-only scope: **Pass**. Non-compliant items: none.

### Verdict

Fully compliant; pre-implementation audit remediated and ready to implement.

## Changelog

### 2026-08-22

- Narrowed to core operational reporting; SLA composition, cost, and capacity are separate specs.
- Remediated pre-implementation audit: exact stable schemas/range/error contracts, explicit phasing, correct integration-test placement, deferred inert ACL, metrics-page coexistence, exact shared components/page metadata, and generated-route/Phase 1 parity tests.
- Review: security, performance, cache, commands, risks, backward compatibility, and scope cohesion passed; verdict Ready to implement.

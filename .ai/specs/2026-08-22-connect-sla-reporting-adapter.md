# Mercato Connect — SLA Reporting Adapter

## TLDR

- Add independently activatable module `connect_sla_reporting`, consuming source-owned SLA summaries through DI.
- Expose a separate guarded API/page; do not alter core analytics' strict operational response schema.
- Missing/disabled SLA yields explicit unavailable data, never zeros; analytics remains independently deployable.

Non-goals: SLA clock/calendar/policy writes, operational-report formulas, agent drilldown, persisted report copies, routing, cost, or changing `/api/connect_analytics/reports/operational`.

## Overview

`connect_sla` owns clocks, policy/calendar versions, business-time arithmetic, and SLA formula semantics. `connect_analytics` owns core operational reporting. The new `connect_sla_reporting` module is the optional read-only adapter between product navigation and the SLA source; it can enable, disable, or roll back independently without modifying either peer's storage or API.

## Problem Statement

Direct SLA entity reads violate module isolation, duplicating clocks causes formula drift, and adding an optional field to the strict core operational report creates a cross-spec incompatibility. The earlier adapter draft also lacked a discoverable module, exact cohort/math/schema, and real activation tests.

## Proposed Solution

Add `packages/connect/src/modules/connect_sla_reporting`. It soft-resolves `connectSlaAnalyticsReader`, maps the exact source DTO without recomputing SLA, and owns a separate API `/api/connect_sla_reporting/report` plus `/backend/connect/analytics/sla`. Automatic backend page discovery is the composition seam: both Analytics and SLA Reporting appear in the same Connect navigation group at distinct stable routes/orders; neither injects into or changes the other's response/component tree.

### Decisions

| Decision | Rationale |
|---|---|
| Separate module, endpoint, page | Real independent activation; core strict schema remains byte-identical. |
| Source-owned exact summary | Calendar, clock-generation, and outcome logic stay in SLA. |
| UTC start cohort | Each clock generation belongs to `started_at` UTC date; stable under later outcomes/timezone changes. |
| Business response seconds | Measures business-calendar time from `started_at` to immutable `responded_at`; source owns calculation. |
| Completed days only | Today UTC excluded; consistent non-partial reporting. |
| No report registry/widget | Separate auto-discovered page/API is the smallest real composition seam and introduces no phantom host. |

Rejected: core response extension, direct ORM imports, hard dependency, copied report table, and undocumented dynamic registry.

## User Stories

- A manager with SLA and adapter enabled reads SLA attainment and response distributions.
- A manager with SLA unavailable sees an explicit reason rather than perfect/zero attainment.
- Disabling the adapter removes only its API/navigation; SLA clocks and operational analytics continue.
- An auditor can reproduce the cohort, formula version, exclusions, samples, and generation time.

## Architecture

```text
connect_sla clocks/calendar -> connectSlaAnalyticsReader (source-owned DI)
                                      |
                                      v soft resolve
connect_sla_reporting module -> /api/connect_sla_reporting/report
                             -> /backend/connect/analytics/sla
```

`connect_sla_reporting` owns all glue. It imports only shared source contract types from a public package path, never SLA entities. If the reader is absent, the endpoint returns an unavailable envelope. It never calls or requires `connect_analytics`; navigation grouping is metadata composition, not runtime coupling.

## Data Models and Exact Schemas

No persisted entity/migration. All schemas are strict.

```ts
const utcDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const percentileSchema = z.object({
  p50: z.number().int().nonnegative().nullable(),
  p90: z.number().int().nonnegative().nullable(),
  sampleCount: z.number().int().nonnegative(),
}).strict()
const slaDaySchema = z.object({
  utcDate: utcDateSchema,
  eligible: z.number().int().nonnegative(),
  met: z.number().int().nonnegative(),
  breached: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  mergedExcluded: z.number().int().nonnegative(),
  supersededExcluded: z.number().int().nonnegative(),
  responseBusinessSeconds: percentileSchema,
}).strict()
const slaSourceSummarySchema = z.object({
  formulaVersion: z.literal('connect_sla.attainment.v1'),
  generatedAt: z.string().datetime(),
  from: utcDateSchema,
  to: utcDateSchema,
  days: z.array(slaDaySchema),
}).strict()
const unavailableReasonSchema = z.enum([
  'module_disabled', 'reader_unavailable', 'not_authorized',
  'source_initializing', 'source_timeout', 'source_error',
])
const slaReportResponseSchema = z.discriminatedUnion('capability', [
  z.object({
    capability: z.literal('available'),
    formulaVersion: z.literal('connect_sla_reporting.adapter.v1'),
    source: slaSourceSummarySchema,
  }).strict(),
  z.object({
    capability: z.literal('unavailable'),
    formulaVersion: z.literal('connect_sla_reporting.adapter.v1'),
    reason: unavailableReasonSchema,
    source: z.null(),
  }).strict(),
])
const apiErrorSchema = z.object({
  error: z.string(),
  code: z.enum(['organization_required', 'invalid_range', 'range_too_large',
    'unauthorized', 'forbidden']),
}).strict()
```

Source DI contract:

```ts
type ConnectSlaAnalyticsReader = {
  summarize(input: {
    tenantId: string
    organizationId: string
    fromUtcDate: string
    toUtcDate: string
  }): Promise<z.infer<typeof slaSourceSummarySchema>>
}
```

Rows are `utcDate ASC`, unique by date, and exactly cover available aggregate days; missing days are omitted. `generatedAt` is one source snapshot timestamp. DTOs contain no Case/customer/policy/calendar/message/agent identifiers or names.

## Formula and Cohort Contract

- A clock **generation** cohorts by `started_at` UTC date. Every generation is considered independently.
- Eligible denominator: generations started in range whose outcome is `open|met|breached`; `merged|superseded` are excluded and counted separately. `eligible = met + breached + open` for every day.
- `met`: eligible generation has satisfied both configured response and resolution targets without either breach as of `generatedAt`.
- `breached`: either due target passed unsatisfied or was ultimately satisfied after its immutable due time. Breach is sticky for the generation.
- `open`: eligible and neither met nor breached as of `generatedAt`; open is not attainment success.
- Response samples require non-null `responded_at` with valid human evidence. Value is integer business-calendar seconds from `started_at` through `responded_at`, using the immutable calendar version referenced by the clock. Empty sample is `{p50:null,p90:null,sampleCount:0}`.
- Percentiles use nearest rank on sorted integer seconds, identical to Phase 1's algorithm. No daily percentile averaging or range percentile is reported.
- Only complete UTC cohort days are accepted; the endpoint clamps `to` to yesterday. Later outcomes may update a historical day's source summary; `generatedAt` discloses freshness.

The SLA source spec owns and must incorporate this reader, ACL, aggregate query, and formula version before adapter implementation.

## API Contracts

### `GET /api/connect_sla_reporting/report?from=YYYY-MM-DD&to=YYYY-MM-DD`

Strict query, inclusive dates, `from <= to`, max 92 days; clamp `to` to yesterday UTC. If clamp makes `from > to`, return available empty source only when the reader is available; otherwise unavailable reason. Metadata: auth plus `connect_sla_reporting.view`; OpenAPI uses exact response/error schemas.

The adapter checks its feature first, then optionally asks the SLA realm/service whether `connect_sla.reports.view` is effective. Failure/denial causes no source reader call. 200 returns available/unavailable envelope. Errors: 400 organization required, 401, 403 adapter forbidden, 422 invalid/oversized range. Reader absence/initialization/timeout/error are fail-soft 200 reasons; timeout is 2 seconds with abort/cancellation where supported and no unbounded wait.

Core `/api/connect_analytics/reports/operational` and its strict schema remain unchanged.

## Access Control

- `connect_sla.reports.view` belongs to `connect_sla`; manager/admin defaults and source reader authorization.
- `connect_sla_reporting.view` belongs to adapter; manager/admin defaults and page/API guard.
- Both must pass; wildcard checks use consolidated feature policy/RBAC services. Server-derived tenant/organization scope only.
- Adapter setup declares default role grants; disabling its module makes its ACL runtime-inert while stored grants remain.

## UI/UX and Internationalization

Page `/backend/connect/analytics/sla`; exact metadata: auth, `connect_sla_reporting.view`, title/key `Connect SLA analytics`/`connect_sla_reporting.nav.title`, group/key `Integrations`/`connect.nav.group`, order 32, icon `timer`, main context, matching breadcrumb.

Use `Page/PageHeader/PageBody`, `KpiCard`, `SectionHeader`, semantic table markup, `Alert`, `EmptyState`, and `LoadingMessage/ErrorMessage`. The server page loads initial report; a single `SlaReport.client.tsx` owns date refresh via `apiCall`. Show equation, eligible/met/breached/open/exclusions, daily nearest-rank response samples, formula versions, UTC cohort, and freshness. Every visualization has table/text equivalent. Five complete locales; semantic tokens, Lucide/labels, keyboard/screen-reader/high contrast. No provider/new dependency; client increment under 20 kB gzip; no hydration warning.

## Performance and Cache

One bounded source aggregate query, no N+1/raw clocks. Maximum 92 days and 250 kB response. Two-second source timeout. No cache; historical late outcomes and `generatedAt` must appear immediately. p95 target 250 ms under normal source availability, excluding cold startup.

## Migration & Backward Compatibility

No database migration/backfill. Add new module/ACL/DI read contract/API/page/locales and source ACL/reader only. Existing SLA, Connect, and analytics APIs/types/routes remain unchanged. New module ID, route, ACLs, DI name, formula IDs, and exact DTO required fields become stable; evolve additively or introduce new formula versions. Disabling adapter removes its route/navigation while preserving all source data.

## Testing Strategy and Integration Coverage

- Unit: strict schemas, equation, exclusions, empty samples, nearest rank, reason mapping, clamp/range/timeout.
- **SRA-INT-001:** exact available DTO from scoped source and formula passthrough.
- **SRA-INT-002:** reader/module/init/timeout/error unavailable reasons; operational analytics remains unchanged.
- **SRA-INT-003:** adapter disabled removes generated/live API/page/nav; SLA and analytics remain functional.
- **SRA-INT-004:** SLA disabled leaves adapter route live but unavailable; enable/re-enable converges.
- **SRA-INT-005:** tenant/sibling-org isolation and guessed scope rejection.
- **SRA-INT-006:** dual ACL/wildcard matrix; no source call before both checks.
- **SRA-INT-007:** cohort boundaries, all outcomes, sticky breach, late outcome revision, empty/nearest-rank business seconds.
- **SRA-INT-008:** response/log/search forbidden-field scan.
- **SRA-INT-009:** generated module/API/backend metadata/ACL/DI manifests and booted route paths (no doubled prefix).
- **SRA-INT-010:** core operational response remains byte-shape compatible with strict schema before/after adapter activation.
- **SRA-UI-001:** navigation order/coexistence, states/equation/table, keyboard/screen-reader/high contrast/hydration/bundle.

Executable tests live at `packages/connect/src/modules/connect_sla_reporting/__integration__/TC-CONNECT-SLA-REPORTING.spec.ts`, use published helpers, create/clean fixtures, and never use `.ai/qa/tests` for specs.

## Phasing

### Phase 1 — Source Contract

Update SLA spec/implementation with exact reader, formula, ACL/grants and source unit/integration coverage; complete only when stable DI/DTO and generated registration pass.

### Phase 2 — Independent Adapter API

Scaffold module/ACL/setup, soft resolver, schemas and API; complete with activation/absence/ACL/isolation/generated/live/core-compatibility tests.

### Phase 3 — Read-Only UI and Gate

Add exact page metadata, server-first UI/client range control/locales; complete with accessibility, coexistence, performance, package/root validation.

## Implementation Plan and File Manifest

1. **SRA-SRC-01:** SLA source reader/formula/ACL/setup and tests.
2. **SRA-MOD-01:** adapter index/ACL/setup/DI soft resolver and generation.
3. **SRA-API-01:** strict schemas, timeout/reason mapping, guarded/OpenAPI route.
4. **SRA-UI-01:** exact page metadata/shared components/client/locales.
5. **SRA-TEST-01:** SRA-INT/UI suite in module `__integration__`.
6. **SRA-VAL-01:** generate, package test/typecheck/build, integration, root typecheck/lint/i18n/DS; record runner.

| File | Action |
|---|---|
| `packages/connect/src/modules/connect_sla/lib/analytics-reader.ts` | Create |
| `packages/connect/src/modules/connect_sla/{di,acl,setup}.ts` | Modify |
| `packages/connect/src/modules/connect_sla_reporting/{index,acl,setup,di}.ts` | Create |
| `packages/connect/src/modules/connect_sla_reporting/data/validators.ts` | Create |
| `packages/connect/src/modules/connect_sla_reporting/api/report/route.ts` | Create |
| `packages/connect/src/modules/connect_sla_reporting/backend/connect/analytics/sla/{page.tsx,page.meta.ts}` | Create |
| `packages/connect/src/modules/connect_sla_reporting/components/SlaReport.client.tsx` | Create |
| `packages/connect/src/modules/connect_sla_reporting/i18n/{en,de,es,ko,pl}.json` | Create |
| `packages/connect/src/modules/connect_sla_reporting/__integration__/TC-CONNECT-SLA-REPORTING.spec.ts` | Create |

## Risks & Impact Review

#### False perfect SLA
- **Scenario**: absence/open/empty becomes success or zero.
- **Severity**: High
- **Affected area**: decisions
- **Mitigation**: discriminated availability, equation, open/exclusion/sample fields, no defaults.
- **Residual risk**: users must read labelled cohort/formula.

#### Formula drift
- **Scenario**: adapter reimplements calendar/outcomes.
- **Severity**: High
- **Affected area**: accuracy
- **Mitigation**: source owns exact v1 formula/DTO; adapter maps only.
- **Residual risk**: source correction requires new version/rebuild.

#### Cross-scope/ACL disclosure
- **Scenario**: source called with wrong scope or missing SLA grant.
- **Severity**: Critical
- **Affected area**: reports
- **Mitigation**: dual guard before call, server scope/source predicate, denial tests.
- **Residual risk**: future drilldowns repeat matrix.

#### Source outage delays adapter
- **Scenario**: optional source hangs.
- **Severity**: Medium
- **Affected area**: adapter only
- **Mitigation**: two-second bound/fail-soft reason; core analytics untouched.
- **Residual risk**: adapter unavailable during outage.

#### Version skew
- **Scenario**: adapter runs with older reader/DTO.
- **Severity**: Medium
- **Affected area**: activation
- **Mitigation**: soft resolution, strict parse, source_error reason, source-first landing/generation tests.
- **Residual risk**: unavailable until compatible version deployed.

## Final Compliance Report — 2026-08-22

### AGENTS.md Files Reviewed

Root, `.ai/specs`, core, UI/backend UI, shared, CLI, QA, `BACKWARD_COMPATIBILITY.md`, spec-writing/pre-implement guides.

### Compliance Matrix

| Rule | Status | Notes |
|---|---|---|
| Independent/optional module coupling | Compliant | Real adapter module, source DI, no ORM |
| Exact scope/ACL | Compliant | Dual guard/server scope/source predicate |
| Additive API/DI/ACL/generated contracts | Compliant | Separate endpoint/page; core schema unchanged |
| Integration location/discovery | Compliant | Module `__integration__` and generated/live tests |
| UI/i18n/DS/accessibility | Compliant | Exact page/components/locales/tests |
| Storage/encryption/commands | N/A | Read-only/no entity |

### Internal Consistency Check

Module activation, source formula/DTO, API/UI, no-write status, cache, risks, phases, compatibility, and adapter-only scope: **Pass**. Non-compliant items: none.

### Verdict

Fully compliant and ready to implement after source contract lands in Phase 1.

## Changelog

### 2026-08-22

- Replaced phantom registry/core-response extension with independently activatable `connect_sla_reporting`, separate exact API/page, source-owned formula/DTO, dual ACL, package-local tests, phases, and generated/live activation coverage.
- Review: security, performance, cache, commands, risks, all 13 BC categories, and scope cohesion passed; Ready to implement in pinned phase order.

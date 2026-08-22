# Mercato Connect — Cost per Contact Reporting

## TLDR

- Add independently activatable `connect_cost_reporting`, consuming already-landed bounded monetary and split-lineage denominator contracts.
- Count canonical root contacts: split descendants collapse into the root and never increase the denominator.
- Use exact rational allocation, one currency, strict capability/version contracts, and a separate API/page; add no CRUD or report storage.

Prerequisites: `2026-08-22-connect-cost-source-contract.md` and the Connect Case reparenting/split-lineage denominator contract must land first. Non-goals: source reader/query/index implementation, cost CRUD, split/merge commands/UI, FX, payroll/time rates, snapshots, operational/SLA reporting, agent drilldown.

## Overview

Cost inputs and Case lineage are independently useful source capabilities. `connect_cost_reporting` is the optional composition module required by US-A.3. It owns formula/API/UI only, imports no peer entities, can disable independently, and cannot change cost or Case data.

## Problem Statement

Raw Case counts overstate contacts after splits. Phase 1 lacks split lineage, so a `case_opened` denominator cannot satisfy the approved formula. Pulling thousands of cost rows into a report also creates avoidable memory/latency risk, while float/per-row rounding, mixed currency, missing readers, or version skew make results irreproducible.

## Proposed Solution

The landed reparenting prerequisite exposes `connectContactDenominatorReader`; the landed allocated-cost source spec exposes `connectAllocatedCostReader`. This report module soft-resolves those published contracts, validates versions/DTOs, computes exact totals/cost per contact, and exposes `/api/connect_cost_reporting/report` and `/backend/connect/analytics/cost-per-contact`.

### Decisions

| Decision | Rationale |
|---|---|
| Separate module/API/page/ACL | Real independent activation; CRUD and core analytics unchanged. |
| Root-created cohort | A contact enters once when its canonical root Case opens; later splits never create contacts in later periods. |
| Split-only collapse v1 | Approved contract names split collapse; merge semantics wait for an explicit formula version. |
| Source-side cost allocation | Bounded three-row DTO, privacy, and stable performance. |
| Exact rational strings | No float or per-row rounding drift. |
| Two soft readers with version literals | Missing/skewed peers yield explicit unavailable, not wrong values. |

## User Stories

- A manager sees agent/channel/AI/total cost per canonical contact for one currency/range.
- Splitting a Case does not increase the denominator in any period.
- Missing/old sources show explicit unavailable reasons without breaking cost CRUD or Connect.
- An auditor sees formula/source versions, exact cohort, exclusions, freshness, and input counts.

## Architecture

```text
connect_analytics cost inputs -> connectAllocatedCostReader --+
                                                         +-> connect_cost_reporting API/UI
connect split lineage -> connectContactDenominatorReader ------+
```

The consumer owns all glue and soft-resolves both readers. It imports public contract types only. Each source authorizes/scopes its own query; report authorization occurs before either call. Calls run concurrently with independent two-second bounds.

## Prerequisite Lineage Contract

Before report implementation, Connect reparenting must have landed additive nullable `split_from_case_id`, same-scope/cycle-safe split commands, the source-owned denominator, migration/snapshot, and scoped root-date index:

```sql
create index connect_cases_contact_root_date_idx
on connect_cases (tenant_id, organization_id, created_at, id)
where deleted_at is null and split_from_case_id is null;
```

Every split child points to its immediate parent in the same tenant/organization. Commands reject self/cross-scope/cycles. The denominator does not recursively query descendants: it counts non-deleted canonical roots (`split_from_case_id IS NULL`) whose own `created_at` is in `[start,end)`. Thus descendants never increase the count, including a child created in a later report period. Deleting a descendant does not change the denominator; deleting a root excludes that contact under v1 and is auditable.

Migration/snapshot/reader/index tests belong to the reparenting prerequisite, not this consumer. This spec verifies their public version/behavior through consumer contract tests and does not modify Connect schema.

## Exact Source and API Schemas

All objects are strict; integer strings match `/^-?\d+$/`, nonnegative integer strings `/^\d+$/`, ISO timestamps use `.datetime()`.

```ts
const costTypeSchema = z.enum(['agent', 'channel', 'ai'])
const rationalSchema = z.object({
  numerator: z.string().regex(/^\d+$/),
  denominator: z.string().regex(/^[1-9]\d*$/),
}).strict()
const allocatedCostSummarySchema = z.object({
  contractVersion: z.literal('connect_analytics.allocated_cost.v1'),
  generatedAt: z.string().datetime(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  matchedInputCount: z.number().int().nonnegative(),
  byType: z.array(z.object({ type: costTypeSchema, allocatedMinor: rationalSchema }).strict())
    .max(3),
}).strict()
const denominatorSummarySchema = z.object({
  contractVersion: z.literal('connect.contact_root_created.v1'),
  generatedAt: z.string().datetime(),
  count: z.number().int().nonnegative(),
}).strict()
const unavailableReasonSchema = z.enum([
  'cost_module_disabled', 'cost_reader_unavailable', 'cost_source_initializing',
  'cost_source_timeout', 'cost_source_error', 'cost_contract_version_unsupported',
  'connect_module_disabled', 'denominator_reader_unavailable', 'lineage_initializing',
  'denominator_source_timeout', 'denominator_source_error',
  'denominator_contract_version_unsupported', 'not_authorized',
])
const moneyTotalsSchema = z.object({
  agentMinor: z.string().regex(/^\d+$/),
  channelMinor: z.string().regex(/^\d+$/),
  aiMinor: z.string().regex(/^\d+$/),
  totalMinor: z.string().regex(/^\d+$/),
}).strict()
const availableReportSchema = z.object({
  capability: z.literal('available'),
  formulaVersion: z.literal('connect_cost_reporting.cost_per_contact.v1'),
  from: z.string().datetime(), to: z.string().datetime(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  totals: moneyTotalsSchema,
  denominator: z.number().int().nonnegative(),
  costPerContactMinor: z.string().regex(/^\d+$/).nullable(),
  matchedInputCount: z.number().int().nonnegative(),
  costSourceVersion: z.literal('connect_analytics.allocated_cost.v1'),
  denominatorSourceVersion: z.literal('connect.contact_root_created.v1'),
  costGeneratedAt: z.string().datetime(),
  denominatorGeneratedAt: z.string().datetime(),
}).strict()
const reportResponseSchema = z.discriminatedUnion('capability', [
  availableReportSchema,
  z.object({
    capability: z.literal('unavailable'),
    formulaVersion: z.literal('connect_cost_reporting.cost_per_contact.v1'),
    reason: unavailableReasonSchema,
    totals: z.null(), denominator: z.null(), costPerContactMinor: z.null(),
  }).strict(),
])
const apiErrorSchema = z.object({
  error: z.string(),
  code: z.enum(['organization_required', 'invalid_range', 'range_too_large',
    'invalid_currency', 'unauthorized', 'forbidden']),
}).strict()
```

Reader contracts:

```ts
type ConnectAllocatedCostReader = {
  summarizeAllocated(input: ScopedHalfOpenRange & { currencyCode: string }):
    Promise<z.infer<typeof allocatedCostSummarySchema>>
}
type ConnectContactDenominatorReader = {
  countCanonicalRoots(input: ScopedHalfOpenRange):
    Promise<z.infer<typeof denominatorSummarySchema>>
}
```

Cost `byType` is unique and sorted `agent,channel,ai`; missing types mean rational zero. Both landed readers validate non-empty range, both scopes, and maximum 366 days. This consumer strictly parses and version-checks their results but does not implement either source.

## Formula Contract

The allocated-cost source contract defines the source formula for live matching-currency rows overlapping report `[Rstart,Rend)`:

`allocated = amount_minor × milliseconds(intersection(row, report)) / milliseconds(row period)`.

The landed source adds/reduces exact fractions and never rounds. This consumer combines source fractions, rounds each displayed type and the exact grand total independently once to nearest minor unit (remainder × 2 >= denominator rounds up; amounts are nonnegative). Display buckets may sum one minor unit differently from grand total; UI labels grand total as authoritative. `costPerContactMinor` rounds the exact grand-total fraction divided by root count using the same rule; denominator zero yields null, not zero.

Canonical denominator is exactly the scoped non-deleted root-created cohort above. Formula/source version changes require new literals and UI annotation; v1 never silently adopts merge or other lineage semantics.

## API Contracts

### `GET /api/connect_cost_reporting/report?from=<ISO>&to=<ISO>&currency=PLN`

Strict query: valid ISO instants, `from < to`, duration `<= 366 * 24h` in milliseconds, uppercase supported ISO-4217 currency. Metadata requires auth and `connect_cost_reporting.view`; route exports exact OpenAPI schemas. Server derives scope.

After adapter ACL, it verifies effective `connect_analytics.cost_inputs.view`; denial makes unavailable `not_authorized` and invokes neither reader. Both source calls run concurrently with two-second timeouts. Any absence/init/timeout/error/version mismatch maps to the exact unavailable reason and no partial totals are returned. 200 available/unavailable; errors: 400 organization, 401, 403 adapter ACL, 422 invalid range/currency.

## Access Control

- `connect_cost_reporting.view`: adapter API/page, manager/admin defaults.
- `connect_analytics.cost_inputs.view`: source financial visibility, checked before calls.
- Connect denominator is aggregate/no identifier, but source still validates tenant/organization and adapter authorization context.
- Wildcards use consolidated feature policy. Stored grants remain when a module is disabled and are runtime-inert.

## UI/UX and Internationalization

Separate page `/backend/connect/analytics/cost-per-contact`; metadata: auth, `connect_cost_reporting.view`, title/key `Cost per contact`/`connect_cost_reporting.nav.title`, group/key `Integrations`/`connect.nav.group`, order 33, icon `badge-dollar-sign`, main context, matching breadcrumb. It coexists with cost-input CRUD and core/SLA analytics without modifying their pages.

Use `Page/PageHeader/PageBody`, `KpiCard`, `SectionHeader`, semantic table, `Alert`, `EmptyState`, `LoadingMessage/ErrorMessage`. Server initial load; one `CostPerContactReport.client.tsx` owns range/currency refresh via `apiCall`. Show source/formula versions, root-created split-collapse explanation, freshness, input count, exact type/grand total/denominator/result, rounding note, unavailable/zero states. Five complete locales; semantic tokens/Lucide/labels/table equivalents/keyboard/screen-reader/high contrast. No provider/new dependency/hydration warning; client increment <20 kB gzip.

## Performance and Cache

- Cost source transfers at most three rational rows regardless of input count; denominator transfers one scalar. No raw cost/Case IDs or N+1.
- Cost overlap index/performance belongs to the allocated-cost source spec; root-date partial index belongs to reparenting. Consumer transfers <=3 rationals plus one scalar.
- Each source timeout 2s; adapter normal p95 target 250 ms; response <20 kB.
- No cache: corrections/lineage/freshness must appear immediately. Source aggregation uses parameterized SQL/ORM expressions and arbitrary-precision helpers.

## Migration & Backward Compatibility

Consumer has no schema/migration. Prerequisite source specs own their additive migrations/snapshots. New report module/API/page/ACL/formula contracts are additive/stable; reader DI contracts are consumed unchanged. Existing cost CRUD and analytics/SLA/Connect routes/schemas remain unchanged. Disable consumer removes only its surfaces; disabling either source yields unavailable and preserves data.

## Testing Strategy and Integration Coverage

- Unit/property: rational GCD/addition/rounding, millisecond overlap, bucket/grand mismatch, zero denominator, strict schemas/reasons/versions.
- **CPC-INT-001:** exact type/grand/result arithmetic for full/partial/adjacent/leap/DST-independent instants.
- **CPC-INT-002:** root plus multi-level split descendants count one; descendant in later period counts zero; separate roots count separately; deleted/cross-scope/cycle cases.
- **CPC-INT-003:** tenant/sibling-org isolation for both sources and guessed scopes.
- **CPC-INT-004:** each source absent/disabled/init/timeout/error/version skew reason; no partial totals; other modules remain functional.
- **CPC-INT-005:** dual ACL/wildcards and no reader call before checks.
- **CPC-INT-006:** mixed currency exclusion/invalid currency/range/zero denominator.
- **CPC-INT-007:** forbidden financial/Case/actor/provider/description/ID fields absent from API/log/search.
- **CPC-INT-008:** generated module/API/backend metadata/ACL/DI manifests and booted route paths; enable/disable/re-enable matrix.
- **CPC-INT-009:** consumer remains constant-memory for the contract maximum of three cost DTO rows; source spec owns >10k/EXPLAIN evidence.
- **CPC-UI-001:** nav coexistence, available/unavailable/zero/rounding states, keyboard/screen-reader/high contrast/hydration/bundle.
- Module decoupling proves no peer entity import/hard requirement.

Executable tests live at `packages/connect/src/modules/connect_cost_reporting/__integration__/TC-CONNECT-COST-PER-CONTACT.spec.ts`, use published helpers, own/clean fixtures, and never live under `.ai/qa/tests`.

## Phasing

### Phase 1 — Prerequisite Contract Verification

Verify the landed Connect split-lineage denominator v1 and allocated-cost source v1 exact schemas/versions/disable behavior. Do not implement or modify either source in this spec.

### Phase 2 — Independent Report API

Scaffold module/ACL/setup, strict validators, soft resolver, exact composer/API/OpenAPI; complete with source absence/version/ACL/generated/live tests.

### Phase 3 — Read-Only UI and Gate

Add exact page/client/locales and coexistence/accessibility/performance coverage; complete package/root validation and record runner/evidence.

## Implementation Plan and File Manifest

1. **CPC-PRE-01:** verify exact landed reader versions/contracts and source disable behavior.
2. **CPC-MOD-01:** consumer module metadata/ACL/setup/DI resolver/generation.
3. **CPC-CALC-01:** rational consumer composer/property tests.
4. **CPC-API-01:** guarded/OpenAPI strict report route/timeouts/reasons.
5. **CPC-UI-01:** separate exact page/shared components/client/locales.
6. **CPC-TEST/VAL-01:** integration/browser/generated/live gates; generate, package test/typecheck/build, root typecheck/lint/i18n/DS.

| File | Action |
|---|---|
| `packages/connect/src/modules/connect_cost_reporting/{index,acl,setup,di}.ts` | Create |
| `packages/connect/src/modules/connect_cost_reporting/data/validators.ts` | Create |
| `packages/connect/src/modules/connect_cost_reporting/lib/cost-per-contact.ts` | Create |
| `packages/connect/src/modules/connect_cost_reporting/api/report/route.ts` | Create |
| `packages/connect/src/modules/connect_cost_reporting/backend/connect/analytics/cost-per-contact/{page.tsx,page.meta.ts}` | Create |
| `packages/connect/src/modules/connect_cost_reporting/components/CostPerContactReport.client.tsx` | Create |
| `packages/connect/src/modules/connect_cost_reporting/i18n/{en,de,es,ko,pl}.json` | Create |
| `packages/connect/src/modules/connect_cost_reporting/__integration__/TC-CONNECT-COST-PER-CONTACT.spec.ts` | Create |
| `apps/mercato/src/modules.ts` | Modify with host-app `connect_cost_reporting` installation entry |
| `packages/create-app/template/src/modules.ts` | Modify through `yarn template:sync:fix` for scaffold parity |

## Risks & Impact Review

#### Wrong collapse/root lineage
- **Scenario**: descendant/cycle/cross-scope relation inflates/merges contacts.
- **Severity**: Critical
- **Affected area**: denominator/report
- **Mitigation**: same-scope acyclic commands, root-only indexed query, multi-level/scope tests.
- **Residual risk**: v1 intentionally excludes future merge semantics and labels version.

#### Precision/allocation drift
- **Scenario**: float or intermediate rounding changes totals.
- **Severity**: High
- **Affected area**: financial result
- **Mitigation**: source exact reduced rationals, consumer bigint, pinned rounding/property examples.
- **Residual risk**: external allocation methods may differ; version/formula shown.

#### Cross-scope disclosure
- **Scenario**: either source leaks sibling financial/count data.
- **Severity**: Critical
- **Affected area**: API
- **Mitigation**: dual source scope, pre-call ACL, strict sanitized DTOs, denial tests.
- **Residual risk**: future drilldowns need separate scope/ACL.

#### Version/source outage
- **Scenario**: missing/old/slow source yields wrong partial report.
- **Severity**: High
- **Affected area**: availability/correctness
- **Mitigation**: strict literal parsing, two-second bounds, exact reason, no partial totals.
- **Residual risk**: adapter unavailable until compatible source returns.

#### Historical revisions
- **Scenario**: cost correction/root deletion changes old reports.
- **Severity**: Medium
- **Affected area**: audit comparison
- **Mitigation**: freshness timestamps, no cache, source audit, formula version; snapshots deferred explicitly.
- **Residual risk**: v1 is current recomputation, not period-close accounting.

## Final Compliance Report — 2026-08-22

### AGENTS.md Files Reviewed

Root, `.ai/specs`, core/customers, shared, UI/backend UI, CLI, QA, `BACKWARD_COMPATIBILITY.md`, spec-writing/pre-implement guides.

### Compliance Matrix

| Rule | Status | Notes |
|---|---|---|
| Independent optional module/no ORM | Compliant | Real report module and two source DI facades |
| Dual scope/ACL/privacy | Compliant | Pre-call guard, source predicates, sanitized DTOs |
| Exact API/Zod/OpenAPI | Compliant | Strict available/unavailable/error/version contracts |
| Schema/index migration discipline | N/A for consumer | Landed source prerequisites own migrations/snapshots |
| Integration placement/generated/live | Compliant | Module `__integration__` and activation tests |
| UI/i18n/DS/accessibility | Compliant | Separate exact page/components/locales/gates |
| Commands/encryption | N/A for report | Lineage commands owned by prerequisite spec |

### Internal Consistency Check

Landed reader prerequisites, consumer formula/API/UI, no report writes/cache, risks, phases, compatibility, and consumer-only scope: **Pass**. Non-compliant items: none.

### Verdict

Fully compliant and ready to implement in pinned phase order after/with the landed reparenting prerequisite.

## Changelog

### 2026-08-22

- Narrowed to pure `connect_cost_reporting` consumer over landed allocated-cost and split-lineage denominator prerequisites; source allocation now lives in `2026-08-22-connect-cost-source-contract.md`.
- Review: security, performance, cache, commands, risks, all 13 BC categories, and scope cohesion passed; Ready in pinned phase order.

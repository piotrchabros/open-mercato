# Mercato Connect — Allocated Cost Source Contract

## TLDR

- Extend cost accounting with a source-owned `connectAllocatedCostReader` that allocates overlapping costs exactly and returns at most three PII-free rational totals.
- Keep denominator, division, report API/UI, and Case lineage out of this spec.
- Version and test the DI contract before `connect_cost_reporting` consumes it.

## Overview

Cost-input CRUD owns periods, currencies, types, and amounts. A reporting consumer should not import its entity or transfer thousands of rows. This spec adds one independently useful read capability to the owning `connect_analytics` module: bounded exact allocation by cost type for a scoped range/currency.

## Problem Statement

The existing cost-input successor spec's row reader still exposes one DTO per overlapping input, making report memory/latency proportional to input count and duplicating allocation logic in consumers. Floating point or intermediate rounding changes totals, while adding sensitive dimensions would expand financial disclosure.

## Proposed Solution

Replace the planned row-level `connectCostInputReader.listOverlapping` with `connectAllocatedCostReader.summarizeAllocated`. The owner validates the scope/range/currency, performs exact overlap allocation inside the source boundary, combines reduced rational values by type, and returns a strict three-row maximum DTO with freshness and a literal contract version.

### Decisions

| Decision | Rationale |
|---|---|
| Source owns overlap allocation | It owns row period/amount semantics and can aggregate without disclosure. |
| Exact reduced rational strings | No float, JSON bigint, or intermediate rounding loss. |
| One currency per call | No implicit FX or mixed-minor-unit sum. |
| Max three sorted type rows | Bounded transfer independent of data cardinality. |
| Read-only additive DI contract | CRUD behavior remains independent; consumers soft-resolve it. |

## User Stories

- A reporting module obtains exact allocated agent/channel/AI costs without cost-row access.
- A finance administrator corrects inputs and the next source summary reflects the change.
- An auditor reproduces overlap allocation and contract version without seeing descriptions or provenance.

## Architecture

```text
connect_cost_inputs -> scoped overlap query -> exact rational aggregation
                                           -> connectAllocatedCostReader (DI)
```

`connect_analytics` owns entity, query, arithmetic, DTO, DI registration, and tests. It calls no peer module and emits no side effect.

## Exact Schemas and Contract

All objects are strict.

```ts
const scopedCostRangeSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  periodStart: z.date(),
  periodEnd: z.date(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
}).strict().refine((v) => v.periodStart < v.periodEnd, { path: ['periodEnd'] })
const rationalSchema = z.object({
  numerator: z.string().regex(/^\d+$/),
  denominator: z.string().regex(/^[1-9]\d*$/),
}).strict()
const allocatedCostSummarySchema = z.object({
  contractVersion: z.literal('connect_analytics.allocated_cost.v1'),
  generatedAt: z.string().datetime(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  matchedInputCount: z.number().int().nonnegative(),
  byType: z.array(z.object({
    type: z.enum(['agent', 'channel', 'ai']),
    allocatedMinor: rationalSchema,
  }).strict()).max(3),
}).strict()
type ConnectAllocatedCostReader = {
  summarizeAllocated(input: z.input<typeof scopedCostRangeSchema>):
    Promise<z.infer<typeof allocatedCostSummarySchema>>
}
```

`byType` contains only nonzero types, unique and ordered `agent,channel,ai`; empty input returns empty `byType`, count 0. Rationals are canonical: GCD-reduced and positive denominator. `generatedAt` is captured after the source query completes. The DI key is exactly `connectAllocatedCostReader` and becomes stable.

## Allocation Formula

For every live, matching-currency row satisfying `period_start < report_end AND period_end > report_start`:

`allocated = amount_minor × milliseconds(max(0, min(period_end, report_end) - max(period_start, report_start))) / milliseconds(period_end - period_start)`.

Use arbitrary-precision integer numerator/denominator. Add fractions exactly by type, reduce final type fractions by GCD, and never round. Inputs are nonnegative, so numerators are nonnegative. Half-open instants prevent boundary double count; millisecond precision matches stored timestamps and avoids duration truncation.

Maximum range is `366 * 24h` by elapsed milliseconds. Unsupported/invalid currency, invalid/oversized range, or invalid scope rejects with typed internal error codes `invalid_currency|invalid_range|range_too_large|invalid_scope`; consumers map them to their own API contracts.

## Data Models and Query/Index Contract

No new entity/column. The cost-input migration must include an overlap-supporting scoped index suitable for the source query, minimally `(tenant_id, organization_id, currency_code, period_start, period_end)` with `WHERE deleted_at IS NULL`. Implementation reviews `EXPLAIN` for >10,000 inputs; if PostgreSQL cannot use the composite index sufficiently for overlap, use an additive GiST range index in the cost-input migration with no new production dependency.

Query selects only period start/end, cost type, and amount minor. It never selects/decrypts description, source/provider ref, user/channel IDs, actors, or record IDs. One parameterized query plus in-process bounded accumulator; no N+1.

## API Contracts

No HTTP API or UI. This is an internal source DI contract. It validates inputs with Zod, scopes at source, and returns the exact DTO. Absence is represented by missing DI registration when `connect_analytics` is disabled; it does not return an unavailable DTO.

## Access Control

No new ACL: the service is internal and cannot infer caller authorization. Consumers must authorize before resolving/calling it and pass server-derived scope. Source still enforces both tenant and organization predicates. A future direct API requires a separate feature/route spec.

## Performance and Cache

- Exactly one scoped overlap query; response at most three rows and <2 kB.
- >10,000 matching inputs target p95 200 ms and bounded memory; implementation records `EXPLAIN (ANALYZE, BUFFERS)` in test/PR evidence.
- No cache. Cost corrections/undo must be visible immediately; downstream may cache only under its own versioned contract.
- Reader supports AbortSignal only if the final common DI convention adds it additively; v1 caller timeouts may stop waiting but do not mutate data.

## Migration & Backward Compatibility

Add DI contract/library/tests and the required index to the cost-input migration/snapshot. Replace the unimplemented planned row-reader before publication; no released DI key is removed. Existing Connect/cost CRUD/API/entity fields remain unchanged. The new key, required DTO fields, formula, and version literal become stable; additive optional fields or a new version are the only evolution paths. Disabling cost accounting removes registration and preserves data.

## Testing Strategy and Integration Coverage

- Unit/property: full/partial/no/adjacent/millisecond overlap, leap/DST-independent instants, GCD reduction, fraction addition, empty/missing types, very large bigint amounts, invalid inputs.
- **CSRC-INT-001:** exact agent/channel/AI summaries and stable ordering/count/version/freshness.
- **CSRC-INT-002:** tenant/sibling-org isolation with overlapping IDs/ranges.
- **CSRC-INT-003:** deleted rows and other currencies excluded; boundary rows handled half-open.
- **CSRC-INT-004:** sanitized projection/log/search contains none of the forbidden fields.
- **CSRC-INT-005:** CRUD create/update/delete/undo immediately changes source summary correctly.
- **CSRC-INT-006:** disabled module omits DI registration without affecting other modules.
- **CSRC-PERF-001:** >10k matching rows still returns <=3 rows under query/memory target with index-plan evidence.
- **CSRC-GEN-001:** generated DI/entity/migration discovery includes exact key/index and standalone build resolves the public contract.

Executable tests live at `packages/connect/src/modules/connect_analytics/__integration__/TC-CONNECT-ALLOCATED-COST-SOURCE.spec.ts`; fixtures are self-contained/cleaned.

## Phasing

### Phase 1 — Contract and Arithmetic

Add strict schemas, exact rational utilities, source reader interface and property tests; finish with byte-exact DTO fixtures.

### Phase 2 — Scoped Source Query and Index

Add reader implementation/DI and index migration/snapshot; finish with isolation/privacy/CRUD coherence/performance tests.

### Phase 3 — Generated/Standalone Gate

Run generation, package/root validation and generated/standalone discovery; publish contract only after all gates pass.

## Implementation Plan and File Manifest

1. **CSRC-CON-01:** schemas/public type/version and exact rational library.
2. **CSRC-DATA-01:** scoped projection query and reviewed index migration/snapshot.
3. **CSRC-DI-01:** stable registration and module-disabled behavior.
4. **CSRC-TEST-01:** property/integration/privacy/performance/generated coverage.
5. **CSRC-VAL-01:** generate, db diff probe, package test/typecheck/build, integration, root typecheck/lint; record runner.

| File | Action |
|---|---|
| `packages/connect/src/modules/connect_analytics/lib/allocated-cost-contract.ts` | Create |
| `packages/connect/src/modules/connect_analytics/lib/allocated-cost-reader.ts` | Create |
| `packages/connect/src/modules/connect_analytics/lib/exact-rational.ts` | Create |
| `packages/connect/src/modules/connect_analytics/di.ts` | Modify |
| Cost-input migration and `.snapshot-open-mercato.json` | Modify before publication |
| `packages/connect/src/modules/connect_analytics/__integration__/TC-CONNECT-ALLOCATED-COST-SOURCE.spec.ts` | Create |

## Risks & Impact Review

#### Precision drift
- **Scenario**: float/intermediate rounding changes allocated totals.
- **Severity**: High
- **Affected area**: all downstream cost reports
- **Mitigation**: arbitrary-precision reduced rationals and property fixtures.
- **Residual risk**: external systems may allocate differently; version/formula is explicit.

#### Cross-scope financial disclosure
- **Scenario**: source query omits tenant or organization.
- **Severity**: Critical
- **Affected area**: financial data
- **Mitigation**: mandatory Zod scope, both predicates, same-ID isolation and forbidden projection tests.
- **Residual risk**: future methods require equivalent tests.

#### Query overload
- **Scenario**: wide overlap scan degrades large organizations.
- **Severity**: Medium
- **Affected area**: DB/report latency
- **Mitigation**: required index, one projection query, bounded accumulator/DTO, >10k EXPLAIN gate.
- **Residual risk**: pathological overlap may require GiST/additional source materialization in a new spec.

#### Contract version skew
- **Scenario**: consumer expects another formula/DTO.
- **Severity**: Medium
- **Affected area**: optional consumers
- **Mitigation**: literal version, strict parse, source-first landing; consumers fail unavailable.
- **Residual risk**: report unavailable during mixed-version deploy.

## Final Compliance Report — 2026-08-22

### AGENTS.md Files Reviewed

Root, `.ai/specs`, core, shared, CLI, QA, `BACKWARD_COMPATIBILITY.md`, spec-writing/pre-implement guides.

### Compliance Matrix

| Rule | Status | Notes |
|---|---|---|
| Source-owned optional DI/no ORM | Compliant | Owner query and bounded public DTO |
| Dual scope/privacy | Compliant | Source predicates and allowlist projection |
| Zod/exact stable contract | Compliant | Strict schemas/version/formula |
| Query index/migration discipline | Compliant | Reviewed additive index/snapshot/diff probe |
| Integration/generated placement | Compliant | Module `__integration__`, generation/standalone gate |
| API/UI/commands/encryption/events | N/A | Read-only internal DTO; sensitive field never selected |

### Internal Consistency Check

Source ownership, exact arithmetic/DTO/query/index, scope/privacy, no API/UI/cache, risks, phases, and cost-source-only scope: **Pass**. Non-compliant items: none.

### Verdict

Fully compliant and ready to implement before cost-reporting consumer work.

## Changelog

### 2026-08-22

- Initial standalone allocated-cost source contract split from cost-per-contact; bounded exact reader, index/performance/privacy/version/generated gates pinned.
- Review: all 13 BC categories, security, performance, cache, commands, risks, and scope cohesion passed; Ready.

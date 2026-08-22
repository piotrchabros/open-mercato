# Mercato Connect — SLA Reporting Source Contract

## TLDR

Add one read-only, independently deployable reporting capability to `connect_sla`: a versioned attainment formula, strict summary DTO, scoped `connectSlaAnalyticsReader`, and source ACL. It has no API, page, adapter dependency, persistence, cache, notification, or report copy.

## Overview and Problem Statement

Only SLA owns generation clocks, immutable policy/calendar versions and business-time semantics. A consumer that reads entities or reimplements outcomes will drift. This source contract turns those semantics into one neutral, bounded DI projection usable by optional consumers while keeping `connect_sla` independently useful.

Out of scope: `connect_sla_reporting` activation/API/UI, core operational analytics, drilldowns, agent/customer identifiers, persisted aggregates, routing and cost.

## Architecture and Decisions

`connect_sla` owns formula, authorization and query. Consumers soft-resolve a public structural contract and never import SLA entities. No consumer is resolved by SLA. Cohort is clock-generation `started_at` UTC date; only completed UTC days; values use immutable clock/calendar state. No cache because late outcomes must appear with a fresh snapshot timestamp.

## Exact Schemas and Formula

Strict Zod schemas derive types with `z.infer`:

```ts
type Percentiles={p50:number|null;p90:number|null;sampleCount:number}
type SlaDay={utcDate:string;eligible:number;met:number;breached:number;open:number;mergedExcluded:number;supersededExcluded:number;responseBusinessSeconds:Percentiles}
type SlaSourceSummary={formulaVersion:'connect_sla.attainment.v1';generatedAt:string;from:string;to:string;days:SlaDay[]}
type ConnectSlaAnalyticsReader={summarize(input:{tenantId:string;organizationId:string;actorUserId:string;fromUtcDate:string;toUtcDate:string}):Promise<SlaSourceSummary>}
```

Dates match `YYYY-MM-DD`; generatedAt is ISO datetime; all counts/samples are nonnegative integers; p50/p90 nullable only with zero samples. Rows are unique `utcDate ASC`; missing days omitted. DTO contains no Case/customer/policy/calendar/message/agent IDs or names.

Each generation cohorts by `started_at` UTC date. Eligible outcomes are `open|met|breached`; merged/superseded are excluded and counted separately. `eligible=met+breached+open`. Met means both response and resolution targets satisfied without sticky breach at generatedAt. Breached means either target breached; later satisfaction remains breached. Open is eligible and neither. Response samples require non-null respondedAt and `human|human_accepted_ai`; value is integer business seconds from start to response using the clock's immutable calendar version. Percentiles use nearest rank on sorted seconds. Empty is null/null/0. Today UTC is rejected/excluded; accepted range is inclusive, from≤to, maximum 92 completed days. One query/snapshot timestamp; p95 target 250ms, response ≤250kB, no N+1/raw entity exposure.

## Access Control and DI

Add immutable `connect_sla.report.view` in SLA `acl.ts`; setup grants/synchronizes manager/admin defaults for new/existing tenants and wildcard behavior. Reader requires tenant, organization and actor, verifies effective source feature before querying, and applies both scope predicates. Denial is a typed indistinguishable authorization error. Register additive `connectSlaAnalyticsReader`; absence remains valid for optional consumers.

## API, UI, Data and Commands

No API/page/widget/locales. No new entity/migration/backfill: query existing clocks/calendar versions. Read-only means no command, undo, mutation guard, optimistic lock, event, queue, notification, search or cache.

## Tests and Implementation Plan

Create `connect_sla/lib/analytics-reader.ts`; modify SLA `di.ts`, `acl.ts`, `setup.ts`; add source unit/integration tests. Tests cover strict schemas, all outcome equations/exclusions, sticky breach, generation cohort boundaries, human evidence, business seconds/DST/holiday, nearest rank/empty, late revision/generatedAt, 92-day/completed-day limits, tenant/sibling-org/actor ACL/wildcards, PII forbidden fields, one-query bound, absent consumer, generated DI/ACL and existing-role grants. Fixtures are self-contained and cleaned in `finally`.

Run generate, focused tests, package build/typecheck, decoupling and standalone harness refresh; record runner. No `db:migrate`.

## Risks and Impact Review

Formula error is High and mitigated by exact versioned equations/source tests. Cross-scope disclosure is Critical and mitigated by source-owned actor ACL plus dual scope. Late historical changes are Medium and disclosed by generatedAt/no cache. Query load is Medium and bounded by 92 days/indexed aggregate. Residual risk requires a new formula version for semantic corrections.

## Migration & Backward Compatibility — All 13 Surfaces

Additive discovery changes in existing SLA files; exact additive DTO/function; no import moves; no events/widgets/APIs/DB; additive DI key and ACL ID; no notifications/CLI; additive generated DI/ACL facts only. Existing SLA contracts remain unchanged. Formula/DTO/DI/ACL become stable on release and evolve additively or via `connect_sla.attainment.v2`. No migration/backfill.

## Final Compliance Report — 2026-08-22

Scope cohesion, source ownership, isolation, scope/ACL, Zod/types, bounded performance, read-only N/A mechanisms, tests and all 13 BC categories pass. No PII/free text means encryption is N/A.

## Review — 2026-08-22

Owner selected SPLIT. This source formula/reader functions without any adapter and is correctly owned by SLA. Verdict: Ready after named maintainer contract approval and SLA clocks implementation.

## Changelog

- 2026-08-22: Split source formula/reader/ACL/query/tests from the SLA reporting adapter by owner decision.

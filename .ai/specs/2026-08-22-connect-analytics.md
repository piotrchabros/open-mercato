# Mercato Connect — Analytics and Cost Inputs

| Field | Value |
|---|---|
| Date | 2026-08-22 |
| Status | Proposed; independently deployable after Phase 1 metrics |
| Scope | `connect_analytics` reports, cost inputs, cost-per-contact; optional SLA family |
| Depends on | Phase 1 Connect metrics; optional `connect_sla`; routing-capacity foundation for readiness only |

## TLDR

Add a separately activatable, PII-free analytics module over sanctioned Phase 1 metric aggregates. It provides consistent response, resolution, delivery, suppression, and reconciliation reporting plus auditable manual/provider-invoice cost rows and a versioned cost-per-contact formula. SLA dimensions appear only when the optional SLA reader is registered; absence is unavailable, never zero.

Out of scope: message/customer content, forecasting, live routing, changing Phase 1 formulas, and provider invoice ingestion adapters.

## Overview

Phase 1 already stores immutable operational facts and deterministic daily aggregates behind stable `/api/connect/metrics/*` routes. Analytics extends rather than moves those surfaces. Connect exposes a narrow organization-scoped `connectOperationalMetricsReader`; analytics owns report composition and cost inputs. `connect_sla` exposes an optional identifier-only reader.

> **Market references:** Chatwoot separates reporting events from read models and applies common dimensions across conversation/agent/inbox/team/SLA reports. ERPNext snapshots costing rates on submitted work instead of recomputing history from current rates. We adopt explicit cohort/denominator metadata and immutable money snapshots; we reject current-owner attribution and averages without counts.

## Problem Statement

Operators cannot compare existing facts across consistent dimensions or attach cost. `amount_minor` is meaningless without currency and provenance, while deriving past cost from current rate cards rewrites history. Disabled SLA must not appear as zero breaches.

## Proposed Solution

- New `packages/connect/src/modules/connect_analytics` module with independent ACL, DI, CRUD, reports, UI, migration/snapshot and locales.
- Connect-owned reader returns only sanctioned PII-free aggregates. No cross-module ORM access.
- Cost rows snapshot currency, amount, dimensions, source and period. Results are separated by currency; no implicit FX.
- Agent dimensions require `connect_analytics.view.agents`; aggregate view never returns user IDs.
- Optional SLA capability is explicit in every response.

## Architecture

```text
Connect metric reader ─────────────┐
optional SLA analytics reader ─────┼─> report service -> scoped APIs/UI
connect_analytics cost inputs ─────┘
```

V1 uses indexed reads without cache. A future cache must be DI-resolved with tenant/org tags and invalidation on every cost/fact change.

## Data Models

### `connect_analytics_cost_input`

UUID; non-null tenant/organization; `period_start` inclusive and `period_end` exclusive UTC; `cost_type = agent|channel|ai`; nullable scalar `user_id`, `channel_id`, `provider_key`; signed non-zero safe-integer `amount_minor` (credits allowed); ISO-4217 `currency_code`; `source = manual|provider_invoice`; nullable `source_reference`; `formula_version = 1`; creator; timestamps, optimistic `updated_at`, soft delete.

Agent requires user ID, channel requires channel ID, AI requires provider key; irrelevant dimensions are null. Provider invoice requires a scoped unique source reference. No notes or invoice payloads are stored.

### Report projection

Each result includes range, cohort (`opened_utc_date|enqueue_utc_date|claim_utc_date`), formula version, numerator, denominator/sample count, nullable value, currency/dimensions, and capability state. It is a read model, not an authoritative entity.

## Commands and Events

Cost create/update/delete are undoable commands with audit snapshots and optimistic locking. Provider-invoice upsert is idempotent by scoped reference. Identifier-only events use `createModuleEvents`: `connect_analytics.cost_input.created|updated|deleted`.

## API Contracts

All routes export OpenAPI and per-method metadata.

- `GET|POST|PUT|DELETE /api/connect-analytics/cost-inputs` — `makeCrudRoute`, indexer, `.cost_inputs.view/manage`, page ≤100, `updatedAt`, 409 conflicts.
- `GET /api/connect-analytics/reports/summary?from&to&groupBy&channelId&userId&currency` — max 366 days; `connect_analytics.view`; user grouping/filter additionally requires `.view.agents`.
- `GET /api/connect-analytics/reports/cost-per-contact` — sum active costs per currency divided by Case-opened denominator; zero denominator is null.

Foreign scope returns 404. Invalid dimensions/currency/ranges return 400. Missing Connect returns 503; missing SLA returns 200 with `sla.available=false` and no SLA series.

## Metric Contracts

- Phase 1 response/resolution/delivery/suppression/reconciliation retain their writers, UTC cohorts, null semantics and late rebuild behavior.
- Every average/percentile includes sample count. Midnight and reopen facts remain in immutable cohorts.
- Cost/contact v1: cost rows overlapping the selected complete UTC range are prorated by overlap seconds, summed per currency, then divided by `cases_opened`. Metadata declares this formula. Split-collapse becomes formula v2 once re-parenting facts exist; history is not silently rewritten.
- SLA attainment groups by policy version and excludes merged/superseded clocks.

## UI/UX and i18n

`/backend/connect/analytics` reuses shared chart/KPI/filter/detail components and pairs charts with exact tables. Costs use `DataTable` and `CrudForm` with canonical helpers/conflict handling. Shared status/loading/error/empty primitives, semantic tokens, keyboard dialogs, focus/non-color encoding and icon labels are required. Locales: `en`, `de`, `es`, `ko`, `pl`.

## Integration Test Coverage

- Tenant/org denial matrix and same IDs across sibling scopes.
- Cost guards/undo/provider dedupe/optimistic 409/credits/limits/proration/mixed currencies/zero denominator.
- Phase 1 formula consistency, late outcomes, midnight cohorts, empty samples and counts.
- SLA absent/disabled/present; merged clocks excluded; agent dimensions denied without `.view.agents` including wildcard cases.
- Storage/API/log/search scans prohibit message content, handles, customer IDs and invoice payloads.
- Accessible chart/table/filter/CRUD flows and five locales.

## Migration & Backward Compatibility

All additions are new tables, routes, ACLs, events and DI services. Existing `/api/connect/metrics/*`, `connect.metrics.*`, fact types and formulas stay unchanged. Published formula versions never reinterpret history. Migration/snapshot contain only intended schema; automation does not apply migrations.

## Risks & Impact Review

#### Misleading cost history
- **Scenario:** Currency/rate changes or overlaps rewrite cost.
- **Severity:** High
- **Affected area:** Cost-per-contact.
- **Mitigation:** Immutable amount/currency/provenance, explicit proration/formula version, visible credits.
- **Residual risk:** Manual inputs can be wrong; audit/undo exposes corrections.

#### PII leakage through dimensions
- **Scenario:** Agent/customer/message details enter broad responses.
- **Severity:** Critical
- **Affected area:** Analytics storage/API.
- **Mitigation:** Reader allowlist, no customer dimension, separate agent ACL, forbidden-field scans.
- **Residual risk:** Restricted user IDs remain personal data.

#### Optional family shown as zero
- **Scenario:** Disabled SLA appears perfect.
- **Severity:** High
- **Affected area:** Decisions.
- **Mitigation:** Capability envelope and omitted unavailable series.
- **Residual risk:** External consumers must honor the field.

## Implementation Plan

1. **ANA-SEAM:** scoped Connect metric reader and optional SLA reader contracts/tests.
2. **ANA-DATA:** scaffold, ACL/setup/DI, cost entity/validators, migration/snapshot.
3. **ANA-CMD/API:** undoable commands, CRUD/OpenAPI and report service/routes.
4. **ANA-UI:** dashboard and cost CRUD with five locales.
5. **ANA-TEST:** isolation, PII, arithmetic, optionality, locking and browser/accessibility.

## Final Compliance Report — 2026-08-22

### AGENTS.md Files Reviewed

- `AGENTS.md`, `.ai/specs/AGENTS.md`, `packages/core/AGENTS.md`, `packages/ui/AGENTS.md`, `packages/ui/src/backend/AGENTS.md`, `packages/events/AGENTS.md`, `packages/cli/AGENTS.md`, `packages/core/src/modules/customers/AGENTS.md`

### Compliance Matrix

| Rule | Status | Notes |
|---|---|---|
| Module isolation and scoping | Compliant | Narrow scoped readers; scalar IDs |
| Canonical CRUD/locking/guards | Compliant | Factory, commands, `CrudForm`, `updatedAt` |
| PII/encryption rules | Compliant | No free text or customer/message data |
| Sensitive agent view | Compliant | Separate `.view.agents` server authorization |
| DS/i18n/accessibility | Compliant | Shared primitives, semantic tokens, five locales |
| Additive BC | Compliant | Existing metrics unchanged |

### Internal Consistency Check

| Check | Status | Notes |
|---|---|---|
| Models match APIs/UI | Pass | Cost/report fields align |
| Commands cover mutations | Pass | All cost writes command-backed |
| Risks cover reports/writes | Pass | Cost, PII and optionality covered |
| Cache strategy | Pass | Explicit no-cache v1 |

### Verdict

Fully compliant and ready after prerequisite contracts and readiness audit.

## Changelog

### 2026-08-22

- Initial successor specification; owner chose soft-optional SLA and Phase 2 routing-capacity persistence.

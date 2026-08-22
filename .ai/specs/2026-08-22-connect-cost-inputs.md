# Mercato Connect — Cost Inputs and Cost per Contact

## TLDR

- Add auditable organization-scoped agent, channel, and AI cost rows from manual or provider-invoice sources.
- Compute versioned cost per contact using those rows and a sanctioned PII-free Connect denominator facade.
- Keep cost CRUD/accounting separate from operational reporting, SLA, and routing capacity.

Scope includes `connect_cost_input` CRUD, optimistic locking, audit/undo, currency/allocation rules, report API/UI, isolation, and formula versioning. Provider integrations/credentials, payroll/time tracking, ledger accounting, FX conversion, split/merge UI, and other Phase 2 capabilities are non-goals.

## Overview

The app spec names `period_start/end`, `cost_type`, optional channel, amount minor, and source, then defines cost per contact as attributable cost divided by Cases with split children collapsed. This spec makes the record and calculation auditable without inventing agent hours/rates or querying peer transaction tables. It adopts explicit currency, half-open periods, provenance, rational allocation, and versioned denominators.

## Problem Statement

The canonical minimum lacks currency, agent attribution, invoice identity, and period semantics; `amount_minor` is meaningless without currency. The formula mentions agent hours × rate, but Phase 2 has no authoritative time/rate source. Phase 1 also has no split lineage, so silent “split collapse” is impossible. Ambiguous implementation would yield plausible but irreproducible totals.

## Proposed Solution

Persist normalized direct cost rows in `connect_analytics`; each is an already-calculated monetary amount for half-open UTC `[period_start, period_end)`. Reports select one currency, allocate overlapping rows proportionally, and perform no FX.

Connect registers a soft-optional `connectContactDenominatorReader`. Version `connect.case_opened.v1` counts non-deleted Cases created in the period. When split lineage exists, Connect adds a new denominator version that collapses children; old formula meaning never changes silently.

### Decisions

| Decision | Rationale |
|---|---|
| Agent rows store `user_id` plus final amount | No sanctioned hours/rate source; external calculation retains provenance. |
| Currency required per row | Minor units across currencies cannot be summed. |
| Half-open UTC periods | Adjacent periods do not double-count; DST-independent. |
| Provider reference unique when present | Supports import retries without building provider ingestion. |
| Soft delete, undo commands, optimistic lock | Financial inputs require auditability and conflict protection. |
| Connect owns denominator | Connect owns Case/lineage semantics; analytics owns cost composition. |

Rejected: organization-default currency without snapshot, float money, direct Case queries, inferred manual-row deduplication, hard Connect dependency, and pretending split collapse exists.

## User Stories

- An administrator records monthly channel/AI spend from an invoice.
- An operations user records an agent-attributed direct amount calculated externally.
- A manager views cost/contact for one currency with denominator/formula versions.
- An auditor corrects or deletes a row with conflict protection, provenance, and undo.

## Architecture

```text
CrudForm/DataTable -> cost commands -> connect_cost_inputs --+
connectContactDenominatorReader (soft optional) -------------+-> versioned cost report API/UI
```

`connect_analytics` owns optional glue and resolves the Connect facade through DI. `channel_id` and `user_id` are scalar logical IDs; there are no peer ORM relationships/imports. Conditional selectors use sanctioned peer APIs. No provider network is called.

### Denominator DI Contract

```ts
type ConnectContactDenominatorReader = {
  count(input: {
    tenantId: string
    organizationId: string
    periodStart: Date
    periodEnd: Date
  }): Promise<{ count: number; version: string }>
}
```

The source filters non-deleted Cases by both scopes and `created_at >= start AND created_at < end`. Missing reader yields `denominator_unavailable`, never zero.

## Data Models

### `ConnectCostInput` (`connect_cost_inputs`)

| Column | Type / rules |
|---|---|
| `id` | generated UUID PK |
| `tenant_id`, `organization_id` | required UUID scope |
| `period_start`, `period_end` | timestamptz; required; `end > start`; half-open UTC |
| `cost_type` | `agent | channel | ai` |
| `user_id` | UUID nullable; required only for agent |
| `channel_id` | UUID nullable; required only for channel |
| `amount_minor` | bigint, required, non-negative; JSON decimal string |
| `currency_code` | required uppercase ISO-4217 `char(3)`, validated through platform currency seam/list |
| `source` | `manual | provider_invoice` |
| `provider_invoice_ref` | normalized text max 255; required for provider invoice |
| `description` | nullable text max 500; encrypted sensitive free text |
| `created_by_user_id`, `updated_by_user_id` | server-derived UUIDs |
| `created_at`, `updated_at`, `deleted_at` | lifecycle and optimistic-lock version |

Checks enforce conditional dimensions: agent has only user, channel only channel, AI neither. Partial unique live provider identity: `(tenant_id, organization_id, cost_type, provider_invoice_ref)` when source is provider invoice, ref non-null, and not deleted. Indexes: scoped period overlap; scoped currency/type/period; scoped user and channel.

`description` is declared in module `encryption.ts` `defaultEncryptionMaps` and read via `findWithDecryption`; it is excluded from search, report DTO, logs, and errors.

## Commands and Undo

- `connect_analytics.cost_input.create`: validate/scope, persist, audit/index/invalidate; undo soft-deletes if version matches.
- `.update`: optimistic lock, encrypted before/after snapshot, actor/version, audit/index/invalidate; undo restores with conflict protection.
- `.delete`: optimistic-lock soft delete, audit/index/invalidate; undo restores if uniqueness permits.

Use `runCrudCommandWrite` and canonical CRUD side effects after commit. No domain event is needed because no peer consumes cost changes. Callback failure cannot roll back committed data and never logs description.

## API Contracts

### `GET|POST|PUT|DELETE /api/connect_analytics/cost-inputs`

Use `makeCrudRoute`, entity ID `connect_analytics:cost_input`, indexer, scoped payloads/query engine, and OpenAPI factory. Metadata requires auth; GET requires `connect_analytics.cost_inputs.view`, writes require `.manage`. Return `updatedAt`; page size default 50/max 100. Errors: unified 409 optimistic conflict, 409 duplicate provider ref, 422 field/period/currency/dimension validation, standard 401/403/404.

### `GET /api/connect_analytics/reports/cost-per-contact`

Query `from`, `to`, `currency`; maximum 366 days; guard `.view`; scope server-derived; OpenAPI/Zod schemas. Select rows overlapping the requested range. Allocate each as `amount_minor × overlap_seconds / row_period_seconds` with bigint/rational arithmetic, sum exact fractions, then round once to nearest minor unit with ties away from zero.

Return totals by type, total, denominator/count version, nullable cost/contact, currency, `costFormulaVersion: connect_analytics.cost_per_contact.v1`, and `excludedCurrencyRowCount`. Other currencies are excluded; no conversion. Zero or unavailable denominator returns null cost/contact with explicit state.

## Access Control

- `connect_analytics.cost_inputs.view`: list inputs/report; manager default.
- `connect_analytics.cost_inputs.manage`: CRUD and provenance; admin default.
- Admin/superadmin receive wildcard; employee neither. `connect_analytics.view` alone does not grant costs except through configured wildcard semantics. Every query uses framework wildcard helpers and dual scope.

## UI/UX and Internationalization

Add `/backend/connect/analytics/cost-inputs` DataTable plus CrudForm create/detail/edit and a server-first cost report section. Use `createCrud/updateCrud/deleteCrud`, automatic `updatedAt` headers, unified conflict bar, `apiCall`, shared loading/error/empty/confirmation primitives, semantic DS tokens, Lucide icons, and labelled buttons. All dialogs support Cmd/Ctrl+Enter/Escape. Zero/unavailable denominator is not rendered as zero.

All strings use `useT`/`resolveTranslations`; complete `en/de/es/ko/pl`. Client files are limited to form/table/range interactions; no provider/bootstrap/new dependency; route bundle under 70 kB gzip; no hydration warnings; keyboard/screen-reader/high-contrast coverage.

## Performance and Cache

- Indexed query-engine pagination `<=100`; report is one overlap query plus one denominator call, no N+1.
- Bigint/rational arithmetic only. Description excluded from report projection.
- MVP uncached to prevent stale accounting. If profiling later justifies DI cache, key/tag by tenant/org/currency/range; every CRUD/undo invalidates `tenant:<id>`, `org:<id>`, and `connect_analytics:cost_inputs`.

## Migration & Backward Compatibility

Add table/indexes/checks, entity ID, APIs, ACL IDs, DI reader, and UI routes only. Migration creates schema, no seed costs. Update analytics snapshot; use `yarn db:generate` only as diff probe and never automated `db:migrate`. Existing operational reports remain unchanged. Disabling analytics removes surfaces and preserves rows. Route/ACL/entity/DI/formula IDs become stable; formula changes require new versions.

## Testing Strategy and Integration Coverage

- Unit: schemas, conditional dimensions, half-open overlap, bigint rounding, mixed currencies, zero denominator, versions.
- **COST-INT-001:** CRUD/auth/features, optimistic 409, undo, soft delete, duplicate provider idempotency.
- **COST-INT-002:** tenant/sibling-org isolation including guessed IDs.
- **COST-INT-003:** all type/source conditionals and invalid period/currency/negative amount.
- **COST-INT-004:** full/partial/multiple allocations, adjacent boundaries, leap day, mixed currency, zero denominator.
- **COST-INT-005:** absent denominator facade is unavailable; source version preserved.
- **COST-INT-006:** encrypted description not plaintext at rest or in report/search/log/error; authorized scoped read decrypts.
- **COST-INT-007:** audit/index/cache callbacks and undo conflict/uniqueness.
- **COST-UI-001:** DataTable/CrudForm keyboard, conflicts, validation focus, delete shortcuts, states, accessibility.
- **COST-UI-002:** exact report table, unavailable state, bundle/hydration/performance budgets.

Fixtures are self-contained and cleaned in `finally`; no demo data/provider network.

## Implementation Plan

1. **COST-CON-01:** Connect denominator facade/registration/version/privacy/decoupling tests.
2. **COST-DATA-01:** entity, validators, encryption, migration/indexes/checks, snapshot.
3. **COST-CMD-01:** CRUD/undo/optimistic lock/audit/index/invalidation.
4. **COST-API-01:** makeCrudRoute/OpenAPI and report API.
5. **COST-CALC-01:** pure bigint overlap/formula composer.
6. **COST-UI-01:** accessible DataTable/CrudForm/report and locales.
7. **COST-TEST-01:** integration/browser/module-decoupling tests in the same change.
8. **COST-VAL-01:** generate, migration probe, package test/typecheck/build, integration, root typecheck/lint, i18n/DS checks; record runner.

### File Manifest

| File | Action |
|---|---|
| `packages/connect/src/modules/connect/lib/contact-denominator-reader.ts` | Create |
| `packages/connect/src/modules/connect/di.ts` | Modify |
| `packages/connect/src/modules/connect_analytics/data/{entities,validators}.ts` | Create |
| `packages/connect/src/modules/connect_analytics/encryption.ts` | Create |
| `packages/connect/src/modules/connect_analytics/commands/cost-inputs.ts` | Create |
| `packages/connect/src/modules/connect_analytics/api/openapi.ts` | Create |
| `packages/connect/src/modules/connect_analytics/api/cost-inputs/route.ts` | Create |
| `packages/connect/src/modules/connect_analytics/api/reports/cost-per-contact/route.ts` | Create |
| `packages/connect/src/modules/connect_analytics/lib/cost-per-contact.ts` | Create |
| `packages/connect/src/modules/connect_analytics/backend/connect/analytics/cost-inputs/**` | Create |
| `packages/connect/src/modules/connect_analytics/components/**` | Create |
| `packages/connect/src/modules/connect_analytics/i18n/{en,de,es,ko,pl}.json` | Create/Modify |
| `packages/connect/src/modules/connect_analytics/migrations/{Migration*_connect_analytics.ts,.snapshot-open-mercato.json}` | Create |
| `.ai/qa/tests/connect-cost-inputs.spec.ts` | Create |

## Risks & Impact Review

#### Money precision drift
- **Scenario**: float/per-row rounding changes totals.
- **Severity**: High
- **Affected area**: reports
- **Mitigation**: bigint rational math, sum-before-round, pinned tie rule/version/tests.
- **Residual risk**: external allocation may differ; formula is disclosed.

#### Mixed-currency misstatement
- **Scenario**: different minor units are summed.
- **Severity**: Critical
- **Affected area**: financial interpretation
- **Mitigation**: required currency, single-currency report, no FX, excluded count.
- **Residual risk**: separate reports required per currency.

#### Duplicate invoice
- **Scenario**: retry records a charge twice.
- **Severity**: High
- **Affected area**: stored/report totals
- **Mitigation**: scoped partial uniqueness and 409/idempotency tests.
- **Residual risk**: manual rows intentionally require human deduplication.

#### Cross-scope disclosure
- **Scenario**: a route/lookup omits tenant/org.
- **Severity**: Critical
- **Affected area**: costs/actors
- **Mitigation**: server-derived dual scope, scoped uniqueness, denial matrix.
- **Residual risk**: future exports repeat coverage.

#### Denominator meaning changes
- **Scenario**: later split collapse silently rewrites historical comparisons.
- **Severity**: High
- **Affected area**: trends
- **Mitigation**: source and cost formula versions; new behavior gets a new version.
- **Residual risk**: cross-version comparison needs annotation.

#### Sensitive description leakage
- **Scenario**: free text contains personal/account detail.
- **Severity**: High
- **Affected area**: privacy
- **Mitigation**: framework encryption/decryption and exclusion tests.
- **Residual risk**: authorized managers can read it by design.

#### Concurrent edit/undo
- **Scenario**: correction overwrites/restores over newer data.
- **Severity**: High
- **Affected area**: audit correctness
- **Mitigation**: optimistic locks on update/delete/undo, unified 409, snapshots/uniqueness check.
- **Residual risk**: user resolves surfaced conflicts.

## Final Compliance Report — 2026-08-22

### AGENTS.md Files Reviewed

- Root, `.ai/specs`, core/customers, shared, UI/backend UI, CLI, `BACKWARD_COMPATIBILITY.md`, and spec-writing guides.

### Compliance Matrix

| Rule | Status | Notes |
|---|---|---|
| No cross-module ORM; dual scope | Compliant | Scalar IDs and scoped DI facade |
| Optimistic locking | Compliant | `updated_at`, CrudForm, update/delete/undo 409 |
| Commands/makeCrudRoute/indexer/OpenAPI | Compliant | Canonical CRUD plan |
| Sensitive encryption | Compliant | Description map/scoped decryption |
| DataTable/CrudForm/apiCall/i18n/DS | Compliant | Explicit UI plan/tests |
| Migration/snapshot/generation | Compliant | Additive migration/diff probe |
| Backward compatibility | Compliant | Additive/versioned surfaces |

### Internal Consistency Check

Data/API/UI, write risks, command/undo coverage, no-cache policy, and cost-only cohesion: **Pass**. Non-compliant items: none.

### Verdict

Fully compliant; ready for independent scope review and pre-implementation audit.

## Changelog

### 2026-08-22

- Initial implementation-ready cost-input/cost-per-contact spec split from operational reporting.
- Review: security, performance, cache, commands, and risks passed; fresh-context scope review remains required.

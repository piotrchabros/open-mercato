# Mercato Connect — Cost Accounting Inputs

## TLDR

- Add auditable organization-scoped agent, channel, and AI cost rows from manual or provider-invoice sources.
- Keep cost CRUD/accounting separate from the cost-per-contact report, operational reporting, SLA, and routing capacity.

Scope includes `connect_cost_input` CRUD, optimistic locking, audit/undo, currency and period rules, provenance, and isolation. The planned row-level reader below is superseded before publication by `2026-08-22-connect-cost-source-contract.md`; allocated-cost aggregation and cost-per-contact remain separate capabilities.

## Overview

The app spec names `period_start/end`, `cost_type`, optional channel, amount minor, and source. This spec makes those accounting inputs auditable without inventing agent hours/rates. It adopts explicit currency, half-open periods, provenance, and canonical optimistic CRUD.

## Problem Statement

The canonical minimum lacks currency, agent attribution, invoice identity, and period semantics; `amount_minor` is meaningless without currency. The app formula mentions agent hours × rate, but Phase 2 has no authoritative time/rate source. Ambiguous inputs would make every downstream cost report irreproducible.

## Proposed Solution

Persist normalized direct cost rows in `connect_analytics`; each is an already-calculated monetary amount for half-open UTC `[period_start, period_end)`. Register a sanitized `connectCostInputReader` in the owning module so the separate cost-per-contact capability can consume scoped monetary rows without importing the entity or decrypting descriptions. The reader is additive and contains no formula or denominator logic.

### Decisions

| Decision | Rationale |
|---|---|
| Agent rows store `user_id` plus final amount | No sanctioned hours/rate source; external calculation retains provenance. |
| Currency required per row | Minor units across currencies cannot be summed. |
| Half-open UTC periods | Adjacent periods do not double-count; DST-independent. |
| Provider reference unique when present | Supports import retries without building provider ingestion. |
| Soft delete, undo commands, optimistic lock | Financial inputs require auditability and conflict protection. |
| Owner exposes sanitized cost reader | Reporting consumers do not import the entity or sensitive description. |

Rejected: organization-default currency without snapshot, float money, inferred manual-row deduplication, and coupling CRUD to any report denominator.

## User Stories

- An administrator records monthly channel/AI spend from an invoice.
- An operations user records an agent-attributed direct amount calculated externally.
- An auditor corrects or deletes a row with conflict protection, provenance, and undo.

## Architecture

```text
CrudForm/DataTable -> cost commands -> connect_cost_inputs -> sanitized connectCostInputReader
```

`connect_analytics` owns storage, commands, and its sanitized reader. `channel_id` and `user_id` are scalar logical IDs; there are no peer ORM relationships/imports. Selector routes and their feature behavior are pinned below. No provider network is called.

### Delivery Order and Module Scaffold

This capability depends on **AN-MOD-01** from `.ai/specs/2026-08-22-connect-analytics.md` landing first in the same release: that step creates `connect_analytics/{index,acl,setup,di}.ts`, its base locales, and generated module surface. If implementation begins before that commit is present, the cost-input PR must implement AN-MOD-01 unchanged before adding this slice; it must not invent a second module shell. Cost inputs then modify `acl.ts`, `setup.ts`, `di.ts`, and locales and add `data/entities.ts`, `data/validators.ts`, `encryption.ts`, `events.ts`, and `search.ts`. The base operational report and its `connect_analytics.view` grant remain byte-for-byte compatible.

`connect_analytics` remains soft-optional relative to `connect`, `currencies`, `staff`, and `communication_channels`. It has no `requires` declaration or peer entity import. It changes no upstream package and restricts Phase 2 cost rows to the organization's resolved base currency through the existing source-owned `baseCurrencyService` contract.

### Currency Validation Contract

Add the extension-owned internal adapter `costInputCurrencyResolver` over the existing structural `baseCurrencyService` contract:

```ts
type CostInputCurrencyResolver = {
  resolve(input: { tenantId: string; organizationId: string }): Promise<
    | { status: 'resolved'; code: string }
    | { status: 'missing' | 'ambiguous' | 'unavailable' }
  >
}
```

The adapter structurally soft-resolves `baseCurrencyService` and calls `resolveBaseCurrency({ tenantId, organizationIds: [organizationId] })`; it never imports the Currency entity or queries its table. Missing service/method, malformed result, disabled currencies, query failure, missing base, or ambiguous base are dependency-unavailable outcomes. Create/update fail closed with `422 currency_validation_unavailable`; a submitted uppercase code differing from the resolved code returns `422 currency_invalid`. There is no format-only or hard-coded fallback, and arbitrary non-base currency rows are out of scope for this external-extension release.

The cost form loads its singleton currency selector through sanitized `GET /api/connect_analytics/cost-input-options/currency`, guarded by `connect_analytics.cost_inputs.manage`; the route returns `{ item: { code } }` only after successful base-currency resolution and never requires or grants `currencies.view`. Missing/ambiguous dependency returns `503 currency_dependency_unavailable` and disables submit with a localized explanation. Agent and channel selectors use the existing scoped `/api/staff/team-members` (`staff.view`) and `/api/communication_channels/channels` (`communication_channels.view`) APIs only for callers who already have those features. Otherwise the relevant cost type is disabled; the server still validates UUID shape and dimension rules but deliberately does not infer peer authorization or import peer storage. Detail pages retain the stored scalar ID with localized “record unavailable” fallback if a peer record is deleted or inaccessible.

### Cost Input Reader Contract

```ts
type ConnectCostInputReader = {
  listOverlapping(input: {
    tenantId: string
    organizationId: string
    periodStart: Date
    periodEnd: Date
    currencyCode: string
  }): Promise<Array<{
    periodStart: Date
    periodEnd: Date
    costType: 'agent' | 'channel' | 'ai'
    amountMinor: string
    currencyCode: string
  }>>
}
```

The input is parsed by a Zod schema and requires `periodStart < periodEnd`, uppercase currency, and a maximum requested span of 366 days. The reader filters live rows by both scopes and exact currency with `row.period_start < input.periodEnd AND row.period_end > input.periodStart`, orders by `period_start ASC, id ASC`, and rejects with `cost_input_result_too_large` rather than returning more than 10,000 rows. It never returns description, actor IDs, provider references, user ID, or channel ID. `amountMinor` is always a canonical decimal string. Its consumer owns allocation and report semantics.

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
| `amount_minor` | bigint, required, `0..9223372036854775807`; canonical JSON decimal string |
| `currency_code` | required uppercase `[A-Z]{3}` `char(3)`, equal to the scope's resolved base currency |
| `source` | `manual | provider_invoice` |
| `provider_invoice_ref` | canonical invoice identity, text max 255; required for provider invoice |
| `provider_line_ref` | canonical invoice-line/external-item identity, text max 255; required for provider invoice |
| `description` | nullable text max 500; encrypted sensitive free text |
| `created_by_user_id`, `updated_by_user_id` | server-derived UUIDs |
| `created_at`, `updated_at`, `deleted_at` | lifecycle and optimistic-lock version |

Checks enforce conditional dimensions: agent has only user, channel only channel, AI neither. Manual rows require both provider fields null; provider-invoice rows require both. Provider references are normalized before validation by Unicode NFC, trim, internal Unicode-whitespace collapse to one ASCII space, and locale-independent lowercase; control characters are rejected and normalized length must be `1..255`. Partial unique live provider identity is `(tenant_id, organization_id, provider_invoice_ref, provider_line_ref)` when source is provider invoice and not deleted. The line key permits multiple charges from one invoice while making one external line retry-safe across cost types. Indexes: scoped period overlap; scoped currency/type/period; scoped user and channel.

`amountMinorSchema` is `z.string().regex(/^(0|[1-9][0-9]{0,18})$/)` plus a refinement `BigInt(value) <= 9223372036854775807n`. Create/update accept only this string form; JSON numbers, signs, decimals, exponent notation, whitespace, and leading zeroes are rejected with `422 amount_minor_invalid`. The command converts to `bigint` only after parsing. Every list/detail/command result/reader/audit DTO converts the ORM bigint back with `.toString()` before JSON serialization; OpenAPI declares a decimal string with the same regex and maximum. No path passes bigint to `JSON.stringify` and no path converts it to JavaScript `number`.

`description` is declared in module `encryption.ts` `defaultEncryptionMaps` and read via `findWithDecryption`; it is excluded from search, report DTO, logs, and errors.

`search.ts` registers `connect_analytics:cost_input` only for callers with `connect_analytics.cost_inputs.view`. Its source contains cost type, currency, source, and UTC period labels; it excludes amount, description, provider identities, user/channel/actor IDs, and revision IDs through `fieldPolicy.excluded`. Query-index list fields may include exact safe filters plus amount for the already-authorized DataTable, but global fulltext/vector output never contains the excluded financial/identity fields.

### `ConnectCostInputRevisionSecret` (`connect_cost_input_revision_secrets`)

Each mutation creates one tenant/organization-scoped revision-secret row in the same transaction as the cost mutation. It stores UUID `id`, `cost_input_id`, `operation`, encrypted nullable `description_before` and `description_after`, `created_at`, and no public/searchable text. Both description columns are in the module encryption map. The ordinary command/audit payload contains only non-sensitive cost fields, `descriptionChanged: boolean`, and `revisionSecretId`; it never contains plaintext or ciphertext descriptions. Undo resolves the revision by ID plus tenant, organization, and cost-input ID with five-argument `findOneWithDecryption`, restores the decrypted prior description through the normal encryption write path, and uses `extractUndoPayload`. Revision rows are retained with the audit history and have no API/UI route.

## Commands and Undo

- `connect_analytics.cost_input.create`: validate/scope, persist, revision secret, audit/index/invalidate; undo soft-deletes if version matches.
- `.update`: optimistic lock, revision secret plus redacted before/after snapshot, actor/version, audit/index/invalidate; undo restores with conflict protection.
- `.delete`: optimistic-lock soft delete, revision secret, audit/index/invalidate; undo restores if uniqueness permits.

Use `runCrudCommandWrite`, `extractUndoPayload`, scoped decryption, and canonical CRUD side effects after commit. Declare the standard additive CRUD events in `events.ts` as `connect_analytics.cost_input.created|updated|deleted`; payloads contain IDs/scope/version only and never money, actor, provider identity, or description. Callback failure cannot roll back committed data and never logs description.

## API Contracts

### `GET|POST|PUT|DELETE /api/connect_analytics/cost-inputs`

Use `makeCrudRoute`, entity ID `connect_analytics:cost_input`, indexer, scoped payloads/query engine, and OpenAPI factory. Per-method metadata is exactly GET `requireAuth + cost_inputs.view`; POST/PUT/DELETE `requireAuth + cost_inputs.manage`. Tenant and organization are always server-derived with `resolveActiveOrganizationId`; missing organization returns `400 organization_scope_required`. Client-supplied scope/actor fields are stripped and never trusted.

- **GET query**: strict `id?: uuid`, `page` default 1, `pageSize` default 50/max 100, `sortField` in `periodStart|periodEnd|costType|amountMinor|currencyCode|createdAt|updatedAt`, `sortDir`, and optional exact `costType|currencyCode|source|userId|channelId` plus overlap `periodStart/periodEnd`. Both overlap values are required together, form a valid half-open range, and are capped at 366 days. List projection excludes description; `?id=` detail includes decrypted description only after scope/feature checks. Both forms stringify amount and return `updatedAt`.
- **POST body**: strict create schema containing period, type/dimensions, `amountMinor`, currency, source/provider identities, and optional description. Server supplies ID, scope, actor, and timestamps. A new row returns `201 { id, updatedAt, replayed: false }`.
- **Provider replay**: after normalization, a unique collision loads the live row under both scopes. If every canonical accounting field (period, type/dimensions, amount, currency, provider keys, description) matches, POST returns the original `{ id, updatedAt, replayed: true }` with 200 and emits no command/event/audit duplicate. Any difference returns `409 provider_line_conflict`. This is the only idempotent replay behavior; manual rows have none.
- **PUT body**: strict create fields plus required `id`; optimistic version comes only from `If-Unmodified-Since`. Provider identity may be corrected, but uniqueness/replay is rechecked and update never silently targets the conflicting row. Returns `{ id, updatedAt }`.
- **DELETE**: strict UUID query `id`, no body scope, and required optimistic header. Returns `{ ok: true }`; already deleted/out-of-scope/guessed ID is the same 404.

Zod/schema/dimension/currency/period/money failures are mapped to localized `422` codes; duplicate changed provider line is 409; optimistic update/delete/undo uses the unified 409 conflict body; auth/feature/organization/not-found use standard 401/403/400/404. `openapi.ts` exports the exact Zod-derived item, detail, paged, create, update, replay, delete, and error schemas. No BigInt enters a response schema value.

### `GET /api/connect_analytics/cost-input-options/currency`

No query parameters; dual scope is server-derived. Guard is `connect_analytics.cost_inputs.manage`. Response is `{ item: { code } }`. Missing, ambiguous, or unavailable base-currency resolution is 503, never an empty-success response.

## Access Control

- `connect_analytics.cost_inputs.view`: list inputs; manager default.
- `connect_analytics.cost_inputs.manage`: CRUD and provenance; admin default.
- Admin/superadmin receive wildcard; employee neither. `connect_analytics.view` alone does not grant costs except through configured wildcard semantics. Every query uses framework wildcard helpers and dual scope.

`acl.ts` adds both exact feature IDs. `setup.ts` preserves the base analytics grants, adds `.view` to manager, adds `connect_analytics.*` to admin/superadmin, and grants neither cost feature to employee. `cost_inputs.manage` declares `dependsOn: ['connect_analytics.cost_inputs.view']`. Generated ACL facts and wildcard tests pin these IDs.

## UI/UX and Internationalization

Add `/backend/connect/analytics/cost-inputs` DataTable plus CrudForm create/detail/edit. Page metadata requires `.view`; create/edit actions render only with `.manage`. Use `createCrud/updateCrud/deleteCrud`, automatic `updatedAt` headers, unified conflict bar, `apiCall`, shared loading/error/empty/confirmation primitives, semantic DS tokens, Lucide icons, and labelled buttons. Currency uses the sanitized options route above. Agent/channel fields use `LookupSelect` against the exact peer routes and are disabled with localized dependency/authorization explanation when unavailable; stored inaccessible IDs render the record-unavailable fallback. All dialogs support Cmd/Ctrl+Enter/Escape.

All strings use `useT`/`resolveTranslations`; complete `en/de/es/ko/pl`. Client files are limited to form/table interactions; no provider/bootstrap/new dependency; route bundle under 60 kB gzip; no hydration warnings; keyboard/screen-reader/high-contrast coverage.

## Performance and Cache

- Indexed query-engine pagination `<=100`; no N+1. Sanitized reader is one indexed overlap query, deterministic order, maximum 366 days and 10,000 rows.
- MVP uncached to prevent stale accounting. If profiling later justifies DI cache, key/tag by tenant/org; every CRUD/undo invalidates `tenant:<id>`, `org:<id>`, and `connect_analytics:cost_inputs`.

## Migration & Backward Compatibility

Prerequisite order is base analytics AN-MOD-01, then this slice; no platform or peer module file changes. Add two tables, indexes/checks, entity/event IDs, CRUD/singleton-currency APIs, ACL IDs, `connectCostInputReader`, an extension-local adapter over existing `baseCurrencyService`, search config, and UI routes only. Migration creates schema, no seed costs. Update analytics snapshot; use `yarn db:generate` only as diff probe and never automated `db:migrate`. Generated `down()` drops only the two new analytics tables/checks/indexes; it does not alter currencies schema. Operational code rollback disables the new routes/pages/readers while intentionally retaining already-migrated rows. Existing operational reports remain unchanged. Route/ACL/entity/event/DI IDs become stable.

## Testing Strategy and Integration Coverage

- Unit: exact bigint grammar/bounds/round-trip, provider normalization, schemas, conditional dimensions, half-open periods, reader overlap/order/currency/range/result limits.
- **COST-INT-001:** CRUD/auth/features, organization selection, optimistic 409, undo, soft delete, exact provider replay versus changed-payload conflict.
- **COST-INT-002:** tenant/sibling-org isolation including guessed IDs.
- **COST-INT-003:** all type/source conditionals and invalid period/currency/negative/overflow/noncanonical amount; bigint never reaches JSON as a bigint/number.
- **COST-INT-004:** reader overlap boundaries, currency filtering, deleted-row exclusion, and sanitized DTO.
- **COST-INT-005:** encrypted description not plaintext in cost/revision tables, command/audit payload, reader/search/event/log/error; authorized scoped CRUD read and undo decrypt through revision secret.
- **COST-INT-006:** audit/index/cache callbacks, redacted snapshots, `extractUndoPayload`, undo conflict/provider uniqueness, and key-rotation-compatible revision decryption.
- **COST-INT-007:** base-currency resolver exact scope/code, singleton options-route ACL, missing/ambiguous/unavailable dependency 422/503 fail-closed behavior, and no implicit `currencies.view` grant.
- **COST-INT-008:** staff/channel selector authorization/absence and stored inaccessible-ID fallback; no cross-module entity import or hard requirement.
- **COST-INT-009:** base analytics coexistence and generated API/page/ACL/DI/event/search/entity manifests contain exact additive surfaces.
- **COST-UI-001:** DataTable/CrudForm keyboard, conflicts, validation focus, delete shortcuts, states, accessibility.
- **COST-UI-002:** maximum list, bundle/hydration/performance budgets.

Fixtures are self-contained and cleaned in `finally`; no demo data/provider network.

Executable coverage lives at `packages/connect/src/modules/connect_analytics/__integration__/TC-CONNECT-COST-INPUTS.spec.ts` with companion metadata under the same `__integration__` tree. `.ai/qa/tests` remains config-only. Browser cases use published integration helpers and are discoverable through `yarn test:integration`.

## Implementation Plan

1. **COST-BASE-01:** verify AN-MOD-01 exists; otherwise implement its module scaffold unchanged before this slice.
2. **COST-CUR-01:** extension-owned scoped `costInputCurrencyResolver` adapter over source-owned `baseCurrencyService`, with fail-closed tests.
3. **COST-DATA-01:** cost/revision entities, validators, encryption, migration/indexes/checks, snapshot.
4. **COST-CMD-01:** CRUD/undo/replay/optimistic lock/redacted audit/index/invalidation.
5. **COST-API-01:** exact guarded `makeCrudRoute`, options route, query engine, indexer, and OpenAPI.
6. **COST-READ-01:** sanitized bounded overlap reader, DI registration, privacy/decoupling tests.
7. **COST-UI-01:** accessible DataTable/CrudForm/selectors and locales.
8. **COST-TEST-01:** COST-INT-001..009 and browser/module-decoupling tests in the same change.
9. **COST-VAL-01:** generate, migration probe/no-op confirmation, package test/typecheck/build, integration, root typecheck/lint, i18n/DS checks; record runner.

### File Manifest

| File | Action |
|---|---|
| `packages/connect/src/modules/connect_analytics/{index,acl,setup,di}.ts` | Verify AN-MOD-01 exists; otherwise create from base analytics spec, then modify ACL/setup/DI additively |
| `packages/connect/src/modules/connect_analytics/data/{entities,validators}.ts` | Create |
| `packages/connect/src/modules/connect_analytics/encryption.ts` | Create |
| `packages/connect/src/modules/connect_analytics/{events,search}.ts` | Create with sanitized CRUD events/index policy |
| `packages/connect/src/modules/connect_analytics/commands/cost-inputs.ts` | Create |
| `packages/connect/src/modules/connect_analytics/api/openapi.ts` | Create |
| `packages/connect/src/modules/connect_analytics/api/cost-inputs/route.ts` | Create |
| `packages/connect/src/modules/connect_analytics/api/cost-input-options/currency/route.ts` | Create sanitized singleton selector route |
| `packages/connect/src/modules/connect_analytics/lib/cost-input-reader.ts` | Create |
| `packages/connect/src/modules/connect_analytics/lib/cost-input-currency.ts` | Create soft base-currency adapter; no peer entity import |
| `packages/connect/src/modules/connect_analytics/di.ts` | Modify |
| `packages/connect/src/modules/connect_analytics/backend/connect/analytics/cost-inputs/**` | Create |
| `packages/connect/src/modules/connect_analytics/components/**` | Create |
| `packages/connect/src/modules/connect_analytics/i18n/{en,de,es,ko,pl}.json` | Create/Modify |
| `packages/connect/src/modules/connect_analytics/migrations/{Migration*_connect_analytics.ts,.snapshot-open-mercato.json}` | Create |
| `packages/connect/src/modules/connect_analytics/lib/__tests__/cost-input-currency.test.ts` | Create scoped structural-contract and dependency-failure coverage |
| `packages/connect/src/modules/connect_analytics/__integration__/TC-CONNECT-COST-INPUTS.{spec,meta}.ts` | Create executable integration/browser coverage |

## Risks & Impact Review

#### Duplicate invoice
- **Scenario**: retry records a charge twice.
- **Severity**: High
- **Affected area**: stored costs and downstream consumers
- **Mitigation**: canonical invoice+line identities, scoped partial uniqueness, exact-payload replay returning the original result, and changed-payload 409 tests.
- **Residual risk**: manual rows intentionally require human deduplication.

#### Cross-scope disclosure
- **Scenario**: a route/lookup omits tenant/org.
- **Severity**: Critical
- **Affected area**: costs/actors
- **Mitigation**: server-derived dual scope, scoped uniqueness, denial matrix.
- **Residual risk**: future exports repeat coverage.

#### Sensitive description leakage
- **Scenario**: free text contains personal/account detail.
- **Severity**: High
- **Affected area**: privacy
- **Mitigation**: encryption maps on cost and revision-secret fields; redacted command/audit/event payloads; scoped revision decryption for undo; at-rest/search/log/error tests.
- **Residual risk**: authorized managers can read it by design.

#### Concurrent edit/undo
- **Scenario**: correction overwrites/restores over newer data.
- **Severity**: High
- **Affected area**: audit correctness
- **Mitigation**: optimistic locks on update/delete/undo, unified 409, snapshots/uniqueness check.
- **Residual risk**: user resolves surfaced conflicts.

#### Currency dependency unavailable
- **Scenario**: currencies is disabled or its reader cannot resolve, so an unverified code could be stored.
- **Severity**: High
- **Affected area**: financial meaning
- **Mitigation**: fail-closed 422 writes and 503 selector, no hard-coded/format-only acceptance, soft-optional DI, localized disabled UI.
- **Residual risk**: operators must restore/enable currencies before entering costs; existing rows remain readable.

#### Bigint precision or serialization
- **Scenario**: a money value is rounded through JavaScript number or crashes JSON serialization.
- **Severity**: High
- **Affected area**: stored amount and every API/reader consumer
- **Mitigation**: canonical bounded string schema, BigInt only after validation, string on every DTO/OpenAPI path, boundary tests.
- **Residual risk**: consumers must preserve the published string contract.

#### Base analytics delivery race
- **Scenario**: parallel implementation creates or overwrites the same module scaffold inconsistently.
- **Severity**: Medium
- **Affected area**: discovery, ACL defaults, report compatibility
- **Mitigation**: explicit AN-MOD-01 prerequisite and unchanged fallback scaffold followed only by additive modifications.
- **Residual risk**: merge conflict is possible but semantic ownership/order is now deterministic.

## Final Compliance Report — 2026-08-22

### AGENTS.md Files Reviewed

- Root, `.ai/specs`, core/customers/currencies, shared, UI/backend UI, CLI, QA, `BACKWARD_COMPATIBILITY.md`, and spec-writing guides.

### Compliance Matrix

| Rule | Status | Notes |
|---|---|---|
| No cross-module ORM; dual scope | Compliant | Scalar IDs and scoped DI facade |
| Optimistic locking | Compliant | `updated_at`, CrudForm, update/delete/undo 409 |
| Commands/makeCrudRoute/indexer/OpenAPI | Compliant | Canonical CRUD plan |
| Sensitive encryption | Compliant | Description map/scoped decryption |
| Command/audit privacy | Compliant | Revision-secret entity; redacted snapshots/events; scoped decrypted undo |
| Money transport | Compliant | Canonical bounded decimal strings; no bigint/number JSON |
| Optional currency coupling | Compliant | Currencies-owned dual-scoped reader; fail-closed analytics consumer |
| DataTable/CrudForm/apiCall/i18n/DS | Compliant | Explicit UI plan/tests |
| Migration/snapshot/generation | Compliant | Additive migration/diff probe |
| Integration placement | Compliant | Module-local `__integration__`; `.ai/qa/tests` remains config-only |
| Backward compatibility | Compliant | Additive/versioned surfaces |

### Internal Consistency Check

Data/API/UI, write risks, command/undo coverage, no-cache policy, and accounting-input-only cohesion: **Pass**. Non-compliant items: none.

### Verdict

Fully compliant after independent pre-implementation remediation; ready to implement.

## Changelog

### 2026-08-23

- Implemented the `connect_analytics` scaffold and cost-input slice. The ORM classes are named `CostInput` and `CostInputRevisionSecret` so auto-discovery generates the pinned entity IDs `connect_analytics:cost_input` and `connect_analytics:cost_input_revision_secret`; table and API contracts remain as specified.

### 2026-08-22

- Narrowed to implementation-ready cost accounting CRUD and sanitized reader; cost-per-contact is a separate spec.
- Initial review: security, performance, cache, commands, and risks passed; it requested the fresh-context audit completed below.
- Remediated audit blockers and important gaps: declared AN-MOD-01 delivery order/full scaffold, source-owned base-currency validation with fail-closed singleton selector, exact bigint schemas/transforms, encrypted revision secrets with redacted audit/undo, invoice-line replay identity, exact CRUD/OpenAPI/errors/reader bounds, ACL/setup/search/event manifests, module-local integration tests, and rollback semantics.
- Re-review: all 13 BC surfaces remain additive; security, money precision, privacy, optional coupling, test discovery, migration, and generated-contract checks pass. Verdict: ready to implement.

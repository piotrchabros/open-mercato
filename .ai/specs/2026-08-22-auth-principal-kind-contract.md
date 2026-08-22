# Auth Principal Kind Contract

## TLDR

Add a non-null `principal_kind` discriminator to `auth.User` so trusted server-side consumers can distinguish humans from system bots and integrations without inference. Existing and ordinary users remain `human`; missing, deleted, foreign-tenant, or unknown principals fail closed as non-human.

## Overview

This is the separate upstream Auth contract required by Mercato Connect SLA attribution. It owns identity classification only; SLA clocks, message attribution, bot provisioning, analytics, and UI remain outside this specification.

The first consumer is `connect_sla`: only an author proven to be `human` may stop a human-response clock. The contract is deliberately Auth-owned because principal kind is identity semantics shared by any future audit, automation, messaging, or compliance consumer; it is not communication-channel-specific metadata.

> **Market reference:** Zammad distinguishes ticket/customer/agent/system authors in stored ticket history and Chatwoot records typed reporting events instead of inferring actors from credentials. This spec adopts explicit stored identity classification and immutable downstream snapshots. It rejects adopting either product's broader ticket model and rejects runtime inference from role, email, or password state.

### Scope

- Add `human | system_bot | integration` classification to `auth.User`.
- Backfill and permanently default existing/ordinary users to `human`.
- Add an Auth-owned, batched, tenant-scoped, fail-closed read contract.
- Preserve current user creation, login, session, admin API, setup, and demo-user behavior.
- Provide migration, unit, integration, compatibility, and disabled-module coverage.

### Out of scope

- Creating the Connect bot row or deciding which integration owns it.
- SLA clocks, response attribution, case metrics, or analytics.
- Public REST or UI editing of principal kind.
- Adding principal kind to session/JWT/API-key claims.
- Reclassifying an existing principal after creation. A future audited command may define that transition.
- Replacing the communication-channel zero-UUID fallback.

## Problem Statement

`auth.User` currently cannot express whether a row represents a human, a system bot, or an integration. Password presence, roles, email conventions, and the communication-channel sentinel UUID are not reliable identity evidence.

The current `communication_channels` system-user resolver may return a real convention-based user, an assigned-user fallback, or `00000000-0000-0000-0000-000000000000`, which has no `auth.users` row. Treating a missing row or absent discriminator as human would allow an automated reply to satisfy a human-response SLA. Treating every `auth.User` as human has the same defect when a real bot row exists.

The upstream contract must also remain safe for existing installations and third-party modules that create `User` records without knowing about the new field. It must not broaden the user-admin API into a compliance-sensitive reclassification surface.

## Proposed Solution

Add an additive database-backed discriminator and expose tenant-scoped classification through the existing Auth principal service. Do not add public mutation fields or token claims.

### Invariants

1. Every persisted `users` row has exactly one supported `principal_kind` value.
2. Existing rows and callers that omit the field resolve to `human` through both ORM and database defaults.
3. Only an active same-tenant row whose stored value is exactly `human` is positive evidence of a human principal.
4. Missing, deleted, cross-tenant, malformed, null, or unsupported rows resolve to no result and therefore never count as human.
5. Organization scope does not change identity kind: the read contract is tenant-scoped because a user may be referenced by work in another allowed organization in the same tenant. It never searches outside the supplied tenant.
6. The contract never infers kind from email, password, roles, organization assignment, channel ownership, or UUID shape.
7. Public user POST/PUT, profile, login, refresh, and autologin contracts do not accept or expose the field in this delivery.
8. Auth remains independently deployable. Consumers resolve the optional method at runtime and fail closed when running against an older Auth implementation.
9. Downstream historical facts snapshot the resolved kind at the business event; later deletion or future reclassification must not retroactively rewrite outcomes.

### Design decisions

| Decision | Rationale |
|---|---|
| Auth owns the field | The value classifies a principal, not a channel, case, or message. One source prevents contradictory classifications across consumers. |
| `text` plus a database CHECK | Enforces the closed set while avoiding PostgreSQL enum migration friction if a later kind is approved. |
| Permanent database and ORM default `human` | Keeps existing inserts and third-party `em.create(User, ...)` call sites compatible. |
| Extend `AuthPrincipalService` with an optional batched method | Reuses the source-owned cross-module identity facade. Optionality preserves compatibility with existing implementations and permits fail-closed consumer behavior. |
| No REST/JWT/UI exposure | The first use is trusted server-side classification. User-admin edit access must not be able to relabel automation as human. |
| No mutable command | Creation-time classification is enough for this contract. A future transition requires dedicated ACL, audit, undo, and downstream-history semantics. |

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| `communication_channels` extension entity | Misplaces universal identity semantics in one optional transport module; principals may originate from other automation/integrations. Existing channel extensions describe ownership/assignment, not actor nature. |
| Infer from bot email convention | Convention is optional, mutable, and unavailable for the sentinel and non-channel integrations. |
| Infer from password absence | Invited humans have no password; integrations may have credentials through other mechanisms. |
| Infer from roles | Roles are mutable authorization, not identity provenance. |
| Add a required method to `AuthPrincipalService` | Narrows an exported stable interface and breaks existing implementations. |
| Add `principalKind` to user admin POST/PUT | Makes a compliance-sensitive discriminator writable under broad `auth.users.edit` access without transition rules. |
| Put the value in JWT/session claims | Produces stale classification until token refresh, changes a guarded contract surface, and is unnecessary for event attribution. |

## User Stories / Use Cases

- As a compliance-sensitive module, I can prove that an author is human before crediting a human action.
- As an existing Open Mercato operator, all existing staff continue to authenticate and behave as humans after deployment.
- As a module author creating ordinary users without the new property, my code continues to work and the row defaults to human.
- As a system-bot or integration provisioner, I can explicitly persist the correct kind through an internal trusted creation path.
- As a tenant administrator, I cannot accidentally or maliciously change principal kind through the current users screen or REST API.

## Architecture

```text
trusted provisioner
       |
       | explicit principalKind for non-human rows
       v
auth.User / users.principal_kind
       |
       | AuthPrincipalService.resolveUserPrincipalKinds(ids, tenantId)
       v
optional consumer (for example connect_sla)
       |
       | missing service/method/row/value => unknown, never human
       v
consumer-owned immutable event snapshot
```

### Source-owned read contract

Add these shared additive types in `packages/shared/src/lib/auth/principal-service.ts`:

```ts
export const AUTH_USER_PRINCIPAL_KINDS = ['human', 'system_bot', 'integration'] as const
export type AuthUserPrincipalKind = (typeof AUTH_USER_PRINCIPAL_KINDS)[number]

export type AuthUserPrincipalKindRecord = {
  id: string
  kind: AuthUserPrincipalKind
}
```

Add an optional method to `AuthPrincipalService`:

```ts
resolveUserPrincipalKinds?(input: {
  ids: string[]
  tenantId: string
}): Promise<AuthUserPrincipalKindRecord[]>
```

`DefaultAuthPrincipalService` implements it with one `findWithDecryption` query using:

- normalized, unique, non-empty input IDs;
- `id IN (...)`;
- exact `tenantId`;
- `deletedAt: null`;
- selected fields `id` and `principalKind` only;
- encryption scope `{ tenantId, organizationId: null }`.

The result contains only valid stored kinds and active matching rows. It does not synthesize records for misses. Callers map by ID and treat absence as unknown/non-human. Empty input returns immediately without a query. The initial call sites are bounded message/case authors, but the method must defensively cap normalized IDs at 1,000 and reject a larger set with an internal error; large scans are not this facade's responsibility.

This is a read-only extension of the existing `authPrincipalService` DI registration. No new DI key, event, subscriber, worker, cache, or API route is introduced.

### Cross-module consumption

The optional consumer owns the glue. It resolves `authPrincipalService` through a local `tryResolve`/registration check, verifies that `resolveUserPrincipalKinds` is a function, and treats absence or resolution failure as unknown. Auth does not import or require Connect. A consumer must still persist its own kind snapshot beside the event whose meaning depends on it.

### Commands, events, and undo

There is no new user-triggered mutation command. Migration is an additive schema transformation; ordinary creation retains current command behavior through the default. Trusted internal provisioners may pass an explicit non-human kind when constructing a new `User` entity.

No event is emitted for migration backfill or defaulted creation because this version does not introduce a supported reclassification operation. Migration rollback drops only the new column/constraint and cannot restore downstream facts; dependent consumers must be disabled or rolled back first.

## Data Models

### User (existing, additive field)

| Field | Storage | Required | Default | Rules |
|---|---|---:|---|---|
| `principalKind` / `principal_kind` | `text` | Yes | `human` | CHECK in `('human', 'system_bot', 'integration')` |

MikroORM declaration:

```ts
@Property({ name: 'principal_kind', type: 'text', default: 'human' })
principalKind: AuthUserPrincipalKind = 'human'
```

The type and constants come from the shared Auth principal contract, avoiding duplicate literals between entity, service, and consumers. This low-sensitivity operational discriminator is not PII and is not added to `auth/encryption.ts`. Existing encrypted email behavior is unchanged.

No index is added: expected reads already constrain the `users` primary key with a bounded ID set and tenant/deleted predicates. An index on a three-value discriminator would not help this access pattern.

## API Contracts

No HTTP route changes.

| Existing surface | Behavior after delivery |
|---|---|
| `POST /api/auth/users` | Does not accept `principalKind`; authoritative command Zod schema strips/rejects it according to current object parsing and persists default `human`. |
| `PUT /api/auth/users` | Does not accept or mutate `principalKind`. |
| `GET /api/auth/users` | Does not expose `principalKind`. |
| Login/autologin/session refresh/profile | Token and response shapes remain unchanged. |
| Auth principal DI facade | Optional batched method is additive; misses are omitted. |

The implementation must test the actual passthrough route-to-command boundary: the route uses a passthrough raw body, so the authoritative command schema is responsible for preventing field smuggling. The implementation must not change it to `.passthrough()`.

### Errors

- Empty ID list: `[]`, no query.
- Unknown/deleted/foreign-tenant ID: omitted from result, not distinguished by error.
- More than 1,000 normalized IDs: internal validation error; no query.
- Storage/query error: propagates from Auth. Optional consumers catch it and fail closed.

## Internationalization

N/A. No user-facing field, message, API error, or UI is introduced.

## UI/UX

N/A. The users list/edit form is intentionally unchanged. A later administration feature requires a separate specification with dedicated ACL, audit, conflict handling, i18n, and design-system review.

## Migration & Backward Compatibility

### Forward migration

The module-scoped migration adds the column and constraint atomically:

```sql
alter table "users"
  add column "principal_kind" text not null default 'human';

alter table "users"
  add constraint "users_principal_kind_check"
  check ("principal_kind" in ('human', 'system_bot', 'integration'));
```

PostgreSQL applies the default to existing rows, so there is no application-level backfill and no unbounded ORM loop. The default remains after deployment for compatibility with direct SQL and older module code.

### Rollback

Rollback first requires dependent consumers that read or persist kind-based facts to be disabled/rolled back. The Auth migration then drops `users_principal_kind_check` and `principal_kind`. Existing users otherwise retain their prior fields and behavior. Consumer snapshots intentionally remain historical evidence and are not rewritten.

### Compatibility analysis

- **Database schema:** additive column with default is explicitly allowed by `BACKWARD_COMPATIBILITY.md` §8.
- **Exported entity:** adding a property is additive; existing construction remains valid because both ORM and database supply a default.
- **Exported types/interfaces:** the new type exports are additive. The service method remains optional, so existing implementations compile and run.
- **DI:** existing `authPrincipalService` key and methods remain unchanged; adding an optional method is allowed.
- **API/token/session:** byte-for-byte shape remains unchanged.
- **Auto-discovery, routes, event IDs, ACL IDs, notification IDs, CLI commands:** unchanged.
- **Behavior:** all existing rows become `human`, matching the prior effective assumption for ordinary Auth users. Only new consumers that explicitly use this contract gain fail-closed semantics.

This core contract change requires maintainer approval before implementation. The approved spec is the required compatibility record; no deprecation or `UPGRADE_NOTES.md` entry is needed because no existing surface is removed, renamed, narrowed, or behaviorally disabled.

## Implementation Plan

### Phase 1 — Schema and source-owned contract

1. Add shared constants/types and the optional `AuthPrincipalService.resolveUserPrincipalKinds` signature.
2. Add `User.principalKind` with the shared union type and default.
3. Implement the bounded tenant-scoped method on `DefaultAuthPrincipalService`.
4. Generate/review the single Auth migration and update the Auth ORM snapshot. Do not apply it locally without explicit approval.
5. Add unit tests for defaults, classification, scoping, invalid/missing rows, empty input, deduplication, and the 1,000-ID bound.

Exit criterion: Auth builds and tests pass; schema diff is clean for Auth; existing implementations of `AuthPrincipalService` still compile.

### Phase 2 — Creation-path and compatibility proof

1. Extend setup/demo-user tests to prove primary, admin, and employee users remain human.
2. Prove trusted explicit `system_bot` and `integration` creation round-trips.
3. Prove admin API POST/PUT cannot smuggle or mutate the discriminator and GET/session responses remain unchanged.
4. Add a migration integration test over legacy rows and invalid values.
5. Add disabled/older-Auth consumer contract coverage: optional method absence and lookup failure are non-human.

Exit criterion: all API, setup, migration, isolation, and backward-compatibility cases pass; no UI or public response diff exists.

### File manifest

| File | Action | Purpose |
|---|---|---|
| `packages/shared/src/lib/auth/principal-service.ts` | Modify | Add kind constants/types and optional batched service method. |
| `packages/core/src/modules/auth/data/entities.ts` | Modify | Add mapped `principalKind` property and ORM default. |
| `packages/core/src/modules/auth/services/principalService.ts` | Modify | Implement bounded active same-tenant lookup. |
| `packages/core/src/modules/auth/migrations/Migration<timestamp>_auth.ts` | Create | Add/backfill/default/check `users.principal_kind`; reversible down SQL. |
| `packages/core/src/modules/auth/migrations/.snapshot-open-mercato.json` | Modify | Record post-migration Auth schema. |
| `packages/core/src/modules/auth/services/__tests__/principalService.test.ts` | Modify | Unit coverage for resolution, isolation, normalization, and bounds. |
| `packages/core/src/modules/auth/__tests__/cli-setup-demo-users.test.ts` | Modify | Prove every derived/primary demo user is human. |
| `packages/core/src/modules/auth/api/__tests__/users.route.test.ts` | Modify | Prove field is not writable/exposed through current admin API. |
| `packages/core/src/modules/auth/__integration__/TC-AUTH-063-principal-kind.spec.ts` | Create | Migration/default/check, tenant isolation, and trusted explicit-kind integration coverage. |
| `packages/core/src/__tests__/module-decoupling.test.ts` | Modify only if required by harness | Prove Auth does not depend on Connect and consumer absence remains valid; prefer a consumer-local test if generic coverage already suffices. |

No generated registry is expected to change because no auto-discovery file or entity class is added, but `yarn generate` remains a required verification.

### Testing strategy

| Layer | Required cases |
|---|---|
| Entity/unit | Omitted value is `human`; explicit three values persist; unsupported value is rejected by DB. |
| Principal service | Empty; duplicate IDs; valid human/bot/integration; missing; deleted; wrong tenant; null/malformed mock; >1,000; exactly one bounded query. |
| Setup/CLI | Primary/admin/employee are human; rerun/reuse does not overwrite an explicitly non-human existing principal. |
| Admin API | POST payload containing `principalKind` cannot create non-human; PUT cannot change it; GET and auth session shapes omit it. |
| Migration integration | Legacy rows become human; omitted direct insert defaults human; check rejects invalid; down migration order is documented. |
| Consumer contract | Missing service/method, query error, zero sentinel, missing row, and wrong tenant never count human. Human row does. |
| Regression | Login, invitations, password reset, role assignment, protected-role floor, and tenant-scoped email uniqueness remain green. |

Validation runner must be selected once using the repository Docker probe. Required commands, in order where applicable:

```bash
yarn db:generate
yarn generate
yarn workspace @open-mercato/core test -- principalService users.route cli-setup-demo-users
yarn workspace @open-mercato/core build
yarn typecheck
```

Review generated SQL and snapshot; re-run `yarn db:generate` as a no-op schema-diff check. Run `TC-AUTH-063` through the repository integration runner. Never run `yarn db:migrate` without approval.

## Risks & Impact Review

### Data integrity and migration

The migration is a single additive DDL operation with a constant default and check. There is no multi-entity write or background backfill. Existing user edits are unaffected. Creation-time explicit kinds are covered by the same transaction as user creation.

### Cascading effects

Auth publishes classification but does not call consumers or emit new events. Consumers own optional resolution and immutable snapshots. An Auth lookup failure reduces credited human actions rather than falsely crediting automation.

### Tenant and data isolation

The facade requires a tenant ID, filters by it in the database query, and omits misses. It does not expose email/name or distinguish foreign rows from missing rows. Organization is intentionally not a classification boundary.

### Performance and cache

The access pattern is a bounded primary-key lookup of at most 1,000 rows in one query. No extra index or cache is justified. Avoiding cache prevents stale kind results if a future audited transition is introduced; current kinds are creation-time stable.

### Operational detection

Migration/check failures are visible in the normal migration job. Consumer-side unknown counts should be separately observable in the consuming feature; Auth must not log user IDs or create high-cardinality logs on normal misses.

### Risk register

#### Unknown principal incorrectly treated as human
- **Scenario:** A zero sentinel, deleted user, foreign-tenant row, older Auth implementation, or query error is defaulted to `human` by a consumer.
- **Severity:** Critical
- **Affected area:** SLA compliance, response analytics, audit attribution.
- **Mitigation:** Contract omits misses; optional consumers must test exact `kind === 'human'`; absent method/error fails closed; mandatory integration cases cover every miss class.
- **Residual risk:** A consumer can violate the documented contract; its own integration suite and immutable snapshot requirement contain this risk.

#### Existing or third-party user creation fails
- **Scenario:** Older code omits `principalKind` after deployment.
- **Severity:** High
- **Affected area:** Tenant provisioning, invitations, CLI and module-created users.
- **Mitigation:** Permanent ORM initializer and DB `NOT NULL DEFAULT 'human'`; setup/API/CLI regression tests.
- **Residual risk:** A caller explicitly sends an invalid raw SQL value; the CHECK rejects it rather than corrupting classification.

#### Public API smuggles a non-human classification
- **Scenario:** The admin route accepts passthrough input and a caller relabels a user or creates automation under a human label.
- **Severity:** High
- **Affected area:** Auth administration and downstream compliance.
- **Mitigation:** Authoritative command Zod schemas do not include the field; tests exercise POST and PUT through the real route boundary; no UI/JWT exposure.
- **Residual risk:** Trusted internal code can explicitly set a value, which is required for provisioning and remains code-review controlled.

#### Cross-tenant classification leak
- **Scenario:** A caller supplies an ID from another tenant and receives its kind.
- **Severity:** High
- **Affected area:** Tenant isolation and identity metadata.
- **Mitigation:** Required tenant argument, database tenant predicate, active-row predicate, missing/foreign indistinguishability, integration coverage.
- **Residual risk:** Compromised database access remains outside application-level isolation.

#### Existing non-human convention rows backfill as human
- **Scenario:** A deployment already created convention-based channel bot users before this column exists; the migration cannot safely infer them and marks them human.
- **Severity:** High
- **Affected area:** First deployment of SLA attribution.
- **Mitigation:** Do not infer during Auth migration. Before enabling a consumer, its owning rollout must inventory and explicitly classify known bot/integration rows; unresolved/sentinel authors remain non-human. Consumer enablement is gated on that operational step.
- **Residual risk:** Undocumented automation rows may remain human until inventoried; avoiding heuristic reclassification prevents corrupting legitimate humans.

#### Future reclassification rewrites historical meaning
- **Scenario:** A later feature changes a principal from human to bot and reports recompute old events from current Auth state.
- **Severity:** High
- **Affected area:** Audit and historical SLA/analytics.
- **Mitigation:** This contract has no update command; consumers must snapshot kind at the event and never recompute settled facts from current state.
- **Residual risk:** Future reclassification requires a separate reviewed spec and may expose legacy unsnapshotted data limitations.

#### Large lookup degrades Auth database
- **Scenario:** A consumer attempts an unbounded author scan through the facade.
- **Severity:** Medium
- **Affected area:** Auth database latency.
- **Mitigation:** Normalize/dedupe, cap at 1,000, one primary-key query, no N+1; larger work must batch or use a worker/read model.
- **Residual risk:** Many concurrent bounded calls can still load the database; consumers should batch per operation.

#### Rollback occurs before consumers
- **Scenario:** Auth column is dropped while a deployed consumer still calls the method.
- **Severity:** Medium
- **Affected area:** Consumer classification and SLA processing.
- **Mitigation:** Document reverse dependency order: disable/rollback consumers first; consumers already fail closed when the method/query is unavailable.
- **Residual risk:** Human attribution pauses during a misordered rollback but automation is not falsely credited.

## Final Compliance Report — 2026-08-22

### AGENTS.md Files Reviewed

- `AGENTS.md` (root)
- `.ai/specs/AGENTS.md`
- `packages/core/AGENTS.md`
- `packages/core/src/modules/auth/AGENTS.md`
- `packages/core/src/modules/customers/AGENTS.md` (entity/migration reference)
- `packages/cli/AGENTS.md`
- `BACKWARD_COMPATIBILITY.md`

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|---|---|---|---|
| Root `AGENTS.md` | Check existing specs and define BC before core contract edits | Compliant | Phase 1 deferral and Connect app spec are reconciled; this separate spec owns the change. |
| Root `AGENTS.md` | Never create direct cross-module ORM relationships | Compliant | No relation added; consumers use the existing optional Auth facade. |
| Root `AGENTS.md` | Preserve tenant isolation | Compliant | Required tenant predicate; foreign IDs are omitted. Organization is intentionally not identity scope. |
| Root `AGENTS.md` | Validate inputs with Zod | Compliant | No new public input. Existing command Zod schemas exclude the field; service inputs are normalized/bounded internally. |
| Root `AGENTS.md` | Use decryption-aware user reads | Compliant | Service implementation uses `findWithDecryption`. |
| Root `AGENTS.md` | Ask before applying migrations | Compliant | Spec generates/reviews only and explicitly forbids local apply without approval. |
| `packages/core/AGENTS.md` | Entity changes use v7 decorators and migration/snapshot workflow | Compliant | Exact entity, migration, snapshot, generation, review, and no-op check are specified. |
| `packages/core/AGENTS.md` | Optional consumer owns cross-module glue and degrades gracefully | Compliant | Consumer uses optional service method and fails closed; Auth has no Connect dependency. |
| `packages/core/AGENTS.md` | Sensitive fields use encryption maps | N/A | Three-value operational discriminator is not PII/secret; existing encrypted user fields are untouched. |
| Auth `AGENTS.md` | User reads use `findWithDecryption`; do not alter token/auth semantics without approval | Compliant | Decryption helper used; token/session shapes explicitly unchanged. |
| Customers reference | Entity/migration changes keep snapshot and run generator/no-op probe | Compliant | Implementation plan and validations include both. No new CRUD slice exists. |
| CLI `AGENTS.md` | Never keep unrelated migration drift; keep snapshot synchronized | Compliant | File manifest and validation require scoped review and clean second diff. |
| `BACKWARD_COMPATIBILITY.md` | Database is additive-only; optional interface additions allowed | Compliant | Defaulted column, new exports, and optional service method are additive. |
| Spec checklist | One independently deployable capability | Compliant | Identity classification only; bot provisioning and SLA consumption are separate. |
| Spec checklist | Commands/undo for mutations | N/A | No supported reclassification mutation; schema rollback and consumer rollback order are defined. |
| Spec checklist | API/OpenAPI/UI/i18n/DS rules | N/A | No HTTP or UI surface changes. |
| Spec checklist | Cache and scale | Compliant | One bounded PK query; no cache/index justified; >1,000 rejected. |

### Internal Consistency Check

| Check | Status | Notes |
|---|---|---|
| Data model matches service contract | Pass | Closed DB set maps exactly to shared union and result type. |
| API contracts match UI/UX | Pass | Both intentionally unchanged. |
| Risks cover all writes | Pass | Migration, defaulted create, trusted explicit create, and rollback are covered. |
| Commands defined for all mutations | Pass | Existing user-create command remains authoritative; no reclassification mutation is introduced. |
| Cache strategy covers reads | Pass | Explicit no-cache decision fits bounded immutable classification reads. |
| Tenant isolation is testable | Pass | Same ID/missing/foreign/deleted cases and query predicate are named. |
| File manifest covers implementation steps | Pass | Every phase maps to a concrete file or explicit no-change proof. |

### Non-Compliant Items

None.

### Verdict

**Fully compliant: Approved — ready for implementation after named maintainer approval of the core Auth contract change.**

## Review — 2026-08-22

- **Reviewer:** Agent, adversarial checklist pass
- **Security:** Passed; public mutation excluded and fail-closed cases are mandatory
- **Performance:** Passed; bounded one-query primary-key access
- **Cache:** Passed; explicit no-cache decision avoids stale identity state
- **Commands:** Passed; no new mutable action, existing creation path retained
- **Risks:** Passed; deployment inventory and rollback ordering remain explicit operational gates
- **Verdict:** Approved pending maintainer contract sign-off

## Changelog

### 2026-08-22

- Initial implementation-ready specification for the separate upstream `auth.User.principal_kind` contract.
- Recorded default/backfill semantics, optional source-owned resolver, no-public-API decision, fail-closed consumer rule, file manifest, integration coverage, risk register, and compatibility analysis.

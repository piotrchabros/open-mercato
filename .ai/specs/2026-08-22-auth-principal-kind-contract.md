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
- Add Auth-owned, batched, tenant-and-organization-scoped, fail-closed read and trusted provisioning/remediation contracts.
- Preserve current user creation, login, session, admin API, setup, and demo-user behavior.
- Provide migration, unit, integration, compatibility, and disabled-module coverage.

### Out of scope

- Deciding which consumer needs a bot/integration or when that consumer is enabled. Auth provides the trusted creation/classification seam; the consumer owns its call and enablement gate.
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
5. Every read and write is scoped by both tenant and organization. An organization-scoped principal lookup accepts the current organization plus `organization_id IS NULL` system principals, matching the existing Auth principal-service predicate. A same-tenant principal assigned to a different organization is indistinguishable from missing.
6. The contract never infers kind from email, password, roles, organization assignment, channel ownership, or UUID shape.
7. Public user POST/PUT, profile, login, refresh, and autologin contracts do not accept or expose the field in this delivery.
8. Auth remains independently deployable. Consumers resolve optional read/provisioning capabilities at runtime and fail closed when running against an older Auth implementation.
9. Downstream historical facts snapshot the resolved kind at the business event; later deletion or future reclassification must not retroactively rewrite outcomes.

### Design decisions

| Decision | Rationale |
|---|---|
| Auth owns the field | The value classifies a principal, not a channel, case, or message. One source prevents contradictory classifications across consumers. |
| `text` plus a database CHECK | Enforces the closed set while avoiding PostgreSQL enum migration friction if a later kind is approved. |
| Permanent database and ORM default `human` | Keeps existing inserts and third-party `em.create(User, ...)` call sites compatible. |
| Extend `AuthPrincipalService` with an optional batched method | Reuses the source-owned cross-module identity facade. Optionality preserves compatibility with existing implementations and permits fail-closed consumer behavior. |
| Add a separate `authPrincipalProvisioningService` DI seam | Keeps mutation authority in Auth and out of the read facade; trusted consumers can idempotently ensure a non-human row without importing `User`. |
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
| Let consumers import `User` or update `users` directly | Violates module isolation, duplicates encryption/email-hash rules, and bypasses Auth audit and tenant/organization guards. |

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
       | AuthPrincipalService.resolveUserPrincipalKinds(ids, scope)
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
  scope: PrincipalScope
}): Promise<AuthUserPrincipalKindRecord[]>
```

`DefaultAuthPrincipalService` implements it with one `findWithDecryption` query using:

- normalized, unique, non-empty input IDs;
- `id IN (...)`;
- exact `scope.tenantId`;
- `$or: [{ organizationId: null }, { organizationId: scope.organizationId }]`;
- `deletedAt: null`;
- selected fields `id` and `principalKind` only;
- encryption scope `scope`.

The result contains only valid stored kinds and active matching rows. It does not synthesize records for misses. Callers map by ID and treat absence as unknown/non-human. Empty input returns immediately without a query. The initial call sites are bounded message/case authors, but the method must defensively cap normalized IDs at 1,000 and reject a larger set with an internal error; large scans are not this facade's responsibility.

This is a read-only extension of the existing `authPrincipalService` DI registration. It introduces no event, subscriber, worker, cache, or API route.

### Trusted provisioning and remediation contract

Add a second narrow shared interface and DI registration, `authPrincipalProvisioningService`. It is server-only and never reachable through an Auth route or browser payload:

```ts
export type NonHumanAuthUserPrincipalKind = Exclude<AuthUserPrincipalKind, 'human'>

export type EnsureNonHumanPrincipalInput = {
  scope: PrincipalScope
  kind: NonHumanAuthUserPrincipalKind
  identity:
    | { userId: string }
    | { email: string; name?: string | null }
  source: string
  reason: string
}

export type EnsureNonHumanPrincipalResult = {
  userId: string
  kind: NonHumanAuthUserPrincipalKind
  created: boolean
  changed: boolean
}

export interface AuthPrincipalProvisioningService {
  ensureNonHumanPrincipal(input: EnsureNonHumanPrincipalInput): Promise<EnsureNonHumanPrincipalResult>
}
```

The shared contract exports a strict discriminated Zod schema beside these types, and `EnsureNonHumanPrincipalInput` is `z.infer`-derived from it. Shared imports no Core/domain code; Core consumes the schema in the Auth implementation. The schema requires UUID scope/ID, a valid email, `kind` in `system_bot|integration`, `source` 1-100 characters, and `reason` 1-500 characters. It rejects `human`, unknown fields, blank strings, and both/neither identity variants. Internal validation failures use a typed `[internal]` error and never reveal whether a foreign user exists.

`ensureNonHumanPrincipal` runs in one Auth-owned transaction and is idempotent:

1. Resolve by `userId`, or by the existing tenant-scoped email/email-hash logic used by `auth.users.create`; always use `findOneWithDecryption` and the exact tenant plus `organization_id IS NULL OR scope.organizationId` predicate.
2. If `userId` is missing/deleted/foreign scope, return the same internal not-found result. Never create when a requested ID misses.
3. If email misses, create a disabled, non-login-capable Auth row (`passwordHash = null`, `isConfirmed = false`) in `scope.tenantId` and `scope.organizationId`, using `TenantDataEncryptionService`/`computeEmailHash` through Auth-owned helpers, and store the requested kind. The existing tenant/email-hash unique index is the concurrency winner; on a unique race, reload and continue.
4. If a matching row already has the requested non-human kind, return it with `created:false, changed:false`.
5. If a matching row is `human` or the other non-human kind, change it only when the caller supplies the exact user ID. Email-only calls never reclassify an existing row; they fail with an ambiguous/existing-principal result. This prevents a convention-email collision from converting a human.
6. Record an Auth audit entry containing user ID, tenant/organization, before/after kind, `source`, and `reason`, but never email or credentials. Creation and classification use the existing command/audit infrastructure with singular command ID `auth.user.ensure_non_human`; retrying an already-converged call records no second mutation event.
7. Flush classification and audit atomically using the canonical command transaction seam. A failure rolls back both.

The command is registered for internal/system-actor execution only and rejects ordinary session/API-key invocation even if the caller has `auth.users.edit`. The DI service invokes that command with trusted server context. No new ACL is introduced because there is no public/admin authorization path. A future public operation needs a separate immutable ACL, UI/API spec, optimistic lock, and explicit reclassification policy.

Existing-row remediation is therefore explicit and non-heuristic: an operator/consumer must supply the exact user ID and desired non-human kind. The service never scans or infers from email, password, role, or name.

### Cross-module consumption

The optional consumer owns the glue. It resolves `authPrincipalService` and, when provisioning is needed, `authPrincipalProvisioningService` through a local `tryResolve`/registration check. It verifies the expected method is a function and treats absence or resolution failure as an enablement failure; read misses remain unknown/non-human. Auth does not import or require Connect. A consumer must still persist its own kind snapshot beside the event whose meaning depends on it.

### Commands, events, and undo

There is no new user-triggered mutation. Migration is an additive schema transformation; ordinary creation retains current command behavior through the default. The internal `auth.user.ensure_non_human` command is the only supported non-human creation/reclassification path and owns validation, encryption, transaction, and audit behavior.

No public CRUD event is emitted for migration backfill or defaulted ordinary creation. The internal command emits/audits only a real creation or kind transition; a converged retry is a no-op. Undo for a created non-human row soft-deletes it only if no downstream reference exists; otherwise undo is rejected. Undo for classification restores the snapshotted prior kind. Migration rollback drops only the new column/constraint and cannot restore downstream facts; dependent consumers must be disabled or rolled back first.

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
| Auth provisioning DI facade | New server-only `authPrincipalProvisioningService`; no HTTP mapping. |

The implementation must test the actual passthrough route-to-command boundary: the route uses a passthrough raw body, so the authoritative command schema is responsible for preventing field smuggling. The implementation must not change it to `.passthrough()`.

### Errors

- Empty ID list: `[]`, no query.
- Unknown/deleted/foreign-tenant ID: omitted from result, not distinguished by error.
- More than 1,000 normalized IDs: internal validation error; no query.
- Storage/query error: propagates from Auth. Optional consumers catch it and fail closed.
- Provisioning foreign/missing ID or email collision: one indistinguishable typed internal failure; no account-existence detail.
- Provisioning dependency/service absence: consumer enablement fails; it never silently falls back to a direct Auth write.

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

### Enablement inventory and remediation

The migration itself never guesses which legacy rows are automation. Before enabling any kind-sensitive consumer:

1. The consumer produces a bounded dry-run inventory of the exact principal IDs it already uses as known bots/integrations, sourced from its own durable configuration/evidence. Auth performs no global scan and no email heuristic.
2. For each exact ID, the consumer calls `ensureNonHumanPrincipal` with trusted tenant+organization scope, desired kind, stable `source` (for example `connect_sla.enablement`), and a reason referencing the rollout. Missing/foreign/ambiguous rows fail the run.
3. For a bot that does not yet have a row, the consumer may call the email identity branch; Auth creates the disabled row or fails if that email already exists. A collision requires operator review and a subsequent exact-ID call; it is never auto-converted.
4. The action is rerunnable: converged entries return `changed:false`; failures remain listed. The report contains counts and IDs but no email/PII.
5. Enablement is a hard gate: zero unresolved known principals, provisioning service present, and a verification read returning the expected non-human kind in the same `PrincipalScope`. Otherwise the consumer remains disabled and emits an operational error.

This is the executable bridge between the default-human backfill and Connect's real `system_bot` requirement. Unknown undocumented automation remains an operational inventory risk, never grounds for heuristic mutation.

## Implementation Plan

### Phase 1 — Schema and source-owned contract

1. Add shared constants/types and the optional `AuthPrincipalService.resolveUserPrincipalKinds` signature.
2. Add `User.principalKind` with the shared union type and default.
3. Implement the bounded tenant-scoped method on `DefaultAuthPrincipalService`.
4. Generate/review the single Auth migration and update the Auth ORM snapshot. Do not apply it locally without explicit approval.
5. Add unit tests for defaults, classification, tenant+organization scoping, invalid/missing rows, empty input, deduplication, and the 1,000-ID bound.

### Phase 2 — Trusted provisioning and remediation

1. Add the strict shared Zod schema/types and new optional `AuthPrincipalProvisioningService` contract.
2. Register `authPrincipalProvisioningService` in Auth DI and implement `auth.user.ensure_non_human` with system-actor-only execution.
3. Reuse Auth encryption/email-hash and tenant-email uniqueness mechanisms for safe disabled-row creation.
4. Add atomic before/after audit snapshots, idempotent retry behavior, collision handling, and undo constraints.
5. Add unit/command tests for create, exact-ID remediation, convergence, foreign/deleted/cross-org denial, email collision, unique race, rollback, audit redaction, and rejection of session/API-key callers.

Exit criterion: Auth builds and tests pass; schema diff is clean for Auth; existing implementations of `AuthPrincipalService` still compile.

### Phase 3 — Creation-path, migration, and compatibility proof

1. Extend setup/demo-user tests to prove primary, admin, and employee users remain human.
2. Prove trusted explicit `system_bot` and `integration` creation round-trips.
3. Prove admin API POST/PUT cannot smuggle or mutate the discriminator and GET/session responses remain unchanged.
4. Add a migration integration test over legacy rows and invalid values.
5. Add disabled/older-Auth consumer contract coverage: optional method absence and lookup failure are non-human and provisioning absence blocks enablement.
6. Exercise the inventory/remediation flow twice and prove the second pass makes no writes/audit duplicates and returns zero unresolved principals.

Exit criterion: all API, setup, migration, isolation, and backward-compatibility cases pass; no UI or public response diff exists.

### File manifest

| File | Action | Purpose |
|---|---|---|
| `packages/shared/src/lib/auth/principal-service.ts` | Modify | Add kind constants/types and optional batched service method. |
| `packages/core/src/modules/auth/data/entities.ts` | Modify | Add mapped `principalKind` property and ORM default. |
| `packages/core/src/modules/auth/services/principalService.ts` | Modify | Implement bounded active tenant+organization-scoped lookup. |
| `packages/core/src/modules/auth/services/principalProvisioningService.ts` | Create | Auth-owned idempotent non-human creation/remediation implementation. |
| `packages/core/src/modules/auth/commands/principals.ts` | Create | Register internal `auth.user.ensure_non_human` command, audit snapshots, undo, and system-actor guard. |
| `packages/core/src/modules/auth/di.ts` | Modify | Register the new server-only provisioning service under an additive key. |
| `packages/core/src/modules/auth/migrations/Migration<timestamp>_auth.ts` | Create | Add/backfill/default/check `users.principal_kind`; reversible down SQL. |
| `packages/core/src/modules/auth/migrations/.snapshot-open-mercato.json` | Modify | Record post-migration Auth schema. |
| `packages/core/src/modules/auth/services/__tests__/principalService.test.ts` | Modify | Unit coverage for resolution, isolation, normalization, and bounds. |
| `packages/core/src/modules/auth/services/__tests__/principalProvisioningService.test.ts` | Create | Zod, creation/remediation, scoping, collision/race, idempotency, and redaction coverage. |
| `packages/core/src/modules/auth/commands/__tests__/principals.test.ts` | Create | System-actor guard, atomic audit/undo, and retry coverage. |
| `packages/core/src/modules/auth/__tests__/cli-setup-demo-users.test.ts` | Modify | Prove every derived/primary demo user is human. |
| `packages/core/src/modules/auth/api/__tests__/users.route.test.ts` | Modify | Prove field is not writable/exposed through current admin API. |
| `packages/core/src/modules/auth/__integration__/TC-AUTH-063-principal-kind.spec.ts` | Create | Migration/default/check, tenant isolation, and trusted explicit-kind integration coverage. |
| `packages/core/src/modules/auth/migrations/__tests__/principal-kind.migration.test.ts` | Create | Pre-column schema, migration up/default/CHECK, and down verification in a dedicated DB harness. |
| `packages/core/src/__tests__/module-decoupling.test.ts` | Modify only if required by harness | Prove Auth does not depend on Connect and consumer absence remains valid; prefer a consumer-local test if generic coverage already suffices. |

No generated registry is expected to change because no auto-discovery file or entity class is added, but `yarn generate` remains a required verification.

### Testing strategy

| Layer | Required cases |
|---|---|
| Entity/unit | Omitted value is `human`; explicit three values persist; unsupported value is rejected by DB. |
| Principal service | Empty; duplicate IDs; valid human/bot/integration; missing; deleted; wrong tenant; same-tenant wrong organization; organization-null; null/malformed mock; >1,000; exactly one bounded query. |
| Provisioning service/command | Strict Zod; session/API-key rejection; create disabled row; exact-ID classification; collision; unique race; converged retry; atomic audit; redaction; create/classification undo. |
| Setup/CLI | Primary/admin/employee are human; rerun/reuse does not overwrite an explicitly non-human existing principal. |
| Admin API | POST payload containing `principalKind` cannot create non-human; PUT cannot change it; GET and auth session shapes omit it. |
| Migration DB harness | Pre-column legacy rows become human; omitted direct insert defaults human; check rejects invalid; down drops constraint/column. |
| Consumer contract | Missing service/method, query error, zero sentinel, missing row, and wrong tenant never count human. Human row does. |
| Enablement | Exact-ID inventory, create-by-email collision requiring review, two reruns, verification read, and hard block while any principal/service is unresolved. |
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

Both facades require `PrincipalScope`, filter tenant and `organization_id IS NULL OR scope.organizationId`, and omit or indistinguishably reject misses. They do not expose email/name or distinguish foreign rows from missing rows. Provisioning never accepts scope from a browser/API request and ordinary authenticated callers cannot invoke it.

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
- **Mitigation:** Required `PrincipalScope`, tenant plus organization/null predicates, active-row predicate, missing/foreign indistinguishability, integration coverage.
- **Residual risk:** Compromised database access remains outside application-level isolation.

#### Same-tenant cross-organization classification or mutation
- **Scenario:** A consumer submits a principal assigned to another organization in the same tenant.
- **Severity:** High
- **Affected area:** Organization isolation, audit attribution, and SLA evidence.
- **Mitigation:** Both services use the existing Auth predicate (`tenantId` plus `organizationId IS NULL OR selected organization`); same-tenant wrong-org tests cover read and provisioning paths.
- **Residual risk:** Tenant-wide principals with null organization are intentionally visible to every organization in that tenant and must be provisioned only by trusted system actors.

#### Provisioning collision converts a human
- **Scenario:** A requested bot/integration email already belongs to a human and an ensure operation reclassifies it.
- **Severity:** Critical
- **Affected area:** Authentication identity, audit, and compliance attribution.
- **Mitigation:** Email identity may create or converge only on an already matching non-human kind; it never reclassifies. Any existing human/other-kind collision fails and requires operator review plus exact user ID. Ordinary sessions/API keys cannot invoke the command.
- **Residual risk:** A trusted operator can explicitly choose the wrong exact ID; audit records source/reason and before/after kind, while downstream immutable snapshots prevent retroactive rewriting.

#### Provisioning partially commits user and audit
- **Scenario:** User creation/classification succeeds but audit persistence fails, or two callers race.
- **Severity:** High
- **Affected area:** Auth data integrity and forensic traceability.
- **Mitigation:** One canonical command transaction covers row and audit; the tenant/email-hash unique index selects the race winner; the loser reloads and converges; retry is a no-op without duplicate audit.
- **Residual risk:** Database outage fails the whole operation and blocks consumer enablement.

#### Existing non-human convention rows backfill as human
- **Scenario:** A deployment already created convention-based channel bot users before this column exists; the migration cannot safely infer them and marks them human.
- **Severity:** High
- **Affected area:** First deployment of SLA attribution.
- **Mitigation:** Do not infer during Auth migration. Run the exact-ID, Auth-owned idempotent inventory/remediation contract; collision requires review; verify in the same `PrincipalScope`; unresolved/sentinel authors remain non-human and consumer enablement stays blocked.
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
- `packages/shared/AGENTS.md`
- `BACKWARD_COMPATIBILITY.md`

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|---|---|---|---|
| Root `AGENTS.md` | Check existing specs and define BC before core contract edits | Compliant | Phase 1 deferral and Connect app spec are reconciled; this separate spec owns the change. |
| Root `AGENTS.md` | Never create direct cross-module ORM relationships | Compliant | No relation added; consumers use the existing optional Auth facade. |
| Root `AGENTS.md` | Preserve tenant and organization isolation | Compliant | Both read/provisioning use `PrincipalScope` and the existing organization/null predicate; foreign and same-tenant wrong-org IDs are indistinguishable from missing. |
| Root `AGENTS.md` | Validate inputs with Zod | Compliant | Shared strict discriminated schema drives internal provisioning; existing public command schemas still exclude the field. |
| Root `AGENTS.md` | Use decryption-aware user reads | Compliant | Service implementation uses `findWithDecryption`. |
| Root `AGENTS.md` | Ask before applying migrations | Compliant | Spec generates/reviews only and explicitly forbids local apply without approval. |
| `packages/core/AGENTS.md` | Entity changes use v7 decorators and migration/snapshot workflow | Compliant | Exact entity, migration, snapshot, generation, review, and no-op check are specified. |
| `packages/core/AGENTS.md` | Optional consumer owns cross-module glue and degrades gracefully | Compliant | Consumer uses optional service method and fails closed; Auth has no Connect dependency. |
| `packages/core/AGENTS.md` | Sensitive fields use encryption maps | N/A | Three-value operational discriminator is not PII/secret; existing encrypted user fields are untouched. |
| Auth `AGENTS.md` | User reads use `findWithDecryption`; do not alter token/auth semantics without approval | Compliant | Decryption helper used; token/session shapes explicitly unchanged. |
| Shared `AGENTS.md` | Precise narrow shared types, Zod inference, zero domain dependencies | Compliant | Schema/types live at the existing auth boundary; Shared imports no Core code and exports no `any`. Maintainer approval gates publication. |
| Customers reference | Entity/migration changes keep snapshot and run generator/no-op probe | Compliant | Implementation plan and validations include both. No new CRUD slice exists. |
| CLI `AGENTS.md` | Never keep unrelated migration drift; keep snapshot synchronized | Compliant | File manifest and validation require scoped review and clean second diff. |
| `BACKWARD_COMPATIBILITY.md` | Database is additive-only; optional interface additions allowed | Compliant | Defaulted column, new exports, and optional service method are additive. |
| Spec checklist | One independently deployable capability | Compliant | Identity classification only; bot provisioning and SLA consumption are separate. |
| Spec checklist | Commands/undo for mutations | Compliant | Internal singular command owns system-actor guard, transaction, audit, idempotency, and constrained create/classification undo. |
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
| Provisioning/remediation is executable | Pass | Auth-owned DI/command seam, collision behavior, inventory, hard enablement gate, and rerun tests are defined. |
| File manifest covers implementation steps | Pass | Every phase maps to a concrete file or explicit no-change proof. |

### Non-Compliant Items

None.

### Verdict

**Fully compliant: Approved — ready for implementation after named maintainer approval of the core Auth and shared public contract additions.**

## Review — 2026-08-22

- **Reviewer:** Agent, adversarial checklist pass
- **Security:** Passed; public mutation excluded and fail-closed cases are mandatory
- **Performance:** Passed; bounded one-query primary-key access
- **Cache:** Passed; explicit no-cache decision avoids stale identity state
- **Commands:** Passed; internal system-actor-only provisioning command is transactional, audited, idempotent, and undo-constrained
- **Risks:** Passed; deployment inventory and rollback ordering remain explicit operational gates
- **Verdict:** Approved pending maintainer contract sign-off

## Changelog

### 2026-08-22

- Initial implementation-ready specification for the separate upstream `auth.User.principal_kind` contract.
- Recorded default/backfill semantics, optional source-owned resolver, no-public-API decision, fail-closed consumer rule, file manifest, integration coverage, risk register, and compatibility analysis.
- Remediated readiness findings: organization-scoped reads/writes; Auth-owned Zod-validated non-human provisioning/remediation; collision-safe idempotency, audit/undo, executable enablement gate, dedicated migration harness, and Shared compliance.

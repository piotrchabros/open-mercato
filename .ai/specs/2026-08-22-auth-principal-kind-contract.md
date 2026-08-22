# Auth Principal Kind Classification Contract

## TLDR

Add a non-null `principal_kind` discriminator to `auth.User`, default/backfill every existing and ordinary user to `human`, publish the shared closed type, and extend the existing Auth principal facade with a bounded organization-scoped read resolver. This specification contains **no non-human provisioning, remediation, command, ledger, undo, or enablement mutation**; those live exclusively in `2026-08-22-auth-principal-provisioning-contract.md`.

## Overview

Principal kind is upstream Auth identity semantics. Consumers such as Connect SLA need positive evidence that an author is human and must not infer it from email, roles, password state, channel ownership, or UUID conventions. Classification storage/read and trusted mutation have different security and lifecycle concerns, so the owner-selected split keeps this contract schema/read-only after migration.

## Problem Statement

`auth.User` cannot currently distinguish a human from a system bot or integration. Missing users and the communication-channel zero UUID are especially dangerous: treating unknown as human can falsely satisfy compliance clocks. Existing installations and third-party user creation must remain compatible when the field is introduced.

## Proposed Solution

Add the closed stored kind `human | system_bot | integration`, with permanent ORM/database default `human`, and an optional batched method on `AuthPrincipalService`. Only an active row found under the existing Auth tenant+organization predicate returns a record. A miss is unknown and never synthesized as human.

### Invariants

1. Every persisted user has one checked kind; legacy and omitted values become `human`.
2. Reads require exact tenant plus `(organization_id IS NULL OR organization_id = requested organization)` and `deleted_at IS NULL`.
3. Missing, deleted, foreign-tenant, wrong-organization, malformed, null, or unsupported rows are omitted.
4. Public user create/update/read, profile, login, refresh, autologin, JWT/session/API-key claims, setup, and demo behavior remain unchanged and do not accept/expose the field.
5. Classification is never inferred. Consumers test exact `kind === 'human'` and snapshot it at the business event.
6. This contract performs no post-migration mutation. Non-human creation/remediation is available only after the separate provisioning contract is implemented.

### Shared and DI Contract

Add to `packages/shared/src/lib/auth/principal-service.ts`:

```ts
export const AUTH_USER_PRINCIPAL_KINDS = ['human', 'system_bot', 'integration'] as const
export type AuthUserPrincipalKind = (typeof AUTH_USER_PRINCIPAL_KINDS)[number]

export type AuthUserPrincipalKindRecord = {
  id: string
  kind: AuthUserPrincipalKind
}

export type ResolveUserPrincipalKindsInput = {
  ids: string[]
  scope: PrincipalScope
}
```

Add the optional method, preserving existing implementations:

```ts
resolveUserPrincipalKinds?(
  input: ResolveUserPrincipalKindsInput,
): Promise<AuthUserPrincipalKindRecord[]>
```

`DefaultAuthPrincipalService` normalizes/deduplicates UUID strings, returns `[]` without a query for empty input, rejects more than 1,000 normalized IDs with `[internal] auth_principal_kind_limit_exceeded`, and performs one five-argument `findWithDecryption` query selecting only `id` and `principalKind`. Results are ordered by input ID order, contain at most one record per requested ID, and omit unsupported runtime values rather than coercing them.

Consumers resolve the existing `authPrincipalService` key through local soft-optional `tryResolve`, verify the method is a function, and fail closed on absence/error. Auth imports no consumer.

## Data Model

### `User` additive field

| Field | Storage | Required | Default | Rule |
|---|---|---:|---|---|
| `principalKind` / `principal_kind` | text | Yes | `human` | CHECK in `('human','system_bot','integration')` |

```ts
@Property({ name: 'principal_kind', type: 'text', default: 'human' })
principalKind: AuthUserPrincipalKind = 'human'
```

The discriminator is not PII and is not added to Auth encryption maps. No index is added because the only sanctioned access is a bounded primary-key lookup. No ledger entity belongs to this specification.

## API, UI, ACL, Events, Commands, and Cache

- No HTTP/OpenAPI, UI, navigation, i18n, ACL, notification, CLI, event, subscriber, worker, search, or cache surface is added.
- Existing user command Zod schemas remain authoritative and exclude `principalKind`; route passthrough cannot smuggle it. Existing GET/session serializers omit it.
- No command/undo is introduced because migration/default and reads are the only behaviors. Ordinary user creation continues through existing commands and receives the default.

## Migration & Backward Compatibility

### Forward migration

One Auth migration:

1. Add `principal_kind text NOT NULL DEFAULT 'human'` to `users` (the constant default backfills existing rows).
2. Add named CHECK `users_principal_kind_chk` for the three values.
3. Update `auth/migrations/.snapshot-open-mercato.json` from entity metadata.

Generate/review only; never run `yarn db:migrate` without approval. A second `yarn db:generate` must report no Auth diff.

### Rollback

Disable/rollback all kind-sensitive consumers and the separate provisioning capability first. The generated `down()` drops the check and column only. Downstream immutable event snapshots are consumer-owned and remain valid. Operational code rollback without schema down is safe because older Auth ignores the additive column.

### All 13 compatibility surfaces

1. Auto-discovery conventions unchanged; existing `data/entities.ts` export gains one property only.
2. Shared types are additive; optional method does not break implementations.
3. Existing function signatures unchanged.
4. Import paths unchanged.
5. Event IDs unchanged.
6. Widget spot IDs unchanged.
7. API URLs/shapes unchanged.
8. Database change is additive/defaulted/checked.
9. Existing DI key unchanged; optional method additive.
10. ACL IDs unchanged.
11. Notification IDs unchanged.
12. CLI commands unchanged.
13. Generated registry/bootstrap shapes unchanged; entity export identity remains `User`.

No deprecation bridge or upgrade note is required because nothing is removed, renamed, narrowed, or disabled.

## Testing Strategy and Integration Coverage

- Entity/service unit tests: initializer/default, all three values, empty/deduped/ordered IDs, valid organization-null and organization-specific rows, deleted/missing/foreign/wrong-org/malformed values, exactly 1,000 and 1,001 IDs, one bounded query.
- Migration DB harness: pre-column legacy rows become human; raw insert omitting field defaults human; invalid value fails named CHECK; down removes only check/column; second generation is clean.
- API/regression: POST/PUT cannot smuggle kind; GET/profile/session/token shapes omit it; setup primary/admin/employee/demo users remain human; login/invite/password reset/role assignment remain green.
- Consumer contract: absent method/service and query error fail closed; only exact returned human is positive.
- Executable coverage is package-local under `packages/core/src/modules/auth/__integration__/TC-AUTH-063-principal-kind.spec.ts` with integration metadata; `.ai/qa/tests` remains config-only.

## Implementation Plan and File Manifest

1. Add shared constants/types and optional method.
2. Add entity field and bounded resolver implementation.
3. Generate/review migration and snapshot.
4. Add unit, migration-harness, API/setup regression, integration, and decoupling coverage.

| File | Action |
|---|---|
| `packages/shared/src/lib/auth/principal-service.ts` | Modify additive types/optional method |
| `packages/core/src/modules/auth/data/entities.ts` | Modify `User` field only |
| `packages/core/src/modules/auth/services/principalService.ts` | Modify bounded scoped resolver |
| `packages/core/src/modules/auth/migrations/Migration<timestamp>_auth.ts` | Create column/check migration |
| `packages/core/src/modules/auth/migrations/.snapshot-open-mercato.json` | Modify |
| `packages/core/src/modules/auth/services/__tests__/principalService.test.ts` | Modify |
| `packages/core/src/modules/auth/migrations/__tests__/principal-kind.migration.test.ts` | Create |
| `packages/core/src/modules/auth/api/__tests__/users.route.test.ts` | Modify |
| `packages/core/src/modules/auth/__tests__/cli-setup-demo-users.test.ts` | Modify |
| `packages/core/src/modules/auth/__integration__/TC-AUTH-063-principal-kind.spec.ts` | Create |

Validation: `yarn db:generate`, `yarn generate`, targeted Auth/shared tests, `yarn workspace @open-mercato/shared build`, `yarn workspace @open-mercato/core build`, integration case, `yarn typecheck`; select and record one repository runner mode. Do not apply migrations.

## Risks & Impact Review

### Unknown principal credited as human
- **Severity:** Critical
- **Mitigation:** omission-on-miss, exact-kind consumer check, optional-method failure closed, integration matrix.
- **Residual:** consumer misuse is contained by its own required contract test/snapshot.

### Existing user creation fails
- **Severity:** High
- **Mitigation:** permanent ORM and DB defaults plus setup/API/CLI regression.
- **Residual:** invalid raw SQL is correctly rejected by the CHECK.

### Cross-scope classification leak
- **Severity:** High
- **Mitigation:** exact existing Auth tenant+organization/null predicate, active row, selected fields, indistinguishable omission.
- **Residual:** database compromise is outside application isolation.

### Public field smuggling
- **Severity:** High
- **Mitigation:** authoritative command schemas exclude the field and real route tests cover passthrough POST/PUT.
- **Residual:** trusted provisioning is deliberately separate and audited.

### Misordered rollback
- **Severity:** Medium
- **Mitigation:** consumers/provisioning roll back first; optional reads fail closed.
- **Residual:** human attribution pauses but automation is not falsely credited.

## Final Compliance Report — 2026-08-22

Reviewed root/spec/core/auth/customers/CLI/shared/QA guidance, `BACKWARD_COMPATIBILITY.md`, actual User/principal service/migration/API/setup code, and all 13 surfaces.

| Check | Status | Evidence |
|---|---|---|
| Scope cohesion | Pass | Schema/default/shared type/scoped read only; mutations moved to provisioning spec |
| Tenant/organization isolation | Pass | Existing Auth predicate and explicit test matrix |
| BC | Pass | Defaulted additive column and optional interface method |
| Public API/session stability | Pass | Schemas/serializers unchanged and regression-tested |
| Migration workflow | Pass | Generated migration/snapshot/down/no-op probe; no apply |
| Test discovery | Pass | Package-local integration path |
| UI/API/ACL/events/cache | N/A | No new corresponding surface |

Non-compliant items: none.

### Verdict

**Ready to implement.** Classification is independently deployable; provisioning depends on it, never the reverse.

## Review — 2026-08-22

- Security, isolation, compatibility, migration, performance, and scope split: passed.
- Provisioning/remediation content was removed and cross-referenced to the dedicated contract.

## Changelog

### 2026-08-22

- Initial combined classification/provisioning draft.
- Owner selected SPLIT: narrowed this specification to schema/default/check/shared type and bounded scoped read resolver only; moved every trusted mutation, ledger, undo, collision, retry, and enablement gate to `2026-08-22-auth-principal-provisioning-contract.md`.

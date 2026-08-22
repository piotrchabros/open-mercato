# Connect Principal Classification Extension Contract

## TLDR

Add a Connect-owned principal-classification extension keyed by soft scalar `userId`. It stores explicit `human | system_bot | integration` evidence per tenant and organization and exposes a bounded Connect-local reader. Auth and all platform packages remain unchanged. Missing, invalid, deleted, or inaccessible classifications are `unknown`, never implicitly human. Trusted writes, remediation, audit, and undo live only in `2026-08-22-auth-principal-provisioning-contract.md`.

## Overview

Connect SLA needs positive evidence that an author is human, but the owner explicitly rejected an Auth/Core modification. Principal kind is therefore consumer-owned extension data: Connect records only identities whose classification it can establish, references Auth users by UUID without an ORM relationship, and fails closed when evidence is absent.

This specification is independently deployable and read-only after migration. It does not create or update Auth users, publish a shared platform type, extend Auth DI, or alter public Auth behavior.

## Invariants

1. `packages/connect` owns all code, schema, migrations, types, DI, and tests.
2. No file under `packages/core`, `packages/shared`, `packages/ui`, or `apps/mercato` changes.
3. Classification is scoped by exact tenant, organization, and soft `userId`; there is no cross-module ORM relation or foreign key.
4. Absence is `unknown`. Legacy users are not backfilled or inferred as human.
5. Email, roles, password state, channel ownership, UUID conventions, and the communication-channel zero UUID are never evidence.
6. Only exact stored `kind === 'human'` is positive human evidence; Connect snapshots it at the business event.
7. Malformed, null, unsupported, deleted, wrong-tenant, and wrong-organization rows are omitted.
8. This contract has no post-migration mutation; the sibling contract owns provisioning/remediation.

## Connect-Local Contract

Create `packages/connect/src/modules/connect/lib/principal-classification.ts`:

```ts
export const CONNECT_PRINCIPAL_KINDS = ['human', 'system_bot', 'integration'] as const
export type ConnectPrincipalKind = (typeof CONNECT_PRINCIPAL_KINDS)[number]
export type ConnectPrincipalKindRecord = { userId: string; kind: ConnectPrincipalKind }
export type ResolveConnectPrincipalKindsInput = {
  tenantId: string
  organizationId: string
  userIds: string[]
}
export interface ConnectPrincipalKindReader {
  resolve(input: ResolveConnectPrincipalKindsInput): Promise<ConnectPrincipalKindRecord[]>
}
```

The implementation normalizes/deduplicates UUIDs, returns `[]` without querying for empty input, and rejects more than 100 normalized IDs with `[internal] connect_principal_kind_limit_exceeded`. It performs one bounded sidecar query, then structurally soft-resolves the source-owned `authPrincipalService` and checks returned IDs through `principalExists` with concurrency capped at 10:

1. One scoped sidecar query selects only `userId` and `kind`.
2. For at most 100 returned IDs, call the existing `principalExists({ type: 'user', id, scope })` contract under exact tenant/organization scope with at most 10 calls in flight. Organization eligibility matches Auth's public contract: a user with `organization_id IS NULL` is tenant-wide and is eligible in every organization of that tenant; an organization-bound user is eligible only for the requested organization.

The result is the ordered intersection of sidecar rows and successful Auth-facade checks. Results contain at most one row per requested ID and omit unsupported kinds, absent/deleted Auth users, and any facade miss/error. Historical business-event snapshots already written by Connect are immutable facts and are never revised or deleted when the Auth user or sidecar row later disappears.

Register the Connect-owned `connectPrincipalKindReader` DI key for Connect call sites. It is not a Shared/platform contract. Optional downstream Connect packages soft-resolve it with `tryResolve`, verify the method, and fail closed on absence/error.

## Data Model

### `ConnectPrincipalClassification` / `connect_principal_classifications`

| Field | Storage/rule |
|---|---|
| `id` | UUID PK |
| `tenant_id`, `organization_id` | required UUID scope |
| `user_id` | required UUID scalar; soft reference only |
| `kind` | checked `human | system_bot | integration` |
| `created_at`, `updated_at` | required timestamps; `updated_at` is the optimistic-lock version |

Unique `(tenant_id, organization_id, user_id)`; index the same lookup. The table has no Auth FK/ORM relation, copied email/name, encryption map, search document, public CRUD route, or implicit default-human row. It is editable only through the trusted sibling command.

## Auth Boundary

- Auth `User`, commands, migrations, principal service, DI, APIs, serializers, sessions, claims, setup, and demo stay unchanged.
- Classification reads use only the source-owned `authPrincipalService.principalExists` facade for the bounded active-ID intersection. They never query/import Auth persistence.
- Provisioning structurally soft-resolves the exact existing `authPrincipalService.principalExists` method to validate a single requested target; it neither extends nor imports the Auth implementation.
- If no existing facade can validate the user without a peer-table query, provisioning stays disabled until a separately approved upstream contract exists. Connect never queries Auth tables.
- Classification is authoritative only for Connect behavior, not a platform-wide Auth identity claim.

## API, UI, ACL, Events, Commands, and Cache

No HTTP/OpenAPI, UI, navigation, i18n, ACL, notification, CLI, event, subscriber, worker, search, or cache surface is added. The sibling spec owns the internal Connect command. Existing Auth and Connect public shapes remain unchanged.

## Migration & Backward Compatibility

One Connect migration creates the empty classification table, closed-kind CHECK, unique constraint, and index, updating only the Connect snapshot. No Auth scan, cross-module SQL, default, or backfill is permitted. Generate/review it and require a second clean generation; never apply without approval.

Rollback disables kind-sensitive behavior and provisioning before removing the reader. Operational rollback retains the table. Explicit schema down drops only this table after retention approval.

All thirteen compatibility surfaces remain unchanged except additive Connect-local entity discovery, storage, and DI registration. The existing Auth principal facade is consumed without changing its shape. No existing type, signature, import, event/widget/API/ACL/notification/CLI contract is changed.

## Testing Strategy and Integration Coverage

- Reader: all kinds; empty/deduplicated/ordered IDs; 100/101 cap; one bounded sidecar query.
- Isolation: exact tenant+organization; tenant-wide Auth users with null organization are eligible; organization-bound wrong-scope, deleted Auth/sidecar row, malformed value, and zero UUID are omitted.
- Peer validation: source-owned `principalExists` only, maximum 100 IDs and concurrency 10; prove absence/error fails closed and no Auth entity/query-engine access exists.
- Unknown safety: missing row/reader and query error never produce `human`.
- Snapshot lifecycle: deleting/deactivating Auth or sidecar state changes future reads only and never rewrites historical Connect snapshots.
- Boundary: forbid Auth entity imports/table queries/ORM relations and changes outside `packages/connect`.
- Migration: empty additive table, named checks/unique/index, invalid-kind rejection, isolated down, clean regeneration.
- Integration: exact stored human is positive; absent/non-human/error cannot satisfy the Connect SLA clock.

Executable coverage: `packages/connect/src/modules/connect/__integration__/TC-CONNECT-PRINCIPAL-001-classification.spec.ts`.

## Implementation Plan and File Manifest

1. Add Connect-local type/reader and entity.
2. Register the reader.
3. Generate the Connect-only migration/snapshot.
4. Add reader, migration, decoupling, and integration coverage.

| File | Action |
|---|---|
| `packages/connect/src/modules/connect/lib/principal-classification.ts` | Create local type/reader |
| `packages/connect/src/modules/connect/data/entities.ts` | Add entity |
| `packages/connect/src/modules/connect/di.ts` | Register reader |
| `packages/connect/src/modules/connect/migrations/Migration<timestamp>_connect.ts` | Create migration |
| `packages/connect/src/modules/connect/migrations/.snapshot-open-mercato.json` | Modify |
| `packages/connect/src/modules/connect/lib/__tests__/principal-classification.test.ts` | Create |
| `packages/connect/src/modules/connect/migrations/__tests__/principal-classification.migration.test.ts` | Create |
| `packages/connect/src/modules/connect/__integration__/TC-CONNECT-PRINCIPAL-001-classification.spec.ts` | Create |

Validation: `yarn db:generate`, `yarn generate`, targeted Connect tests, Connect build/typecheck, integration, decoupling, and `yarn typecheck`; record one runner mode. Do not apply migrations.

## Risks & Impact Review

| Risk | Severity | Mitigation |
|---|---|---|
| Unknown credited as human | Critical | No default/backfill; exact stored human only; fail closed. |
| Cross-scope leak | High | Exact triple scope and indistinguishable omission. |
| Stale soft reference | High | Provisioning validates active scoped user; no cascade/peer mutation. |
| Core boundary regression | High | Connect-only manifest and decoupling test. |

## Final Compliance Report — 2026-08-22

| Check | Status | Evidence |
|---|---|---|
| Scope cohesion | Pass | Connect classification storage/read only |
| Owner architecture | Pass | No Core/Shared/UI/Auth modification |
| Isolation | Pass | Exact triple-scoped identity |
| Fail closed | Pass | Missing is unknown; no human inference |
| Module boundary | Pass | Soft UUID; no relation/import/table read |
| Migration/BC | Pass | Additive Connect-only empty storage |

### Verdict

**Ready to implement.** Classification is independently deployable; provisioning depends on it and never the reverse.

## Changelog

### 2026-08-22

- Replaced the rejected Auth/Core design with a Connect-owned extension keyed by scoped soft `userId`.
- Preserved the classification/provisioning split and fail-closed semantics.

# Connect Principal Classification Provisioning Contract

## TLDR

Add a server-only Connect command/service that idempotently creates or changes Connect-owned classification rows for existing scoped Auth user IDs, records an append-only Connect ledger, handles retries without heuristics, supports constrained undo, and gates kind-sensitive Connect behavior. It never mutates Auth and changes nothing in Core, Shared, or UI.

## Dependency and Scope

`2026-08-22-auth-principal-kind-contract.md` lands first. This contract consumes only its Connect-local entity/type/reader. Classification remains independently deployable; provisioning fails closed if its storage/reader or the existing sanctioned Auth validation facade is unavailable. All implementation is under `packages/connect`.

## Connect-Local Input and Service

```ts
export const ensureConnectPrincipalClassificationInputSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  operationId: z.string().uuid(),
  userId: z.string().uuid(),
  kind: z.enum(['human', 'system_bot', 'integration']),
  source: z.string().regex(/^[a-z0-9._:-]{1,100}$/),
  reasonCode: z.string().regex(/^[a-z0-9._:-]{1,100}$/),
  referenceId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/).optional(),
  expectedUpdatedAt: z.string().datetime().optional(),
}).strict()
export type EnsureConnectPrincipalClassificationInput =
  z.infer<typeof ensureConnectPrincipalClassificationInputSchema>
export type EnsureConnectPrincipalClassificationResult = {
  classificationId: string
  userId: string
  kind: ConnectPrincipalKind
  created: boolean
  changed: boolean
  replayed: boolean
  updatedAt: string
}
```

The Connect-local `connectPrincipalClassificationProvisioningService` exposes `ensure(input)` and dispatches `connect.principal_classification.ensure`. Callers cannot provide command context.

It resolves `authPrincipalService` via local `tryResolve<unknown>`, then structurally narrows the value to an object whose `principalExists` property is a function before calling exactly:

```ts
principalExists({
  type: 'user',
  id: input.userId,
  scope: { tenantId: input.tenantId, organizationId: input.organizationId },
})
```

No new Shared import or Auth implementation import is required. The existing Auth semantics are authoritative: exact tenant is mandatory; an active user with null `organization_id` is tenant-wide and valid for every organization in that tenant, while an organization-bound user is valid only for the matching organization.

## Authority and Auth Boundary

- Require `ctx.systemActor === true && ctx.auth == null`; HTTP, sessions, API keys, and browser paths cannot invoke it.
- Before a write, soft-resolve the existing sanctioned Auth facade and validate exact `userId` in exact tenant/organization.
- Missing facade/method/error and missing/deleted/foreign/wrong-organization users all return `[internal] connect_principal_target_unavailable` without mutation/disclosure.
- There is no email mode. Operators create users through existing Auth-owned workflows, then supply the exact ID.
- Connect never imports Auth entities, queries Auth tables, invokes an undocumented Auth write, or copies email/name/password/hash data.

## Command, Collision, and Retry

1. Strict-parse input; begin a Connect transaction, set five-second local lock timeout, and acquire the transaction advisory lock for `connect-principal-classification:{tenantId}:{organizationId}:{source}:{operationId}`.
2. Load ledger unique `(tenant_id, organization_id, source, operation_id)`. Matching SHA-256 canonical request fingerprint replays stored result; mismatch returns `[internal] connect_principal_operation_conflict`.
3. Validate exact user through the soft Auth facade before any classification write.
4. Lock the scoped classification row by tenant, organization, and user.
5. Missing creates; equal is a no-op; differing requires `expectedUpdatedAt` equal to `updated_at`, otherwise return the unified record conflict.
6. Classification create/change and completed ledger commit atomically. Successful no-op still records completion for deterministic retry.
7. On classification unique violation, discard the aborted transaction and retry the whole command once fresh, including Auth validation and winner locking.

The operation never mutates Auth. Logs expose only scope, source, operation ID, outcome/code, and duration; no user ID, reference, or payload.

## Data Model

### `ConnectPrincipalClassificationChange` / `connect_principal_classification_changes`

| Field | Storage/rule |
|---|---|
| `id` | UUID PK |
| `tenant_id`, `organization_id` | required scope |
| `operation_id`, `source` | required operation identity |
| `request_fingerprint` | lowercase SHA-256 hex |
| `classification_id`, `user_id` | UUID scalars; soft references |
| `before_kind`, `after_kind` | checked kinds; before nullable on create, after nullable only for tombstone |
| `created_classification`, `changed_classification` | required booleans |
| `tombstoned_classification` | required boolean |
| `result_updated_at` | required optimistic-lock version |
| `outcome` | `completed | undone` |
| `reason_code`, `reference_id` | bounded tokens |
| `inverse_of_id` | nullable scalar ledger ID |
| `created_at` | required timestamp |

Unique operation identity; index `(tenant_id, organization_id, user_id, created_at)`. A named CHECK requires `after_kind IS NULL` iff `tombstoned_classification = true`; a tombstone must have non-null `before_kind`, and an ordinary completed classification must have non-null `after_kind`. The ledger is immutable, has no ORM relations, CRUD, search, deletion, or free-text/PII.

## Audit and Undo

Real changes log only command/resource/operation tokens, before/after kinds, and flags. Full input/user ID are excluded. Replay/no-op skips generic logging; the ledger remains authoritative.

Undo is system-only with a fresh operation ID and a strict contract:

```ts
export const undoConnectPrincipalClassificationInputSchema = z.object({
  tenantId: z.string().uuid(),
  organizationId: z.string().uuid(),
  operationId: z.string().uuid(),
  source: z.string().regex(/^[a-z0-9._:-]{1,100}$/),
  originalChangeId: z.string().uuid(),
  expectedUpdatedAt: z.string().datetime(),
  reasonCode: z.string().regex(/^[a-z0-9._:-]{1,100}$/),
}).strict()

export type UndoConnectPrincipalClassificationResult = {
  classificationId: string
  userId: string
  kind: ConnectPrincipalKind | null
  tombstoned: boolean
  replayed: boolean
  updatedAt: string | null
}
```

- Created row: if version/kind still match and no later transition exists, delete the extension row and append an inverse tombstone ledger with `after_kind = null` atomically.
- Changed row: under the same guards, restore `beforeKind` and append inverse.
- Mismatch returns unified undo conflict. Undo uses the same scoped operation lock/fingerprint/result fields as ensure: an exact retry returns the stored nullable-kind/tombstone result with `replayed:true`; operation-ID reuse with different input conflicts. Auth is never changed.

## Trusted CLI, Durable Manifest, and Lifecycle

The production-reachable ingress is the auto-discovered Connect CLI command:

```bash
mercato connect principals reconcile --tenant <uuid> --organization <uuid> --manifest <path>
```

The command parses a strict JSON manifest of exact `{ externalKey, userId, kind, reasonCode, referenceId? }` entries, requires the normal trusted server/operations environment, rejects duplicate keys/IDs and all email/heuristic selectors, and invokes the same service/command path. It never writes ORM state directly. Dry-run is the default and reports bounded non-PII counts; explicit `--apply` persists the manifest and reconciles it.

`ConnectPrincipalClassificationManifestEntry` / `connect_principal_classification_manifest_entries` durably stores exact desired state: scoped UUID PK, bounded stable `external_key`, exact `user_id`, desired checked `kind`, reason/reference tokens, deterministic `operation_id` derived from scope+external key+desired revision, `active`, `last_reconciled_at`, bounded `last_result_code`, and timestamps. Unique scope+external key and scope+user ID; no PII, Auth FK, or ORM relation. Import/upsert and reconciliation are commands with optimistic locking.

Initial backfill is an operator-supplied exact-ID manifest followed by reconciliation and verification; there is no Auth scan or inference. Future Connect-owned automation must register/update a durable manifest entry only after its Auth workflow returns the exact user ID, then reconcile before enabling that identity. Rotation writes a new exact ID and operation ID under optimistic lock; retirement marks the manifest entry inactive and tombstones its sidecar classification through the undo/remediation command where safe. Auth deletion does not rewrite historical snapshots; reconciliation marks the target unavailable and future classification reads fail closed. CLI invocation or a Connect-owned lifecycle call into the same reconciliation service retries active unresolved entries idempotently; this contract adds no worker. No feature enables until all required active entries verify.

## Enablement Gate

1. Load the bounded active exact-ID inventory from the durable Connect manifest; never scan Auth or guess.
2. Use stable source and deterministic/stored UUID operation IDs.
3. Retry unresolved targets only after operator correction; a second pass produces zero changes/duplicate logs.
4. Require the classification reader to return every expected exact kind.
5. Where current activity matters, require the existing Auth facade to validate every ID.
6. Missing service/reader/facade, error, sentinel/missing row, mismatch, or unresolved item keeps behavior disabled and reports bounded non-PII counts/codes.

## API, UI, ACL, Events, and Cache

No HTTP/OpenAPI, UI, navigation, ACL, notification, event, search, cache, or public Auth/Connect response change. This contract adds the trusted `mercato connect principals reconcile` CLI command and its auto-discovery entry only; it is not an end-user authorization surface.

## Migration & Backward Compatibility

After classification, a Connect migration creates the ledger and durable manifest tables, checks, unique keys, indexes, and snapshot update. Generate/review and require clean regeneration; never apply without approval.

Rollback disables kind-sensitive behavior and reconciliation, removes CLI/command/service registration, and retains manifest/ledger history. Explicit schema down is retention-gated; classification rolls back last. Across all thirteen BC surfaces, entity/command/CLI auto-discovery, Connect database schema, and Connect DI gain additive entries; types/signatures/imports/events/widgets/APIs/ACLs/notifications and existing CLI commands remain unchanged.

## Testing Strategy and Integration Coverage

- Strict schema/system-actor; reject HTTP/session/API-key invocation.
- Scoped Auth validation; absent/error/missing/deleted/foreign/wrong-org is indistinguishable and mutation-free.
- Create all kinds, equal no-op, optimistic-lock change.
- Replay/fingerprint conflict, concurrency, same-user race, fresh retry, atomic failure injection.
- Audit/error/telemetry redaction.
- Undo success/conflicts/inverse/replay; prove Auth never changes.
- Undo tombstone CHECK, nullable result replay, and mismatched replay conflict.
- CLI dry-run/apply validation, authorization/environment gate, exact-ID-only manifest, duplicate rejection, and command-path reuse.
- Durable manifest import/reconcile/restart recovery, exact-ID backfill, future registration/rotation/retirement, unavailable Auth user, and successful no-change second pass.
- Enablement negative matrix and successful two-pass remediation.
- Decoupling/diff scope: no Core/Shared/UI edit, Auth import/query, or ORM relation.

Executable coverage: `packages/connect/src/modules/connect/__integration__/TC-CONNECT-PRINCIPAL-002-provisioning.spec.ts`.

## Implementation Plan and File Manifest

| File | Action |
|---|---|
| `packages/connect/src/modules/connect/lib/principal-classification-provisioning.ts` | Create schema/service/gate |
| `packages/connect/src/modules/connect/data/entities.ts` | Add ledger and durable manifest entities |
| `packages/connect/src/modules/connect/commands/principal-classifications.ts` | Create command/undo |
| `packages/connect/src/modules/connect/cli.ts` | Add trusted reconcile command |
| `packages/connect/src/modules/connect/lib/principal-classification-manifest.ts` | Add durable manifest/reconciliation |
| `packages/connect/src/modules/connect/di.ts` | Register service |
| `packages/connect/src/modules/connect/migrations/Migration<timestamp>_connect.ts` | Create ledger migration |
| `packages/connect/src/modules/connect/migrations/.snapshot-open-mercato.json` | Modify |
| `packages/connect/src/modules/connect/commands/__tests__/principal-classifications.test.ts` | Create |
| `packages/connect/src/modules/connect/lib/__tests__/principal-classification-provisioning.test.ts` | Create |
| `packages/connect/src/modules/connect/__tests__/cli-principal-classifications.test.ts` | Create |
| `packages/connect/src/modules/connect/migrations/__tests__/principal-classification-provisioning.migration.test.ts` | Create |
| `packages/connect/src/modules/connect/__integration__/TC-CONNECT-PRINCIPAL-002-provisioning.spec.ts` | Create |
| `packages/connect/src/modules/connect/__integration__/TC-CONNECT-PRINCIPAL-003-reconciliation.spec.ts` | Create CLI/manifest/lifecycle coverage |

Validation: generate, targeted Connect tests/build/typecheck, integration, decoupling, and repository typecheck; record one runner and do not apply migrations.

## Risks & Impact Review

| Risk | Severity | Mitigation |
|---|---|---|
| Wrong user classified | Critical | Exact ID, scoped validation, system actor, ledger/undo. |
| State without ledger | Critical | One transaction and failure injection. |
| Stale overwrite | High | Required version for changes/undo. |
| Retry duplicates state | High | Scoped lock/fingerprint/unique key/fresh retry. |
| Cross-scope disclosure | High | Exact scope, indistinguishable error, redaction. |
| Core boundary erosion | High | Connect-only manifest and decoupling test. |

## Final Compliance Report — 2026-08-22

| Check | Status | Evidence |
|---|---|---|
| Scope cohesion | Pass | Connect provisioning/remediation/ledger/gate only |
| Owner architecture | Pass | No Auth/Core/Shared/UI implementation |
| Dependency | Pass | Classification first; rollback last |
| Isolation | Pass | Exact scope and soft Auth validation |
| Audit/undo | Pass | Atomic/redacted/optimistic inverse |
| Idempotency | Pass | Fingerprint/result and fresh retry |
| HTTP/UI stability | Pass | No public application surface changes |
| Production ingress/lifecycle | Pass | Trusted CLI, durable exact-ID manifest, reconciliation and future-user rules |

### Verdict

**Ready to implement after the Connect classification extension.**

## Changelog

### 2026-08-22

- Reworked rejected Auth provisioning into Connect-owned exact-user classification remediation.
- Removed Auth user mutation, Shared contracts, and all Core/UI implementation.

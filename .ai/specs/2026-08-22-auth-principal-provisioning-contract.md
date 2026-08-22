# Auth Non-Human Principal Provisioning Contract

## TLDR

Add one server-only Auth provisioning/remediation service and internal command that idempotently creates or explicitly reclassifies `system_bot` and `integration` users, records an append-only Auth ledger, handles email/operation races without converting humans heuristically, supports constrained undo, and provides an executable consumer enablement gate. It depends on the separate principal-kind classification contract and adds no public HTTP/UI/ACL surface.

## Overview

Defaulting every legacy user to `human` is backward compatible but cannot identify known automation. Consumers need a trusted, source-owned way to create or remediate exact non-human principals before enabling kind-sensitive behavior. This contract owns those mutations without broadening `auth.users.edit` or letting consumers import/update `User` directly.

### Dependency and delivery order

`.ai/specs/2026-08-22-auth-principal-kind-contract.md` must be implemented first in the same release. This spec consumes its shared kinds, `User.principalKind`, CHECK/default, and scoped read method. Classification remains independently deployable; provisioning fails closed if the column/method is absent. Migration order is principal-kind column first, provisioning ledger second. Rollback order is consumers, provisioning, then classification.

## Problem Statement

Auth migration cannot safely infer legacy bots from email, password, role, name, or UUID. Consumer-side direct writes would bypass Auth encryption, tenant/email uniqueness, command/audit behavior, and organization isolation. Concurrent retries also need one deterministic result and ledger record.

## Proposed Solution

Publish a narrow shared Zod contract and register `authPrincipalProvisioningService` in Auth. It dispatches the internal command `auth.user.ensure_non_human` with `systemActor: true`, `auth: null`, explicit tenant+organization scope, and a required idempotency operation ID. HTTP request paths and authenticated session/API-key contexts can never set this trusted invocation.

### Shared contract

```ts
export type NonHumanAuthUserPrincipalKind = Exclude<AuthUserPrincipalKind, 'human'>

export const ensureNonHumanPrincipalInputSchema = z.object({
  scope: z.object({
    tenantId: z.string().uuid(),
    organizationId: z.string().uuid(),
  }).strict(),
  operationId: z.string().uuid(),
  kind: z.enum(['system_bot', 'integration']),
  identity: z.discriminatedUnion('type', [
    z.object({ type: z.literal('user_id'), userId: z.string().uuid() }).strict(),
    z.object({
      type: z.literal('email'),
      email: z.string().trim().email().max(320),
      name: z.string().trim().min(1).max(120).nullable().optional(),
    }).strict(),
  ]),
  source: z.string().regex(/^[a-z0-9._:-]{1,100}$/),
  reasonCode: z.string().regex(/^[a-z0-9._:-]{1,100}$/),
  referenceId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/).optional(),
}).strict()

export type EnsureNonHumanPrincipalInput = z.infer<typeof ensureNonHumanPrincipalInputSchema>

export type EnsureNonHumanPrincipalResult = {
  userId: string
  kind: NonHumanAuthUserPrincipalKind
  created: boolean
  changed: boolean
  replayed: boolean
}

export interface AuthPrincipalProvisioningService {
  ensureNonHumanPrincipal(input: EnsureNonHumanPrincipalInput): Promise<EnsureNonHumanPrincipalResult>
}
```

Shared imports no Core/domain code. Tokens are bounded operational identifiers, never free text/PII. The service is a new stable DI key; it has no API mapping.

### Command, collision, and retry algorithm

`auth.user.ensure_non_human` uses the canonical command bus/transaction seam and rejects unless `ctx.systemActor === true && ctx.auth == null`. The DI service constructs that context internally; callers cannot pass a context/system flag.

1. Strict-parse input. Begin an Auth transaction, execute `set local lock_timeout = '5s'`, then acquire `pg_advisory_xact_lock(hashtextextended(?, 0))` for the exact key `auth-principal-provision:${tenantId}:${organizationId}:${source}:${operationId}`. Timeout throws retryable `[internal] auth_principal_operation_lock_timeout`. This serializes the operation without inserting an incomplete append-only ledger row.
2. Load the ledger by unique identity `(tenant_id, organization_id, source, operation_id)`. If a completed/inverse row exists, compare its stored request fingerprint (SHA-256 of canonical non-secret request fields). A match returns its stored result with `replayed:true` and `skipLog:true`; mismatch returns typed `[internal] auth_principal_operation_conflict`. Thus an operation ID can never mean two requests. The database unique key remains defense in depth against lock-key misuse.
3. Resolve exact `user_id`, or normalized email using the existing Auth email normalization/hash helper and tenant-scoped email-hash unique identity. Every existing-row read uses five-argument `findOneWithDecryption`, exact tenant, `(organization_id IS NULL OR requested organization)`, and `deleted_at IS NULL`, then locks the row for update.
4. Missing/deleted/foreign/wrong-org exact ID returns the same `[internal] auth_principal_target_unavailable`; it never creates.
5. Email miss creates a disabled, unconfirmed, passwordless user in the requested tenant+organization with the requested non-human kind, using existing Auth encryption/email-hash creation helpers. It receives no role, ACL, session, API key, invitation, or welcome email.
6. A tenant/email-hash unique violation aborts that transaction. Retry the **entire command once in a fresh transaction**, first reclaiming/replaying the same operation ID and loading the winner; never query inside an aborted transaction.
7. Email hit converges only when the existing row already has the requested non-human kind. If it is human or the other non-human kind, return the same target-unavailable error; email identity never reclassifies.
8. Exact-ID hit may change human or the other non-human kind to the requested kind. If already equal it is a successful no-op.
9. User mutation and the first complete ledger row are inserted/committed atomically. Failure rolls back both; no provisional ledger survives. A successful no-op still inserts a completed operation ledger so retries are deterministic, but generic command logging is skipped because no user state changed.

Errors never disclose whether an email/foreign ID exists. Logs include tenant, organization, source, operation ID, outcome/code, and duration, but no user ID, email, name, reference value, credentials, or request payload.

## Data Model

### `PrincipalKindChange` / `principal_kind_changes`

Append-only Auth-owned operation/transition ledger:

| Field | Storage/rule |
|---|---|
| `id` | UUID PK |
| `tenant_id`, `organization_id` | required scope |
| `operation_id` | required UUID |
| `source` | bounded token |
| `request_fingerprint` | fixed lowercase SHA-256 hex |
| `user_id` | UUID scalar, nullable until successful target resolution |
| `before_kind` | nullable checked kind; null for creation |
| `after_kind` | required non-human checked kind on success |
| `created_user` / `changed_user` | required booleans on success |
| `outcome` | `completed | undone`; operation errors do not persist a misleading completion |
| `reason_code`, `reference_id` | bounded tokens |
| `inverse_of_id` | nullable scalar ledger ID for undo; no ORM relation |
| `created_at` | required timestamp |

Unique `(tenant_id, organization_id, source, operation_id)`. Index `(tenant_id, organization_id, user_id, created_at)`. Checks close kinds/outcomes and require completed result fields. It has no `updated_at`, `deleted_at`, CRUD route, search, encryption, or public read because it is immutable and contains no PII/free text. Undo appends a separate inverse row with a new operation ID; it never updates/deletes history.

### Audit and command log

For a real create/change, `buildLog` records command ID, scoped resource ID, operation ID/source/reason/reference, before/after kind, and created/changed booleans only. Email/name/hash/password and full input are excluded. `extractUndoPayload` reads a strict Zod-validated redacted snapshot. A replay/no-op sets `skipLog:true`; the Auth ledger remains the atomic idempotency/source-of-truth record.

## Undo Contract

- **Created row:** allowed only when the user still has the command-produced `updated_at`, remains the same non-human kind, passwordless, unconfirmed, non-deleted, and has no Auth-owned roles, ACLs, active sessions, API keys, or later principal-kind ledger transition. Undo soft-deletes it and appends an `undone` inverse ledger row atomically. Scalar consumer references remain intact and future resolver reads fail closed.
- **Classification change:** allowed only when user version/kind still match the command result and no later kind ledger transition exists. Undo restores snapshotted `beforeKind` (including human) and appends the inverse ledger atomically.
- Conflicts return the unified command undo conflict and change nothing. Undo itself requires `systemActor:true`, `auth:null`, a fresh operation ID, and is idempotently replayable by its own ledger identity.

## Enablement Inventory and Gate

Before a kind-sensitive consumer enables:

1. It builds a bounded list of exact known bot/integration IDs/emails from its own durable configuration; Auth never scans or guesses.
2. It calls `ensureNonHumanPrincipal` once per item with stable source and deterministic UUID operation ID derived/stored by the consumer. Email collision requires operator resolution and an exact-ID operation.
3. It reruns unresolved items; exact operation retries return the stored result. A second full pass produces zero user changes and no duplicate action log/ledger.
4. It calls `resolveUserPrincipalKinds` in the same scope and requires every exact ID to return the expected non-human kind.
5. Gate passes only with provisioning service present, classification read method present, zero unresolved items, and matching verification. Missing service/method, error, sentinel/missing row, or mismatch keeps the consumer disabled and reports bounded counts/codes without PII.

This is a consumer-owned orchestration gate, not an Auth API/CLI/global scan. Each consumer ships its gate integration test in the same change.

## API, UI, ACL, Events, and Cache

No HTTP/OpenAPI, UI, navigation, public error, ACL, notification, CLI, event, subscriber, worker, search, or cache surface. Existing `auth.users.edit` does not authorize this command. No public user/session/token response changes.

## Migration & Backward Compatibility

Forward migration creates only `principal_kind_changes`, checks, unique/indexes after the classification migration. Snapshot updated; generate/review/no-op probe; do not apply without approval. Generated down drops only ledger indexes/checks/table. Operational rollback first disables consumers, then removes provisioning command/DI while retaining table/history; classification remains. Schema down of provisioning may follow only after audit retention approval.

All 13 surfaces: auto-discovery unchanged except additive entity export; shared types/interface additive; signatures/imports unchanged; no events/widgets/APIs/ACLs/notifications/CLI; additive DB table; additive DI key; generated entity registry addition only. No deprecation/upgrade note is required.

## Testing Strategy and Integration Coverage

- Strict schema/token/identity/systemActor tests; authenticated/superadmin/API-key/HTTP invocation rejected.
- Exact-ID create prohibition on miss; scoped active/null-org/wrong-org/foreign/deleted cases.
- Email create uses Auth encryption/hash, disabled/unconfirmed/passwordless/no roles/messages; email human/other-kind collision never converts.
- Operation replay, fingerprint conflict, same-operation concurrency, different-operation same-email unique race, aborted-transaction fresh retry, exactly one created user and one completed ledger.
- Exact-ID human→bot, bot→integration, already-equal no-op; atomic failure injection between user/ledger.
- Command log redaction and skip rules; no PII in ledger/log/error/telemetry.
- Undo create/change success, version/security/dependency/later-transition conflicts, inverse ledger and idempotent undo retry.
- Enablement gate absent service/method/error/unresolved/mismatch/zero sentinel and successful two-pass remediation.
- Package-local `packages/core/src/modules/auth/__integration__/TC-AUTH-064-principal-provisioning.spec.ts` plus metadata; no executable test under `.ai/qa/tests`.

## Implementation Plan and File Manifest

1. Add shared strict schema/types/interface.
2. Add ledger entity/migration/snapshot.
3. Implement command, service, DI, collision/retry/idempotency/audit/undo.
4. Add enablement-contract helpers/tests without consumer imports in Auth.
5. Run generation, migration no-op probe, targeted/full regression and integration gates.

| File | Action |
|---|---|
| `packages/shared/src/lib/auth/principal-service.ts` | Modify provisioning schema/types/interface |
| `packages/core/src/modules/auth/data/entities.ts` | Add ledger entity export |
| `packages/core/src/modules/auth/commands/principals.ts` | Create internal command/undo |
| `packages/core/src/modules/auth/services/principalProvisioningService.ts` | Create narrow DI implementation |
| `packages/core/src/modules/auth/di.ts` | Register additive service key |
| `packages/core/src/modules/auth/migrations/Migration<timestamp>_auth.ts` | Create ledger migration after classification migration |
| `packages/core/src/modules/auth/migrations/.snapshot-open-mercato.json` | Modify |
| `packages/core/src/modules/auth/commands/__tests__/principals.test.ts` | Create |
| `packages/core/src/modules/auth/services/__tests__/principalProvisioningService.test.ts` | Create |
| `packages/core/src/modules/auth/migrations/__tests__/principal-provisioning.migration.test.ts` | Create |
| `packages/core/src/modules/auth/__integration__/TC-AUTH-064-principal-provisioning.spec.ts` | Create |

Validation: `yarn db:generate`, `yarn generate`, targeted shared/Auth tests, core/shared builds, TC-AUTH-064, `yarn typecheck`; record one runner mode and never apply migrations.

## Risks & Impact Review

### Email collision converts human
- **Severity:** Critical
- **Mitigation:** email path never reclassifies; exact-ID/system-only remediation; indistinguishable error; ledger.
- **Residual:** trusted operator can choose wrong exact ID; immutable consumer snapshots and audit expose it.

### User commits without ledger
- **Severity:** Critical
- **Mitigation:** one Auth transaction; failure injection; ledger is idempotency winner.
- **Residual:** DB outage blocks enablement rather than partially succeeding.

### Retry duplicates user/audit
- **Severity:** High
- **Mitigation:** scoped operation unique key/fingerprint/result plus tenant-email unique winner and whole-command fresh retry.
- **Residual:** exhausted second collision returns retryable failure and gate stays closed.

### Undo breaks live automation
- **Severity:** High
- **Mitigation:** version/security/Auth-dependency/later-transition checks, soft delete, system-only inverse operation, consumer disable-before-undo operational rule.
- **Residual:** unknown scalar consumer references remain but resolve fail closed.

### Cross-scope mutation/disclosure
- **Severity:** High
- **Mitigation:** exact tenant+organization/null predicate, trusted explicit scope, no browser route, indistinguishable failures.
- **Residual:** tenant-wide null-org principals are intentionally visible within their tenant and require trusted provisioning.

### Default-human legacy automation remains
- **Severity:** High
- **Mitigation:** exact consumer inventory/remediation and hard verification gate; never heuristic migration.
- **Residual:** undocumented automation remains human until its owner inventories it; kind-sensitive consumer must not enable with known unresolved principals.

## Final Compliance Report — 2026-08-22

Reviewed root/spec/core/auth/customers/CLI/shared/QA rules, actual command `systemActor` contract, Auth encryption/email uniqueness, principal facade, migrations, and all 13 BC surfaces.

| Check | Status | Evidence |
|---|---|---|
| Scope cohesion | Pass | Trusted non-human provisioning/remediation/ledger/gate only |
| Dependency | Pass | Classification first; explicit forward/rollback order |
| Tenant isolation | Pass | Existing Auth scoped predicate and indistinguishable failures |
| Command/audit/undo | Pass | System actor only, atomic ledger, redacted log, constrained inverse |
| Collision/idempotency | Pass | Operation fingerprint/result plus email unique fresh retry |
| Public auth stability | Pass | No API/UI/ACL/token/session changes |
| Migration/BC | Pass | Additive table/key/types; all 13 surfaces audited |
| Test discovery | Pass | Package-local TC-AUTH-064 |

Non-compliant items: none.

### Verdict

**Ready to implement after the classification contract.** No mutation remains in the classification spec and no classification schema/read responsibility is duplicated here.

## Review — 2026-08-22

- Security, tenant isolation, command authority, collisions, atomicity, audit redaction, undo, enablement, compatibility, and split cohesion: passed.

## Changelog

### 2026-08-22

- Created after owner selected SPLIT; moved all trusted non-human provisioning/remediation, command, ledger, collision/retry, audit/undo, enablement gate, tests, and rollback ordering out of the principal-kind classification specification.

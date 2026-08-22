# Pre-Implementation Analysis: Auth Non-Human Principal Provisioning Contract

## Executive Summary

**Ready to implement after the principal-kind classification contract.** Actual Auth command context supports the specified `systemActor` gate, Auth already owns encrypted email/hash and tenant uniqueness behavior, and the new contract fully specifies trusted creation/remediation, operation idempotency, fresh-transaction collision retry, atomic ledger, redacted command log, constrained undo, and the consumer enablement gate. It duplicates no classification responsibility.

## Evidence Reviewed

Full revised provisioning/classification specs; `BACKWARD_COMPATIBILITY.md`; root/spec/core/auth/customers/CLI/shared/QA guidance; actual `CommandRuntimeContext.systemActor`, Auth user commands, encryption/email-hash/uniqueness behavior, principal service/DI, entity/migration conventions, and integration discovery.

## Backward Compatibility

### Violations Found

None.

| # | Surface | Result |
|---:|---|---|
| 1 | Auto-discovery | Existing convention files retained; additive ledger entity export only. |
| 2 | Types/interfaces | Strict schema/result/interface are additive. |
| 3 | Function signatures | Existing signatures unchanged. |
| 4 | Import paths | Unchanged. |
| 5 | Event IDs | No event added/changed. |
| 6 | Widget spots | Unchanged. |
| 7 | API URLs/shapes | No HTTP mapping or response change. |
| 8 | Database | New append-only ledger table/checks/indexes only. |
| 9 | DI keys | New `authPrincipalProvisioningService` key only. |
| 10 | ACL IDs | None added/changed; system actor is not an ACL substitute reachable from HTTP. |
| 11 | Notification IDs | Unchanged. |
| 12 | CLI commands | Unchanged. |
| 13 | Generated contracts | Additive ledger entity registry entry; no export/bootstrap shape change. |

### Missing BC Section

None. Prerequisite/migration order, schema versus operational rollback, audit retention, all 13 surfaces, and stability of the new DI/type contracts are explicit.

## Spec Completeness

No required section is missing. API/UI are explicitly N/A. The implementation plan maps every schema, service, command, ledger, DI, migration, unit, harness, and integration responsibility to a concrete file.

## AGENTS.md Compliance

No violation found.

- Input is strict Zod with `z.infer`; Shared imports no Core code.
- Auth owns every User/email/hash/encryption mutation and performs scoped decryption reads.
- Command rejects all but `systemActor:true` with `auth:null`; actual `CommandRuntimeContext` contains this trusted flag and HTTP must not set it.
- User+ledger and undo+inverse ledger are atomic; `extractUndoPayload` is mandatory.
- No cross-module ORM/import, public API, ACL, token/session, UI, cache, search, event, worker, or notification surface.
- Migration is additive, generated/reviewed, snapshot-synchronized, and never applied without approval.
- Executable test is package-local rather than under `.ai/qa/tests`.

## Risk Assessment

### High

| Risk | Mitigation |
|---|---|
| Email collision converts human | Email path never reclassifies; exact-ID and system-only remediation; indistinguishable failure. |
| User without ledger | One Auth transaction and failure-injection test. |
| Retry duplicates state/audit | Exact transaction advisory operation lock, scoped unique/fingerprint/result, tenant-email unique winner, and fresh whole-command retry. |
| Undo breaks automation | Version/security/Auth-dependency/later-transition gates, soft delete/inverse ledger, consumer disable-first rule. |
| Cross-scope mutation | Trusted explicit scope and existing Auth tenant+organization/null predicate. |
| Legacy automation remains human | Exact consumer inventory/remediation and hard verification gate; no heuristic migration. |

### Medium

| Risk | Mitigation |
|---|---|
| Same operation ID reused differently | Exact scoped advisory lock then fingerprint conflict with no mutation; no provisional ledger row. |
| Two different operations race on email | DB unique winner; loser retries fresh and converges/fails safely. |
| Ledger grows | Narrow append-only indexed rows, no PII/free text; retention is Auth audit policy. |

### Low

Generated registry/snapshot additions require expected test updates; generation and exact diff review cover them.

## Gap Analysis

### Critical Gaps

None.

### Important Gaps

None.

### Nice-to-Have

A future operator UI/CLI for inventory may be specified separately; the current consumer-owned orchestration is executable and intentionally non-public.

## Split and Contract Verification

| Requirement | Verified Contract |
|---|---|
| Trusted provisioning/remediation | Server-only DI invokes system-actor command; email create/exact-ID remediation rules pinned. |
| Command | Exact ID, validation, context authority, transaction, result, log rules pinned. |
| Ledger | Scoped operation identity/fingerprint/result, transition data, inverse linkage, indexes/checks. |
| Collision/retry | Scoped 5-second transaction advisory lock; no provisional ledger; aborted transaction discarded; complete command retries once fresh; deterministic replay. |
| Audit/undo | Redacted log, strict undo payload, create/change constraints, atomic inverse ledger. |
| Enablement gate | Consumer inventory, deterministic operations, verification read, zero unresolved/matching kinds. |
| Classification separation | Depends on field/type/read; does not redefine migration/default/resolver. |

## Remediation Plan

### Before Implementation

Implement/deploy the classification contract first; no further spec remediation is required.

### During Implementation

Follow the manifest and collision/atomicity/privacy/undo test matrix; inspect additive generated diffs and never apply migrations without approval.

### Post-Implementation

Each kind-sensitive consumer ships its own inventory/verification gate and immutable event-kind snapshot coverage.

## Recommendation

**Ready to implement after classification.** All 13 BC categories and actual command/Auth assumptions are verified; no critical or important gap remains.

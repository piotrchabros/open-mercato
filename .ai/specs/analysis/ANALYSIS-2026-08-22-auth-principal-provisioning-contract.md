# Pre-Implementation Analysis: Connect Principal Classification Provisioning

## Executive Summary

**Ready after classification.** The contract provides exact-user remediation, idempotency, atomic Connect ledger, optimistic locking, redacted audit, constrained undo, and hard enablement while leaving Auth and platform packages unchanged.

## Boundary and Compatibility

Only `packages/connect/**` may change. Additions are Connect-local command/entity/DI/database contracts plus an additive trusted Connect CLI command. No platform type, import, API, Auth schema/session/token behavior, event/widget, ACL, notification, or existing CLI contract changes.

## Architecture and Security

- System-actor-only internal command; no public entry point.
- Exact UUID only; no email creation or Auth mutation.
- Existing `authPrincipalService` is `tryResolve<unknown>`-resolved and structurally narrowed to the exact existing `principalExists` function. It is called once per requested mutation with `type:'user'` and exact scope; Auth's tenant-wide organization-null semantics are documented.
- Classification+ledger and undo+inverse are atomic.
- Existing changes use `updated_at` optimistic locking.
- Logs/ledger/errors contain no PII.
- No Auth import/table query/migration/ORM relation.

## Completeness and Collision Review

Strict Zod ensure/undo inputs and results, operation fingerprint/replay, advisory serialization, fresh-transaction race retry, scoped validation, create/equal/change outcomes, atomic ledger, and two-pass enablement are pinned. Tombstone inverse rows require nullable `after_kind` under a named iff CHECK and replay the nullable result deterministically.

The production path is no longer test-only: an auto-discovered trusted Connect CLI defaults to dry-run, requires `--apply` to mutate, imports a strict exact-ID manifest, and invokes the same service. Durable manifest rows support restart-safe backfill/reconciliation and explicit future registration, rotation, retirement, and unavailable-user handling without scans or inference; CLI or Connect lifecycle calls reuse the service without adding a worker.

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Wrong user classified | Critical | Exact ID, scoped validation, ledger/undo. |
| Classification without ledger | Critical | Single transaction. |
| Stale overwrite | High | Required version/conflict. |
| Retry duplicate | High | Lock/fingerprint/unique/fresh retry. |
| Cross-scope disclosure | High | Exact scope and redaction. |
| Inventory drift/future users | High | Durable exact-ID manifest, reconciliation, hard enablement gate. |

## Split Verification

Provisioning creates/changes only Connect extension rows and depends on, but does not redefine, classification storage/read. Its CLI, manifest, ledger, undo, and lifecycle remain one cohesive trusted-mutation capability. The two specs remain independently reviewable.

## Intentional Change from Rejected Design

The command never creates, reclassifies, disables, or deletes Auth users. Operators use Auth-owned workflows first, then classify the exact UUID in Connect. Claiming equivalent Auth provisioning from an extension would violate module ownership.

## Recommendation

**Ready to implement after classification.** No critical or important gap remains.

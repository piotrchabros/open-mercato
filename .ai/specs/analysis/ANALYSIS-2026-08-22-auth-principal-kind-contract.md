# Pre-Implementation Analysis: Connect Principal Classification Extension

## Executive Summary

**Ready to implement.** Connect owns a scoped classification table keyed by soft `userId`, local type/reader/DI, migration, and tests. Nothing changes in Auth, Core, Shared, UI, or the app. Missing evidence is unknown rather than default-human.

## Boundary and Compatibility

The controlling boundary is `packages/connect/**`. Existing imports, types, signatures, Auth schema, event IDs, widget spots, APIs, DI keys, ACLs, notifications, CLI, and bootstrap contracts remain unchanged. Additions are Connect-local entity discovery, storage, and DI. No deprecation bridge is required.

## Architecture and Security

- Soft UUID only; no Auth ORM relation/FK/entity import/table query.
- Exact tenant+organization+user scope and uniqueness.
- Reader uses one bounded sidecar query and the existing source-owned `authPrincipalService.principalExists` facade for at most 100 IDs with concurrency 10; it never imports or generically queries Auth persistence.
- Auth organization-null users retain the public tenant-wide semantics; organization-bound users require exact organization.
- No inferred/default human; absence/error is unknown.
- Existing sanctioned Auth facade may validate exact scope during provisioning but is unchanged.
- Decoupling coverage enforces the external-extension decision.

## Completeness

The spec pins entity shape, closed values, one sidecar query plus capped/concurrency-bounded source-facade checks, ordered results, DI ownership, Auth boundary, empty migration, rollback, implementation files, integration discovery, risks, and validation. `updated_at` supports the sibling trusted edit command's optimistic locking. Historical event snapshots are explicitly immutable after Auth deletion or sidecar disappearance.

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Unknown credited as human | Critical | No default/backfill; exact human only. |
| Cross-scope leak | High | Exact triple scope. |
| Stale soft reference | High | Scoped Auth validation during writes. |
| Core regression | High | Connect-only manifest/decoupling test. |

## Split Verification

This spec owns only classification storage/read. It contains no provisioning, ledger, retry, audit, undo, or enablement mutation. Provisioning depends on it, never the reverse.

## Intentional Change from Rejected Design

There is no Auth-wide default/backfill or platform-wide kind. Existing Auth users without explicit Connect rows are unknown. This is the safety-preserving consequence of the owner-selected external extension.

## Recommendation

**Ready to implement.** No critical or important gap remains.

# Pre-Implementation Analysis: Auth Principal Kind Contract

## Executive Summary

The remediated specification is ready for implementation after named maintainer approval of the additive Core Auth, Shared public type, DI, and database contracts. Re-audit against actual source confirms the previous blockers are resolved: reads and writes now use the existing tenant+organization Auth scope predicate; Auth owns a system-actor-only, Zod-validated, idempotent provisioning/remediation command and DI service; enablement has an executable exact-ID inventory/remediation gate; and migration `up`/`down` coverage has a dedicated database harness.

No breaking change exists across any protected backward-compatibility category. The remaining risks are implementation-verification obligations, not specification gaps.

## Analysis Method and Evidence

- Read the remediated target spec in full and checked it against actual Auth/Shared/Connect source.
- Read `BACKWARD_COMPATIBILITY.md`, root/spec/Core/Auth/Customers/CLI/Shared `AGENTS.md`, `.ai/review-checklist.md`, and matching lessons for stale snapshots, MikroORM string defaults, and shared-security consumer audits.
- Verified current `User`, `AuthPrincipalService`, DI registration, API/command schemas, setup/CLI creation, Documents consumers, and communication-channel system-user fallback.
- The skill's canonical `.agents/.../review-checklist.md` is not installed in this worktree; the repository extension explicitly points to `.ai/review-checklist.md`, which was used.
- Explore-subagent spawn was attempted during the initial audit and rejected by the collaboration thread limit. The re-audit used exhaustive direct source searches.

### Source facts reconciled

| Fact | Verified source | Remediated contract |
|---|---|---|
| Existing Auth user reads use tenant plus `organizationId: null OR selected organization` | `packages/core/src/modules/auth/services/principalService.ts` | `resolveUserPrincipalKinds` now accepts `PrincipalScope` and uses the same predicate. |
| No current trusted non-human creation/classification path exists | `auth/commands/users.ts`, `auth/lib/setup-app.ts`, `auth/cli.ts` | New internal `auth.user.ensure_non_human` command and `authPrincipalProvisioningService`. |
| Route body is passthrough but command Zod owns mutation validation | `auth/api/users/route.ts`, `auth/commands/users.ts` | Existing POST/PUT remain unable to smuggle `principalKind`; regression test required. |
| Channel system-user resolver can return a nonexistent zero UUID | `communication_channels/lib/system-user.ts` | Missing/sentinel remains unknown; consumer never credits it as human. |
| Connect requires a real `system_bot` row for the bot path | `.ai/specs/2026-08-21-app-spec-mercato-connect.md` | Email branch can create a disabled row; exact-ID branch remediates known existing rows. |
| Shared public principal facade already has an optional capability precedent | `packages/shared/src/lib/auth/principal-service.ts` | Read addition stays optional; provisioning uses a new additive narrow interface/DI key. |

## Backward Compatibility

### Violations Found

None.

### Full Contract-Surface Audit

| # | Surface | Change | Result | Implementation guard |
|---:|---|---|---|---|
| 1 | Auto-discovery file conventions | Existing entity/DI files modified; normal command and migration files added. | Compatible | Preserve `User` export and `di.ts register(container)` convention. |
| 2 | Type definitions & interfaces | New constants/types/schema/interface; optional read method. | Additive | No existing required field is removed/narrowed; test old service object compatibility. |
| 3 | Function signatures | Existing methods unchanged; new methods/services added. | Additive | Do not turn the optional read capability into a required existing-method parameter. |
| 4 | Import paths | Existing Shared principal-service path retained with new exports. | Additive | Preserve current export-map entry. |
| 5 | Event IDs | No published event ID renamed/removed; internal command audit uses existing infrastructure. | N/A | Do not invent a cross-module event during implementation. |
| 6 | Widget injection spot IDs | No UI/widgets. | N/A | None. |
| 7 | API route URLs | No route/method/response change; field remains private. | Behavior-preserving | Route-through-command smuggling and unchanged response tests. |
| 8 | Database schema | Defaulted non-null text column/CHECK plus append-only Auth ledger table and indexes. | Additive under BC §8 | Permanent DB default, generated migration/snapshot, reversible dependency-ordered down after consumer rollback. |
| 9 | DI service names | Existing `authPrincipalService` retained; new `authPrincipalProvisioningService`. | Additive | New stable key only; no alias/removal required. |
| 10 | ACL feature IDs | No public ACL because command is system-actor-only. | N/A | Future public mutation requires a new immutable feature. |
| 11 | Notification type IDs | No notification change. | N/A | None. |
| 12 | CLI commands | No existing command/flag changes. | Behavior-preserving | An operator wrapper, if later added, must be additive. |
| 13 | Generated file contracts | Entity registry gains one entry; export names and `BootstrapData` shape remain. | Additive | Review narrow generated delta and discard unrelated drift. |
| — | Current BC AI agent/tool/override category | No AI surface change. | N/A | None. |

### Missing BC Section

Not missing. The spec defines forward migration, rollback order, additive classifications, exact legacy-row remediation, API/token stability, DI/type compatibility, and consumer enablement.

## Spec Completeness

### Missing Sections

None. All mandatory spec-writing sections are present; UI/i18n/API endpoint work is correctly N/A.

### Incomplete Sections

None blocking or important after remediation.

| Section | Re-audit result |
|---|---|
| Architecture | Read and write seams, optional consumption, system-actor boundary, module ownership, transaction, and failure behavior are concrete. |
| Data model | Closed values, ORM/DB default, CHECK, encryption decision, and index rationale are explicit. |
| Mutation/undo | Singular internal command, atomic Auth ledger, action-log snapshots, convergence, race handling, and create/classification inverse-ledger undo constraints are defined. |
| Enablement | Exact-ID inventory, safe email creation, collision review, rerun report, verification read, and hard failure gate are executable. |
| Tests | Dedicated migration DB harness is separated from runtime integration; scope, races, compatibility, and API smuggling are covered. |
| Shared contract | Strict Zod schema, `z.infer`, precise types, no Core dependency, and approval gate are stated. |

## AGENTS.md Compliance

### Violations

None in the remediated specification.

### Compliance findings

| Rule | Status | Evidence in spec |
|---|---|---|
| Tenant and organization scoping on user queries | Compliant | `PrincipalScope`; exact tenant plus organization/null predicate on both services; wrong-org tests. |
| No cross-module ORM/business-logic import | Compliant | Auth owns entity writes; optional consumers use DI and own glue. |
| Inputs validated with Zod and types inferred | Compliant | Strict shared discriminated schema; rejects unknown/blank/both-neither/human inputs. |
| User reads use decryption helpers | Compliant | Read uses `findWithDecryption`; provisioning uses `findOneWithDecryption`. |
| Sensitive field encryption | Compliant | New kind is not PII; email creation explicitly reuses Auth encryption/hash mechanisms. |
| Commands/atomicity/audit/undo | Compliant | Internal singular command; one transaction for user+Auth ledger; generic action-log snapshots; idempotent no-op retry; constrained undo with inverse ledger. |
| Public auth/token error safety | Compliant | No public route/token field; foreign/missing failures indistinguishable and internal. |
| Shared zero domain dependencies / narrow interfaces | Compliant | Shared owns structural schema/types only and imports no Core module. |
| Migration/snapshot workflow | Compliant | Generate/review/no-op probe; no local migrate; unrelated drift discarded. |
| Optimistic locking | N/A | No user-editable public form/action; internal classification is command-controlled and audited. |
| API/OpenAPI/UI/i18n/DS | N/A | No route or UI surface is introduced. |
| Events/cache/search/workers | N/A | No such mechanism required; point lookups deliberately uncached. |

## Risk Assessment

### High Risks

| Risk | Impact | Specified mitigation |
|---|---|---|
| Human converted by email collision | Authentication/compliance corruption | Email branch never reclassifies; exact-ID + operator review required; system actor only; audit records transition. |
| Same-tenant cross-org access | Organization leak/misattribution | Existing Auth scope predicate on read/write and wrong-org negative tests. |
| Partial row/provenance write or concurrent ensure | Untraceable or duplicate principal | One command transaction for user+Auth ledger; generic action log is secondary; existing targets lock for update; tenant/email-hash unique winner aborts the losing transaction, which retries once fresh and converges; no duplicate ledger/log on no-op retry. |
| Legacy bot row defaults human | False SLA credit | Non-heuristic exact-ID remediation and verification are a hard pre-enable gate. |
| Older Auth implementation lacks capability | Consumer crash or unsafe fallback | Optional read method/runtime checks; missing provisioning blocks enablement; reads fail closed. |

### Medium Risks

| Risk | Impact | Specified mitigation |
|---|---|---|
| Migration lock on large users table | Brief write disruption | Constant default, representative-size validation, normal migration monitoring, no ORM backfill. |
| Shared-service consumer drift | Existing Documents behavior regresses | Enumerate production consumers/mocks and test old objects; never change existing resolver required-method checks. |
| Unknown/error classifications silently depress metrics | Under-counted human response | Consumer telemetry and hard enablement checks; no false-human fallback. |
| Undo after downstream reference | Dangling references/history loss | Created-row undo rejects when referenced; kind snapshots keep history stable. |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Runtime import cycle from kind constant | Build failure | Use type-only entity import where possible; Shared has no Core dependency; package build catches cycles. |
| Integration test ID collision | Naming conflict | Recheck next available `TC-AUTH-*` ID immediately before implementation. |
| No kind index | Future kind-wide reports scan | Current bounded PK access needs no index; reassess with a new query pattern. |

## Gap Analysis

### Critical Gaps (Block Implementation)

None.

### Important Gaps (Should Address)

None. The former organization-scope, provisioning/remediation, enablement, migration-harness, Shared-compliance, validation, and consumer-audit gaps are resolved in the spec.

### Nice-to-Have Gaps

- Record the measured DDL lock duration on a representative production-sized `users` table in PR evidence.
- Select the final migration timestamp and integration test ID at implementation time.
- If an operator-facing CLI wrapper is later desired, specify it separately as an additive surface rather than expanding this contract.

## Remediation Plan

### Before Implementation (Must Do)

1. Obtain named maintainer approval for the Core Auth contract, new Shared public schema/types, new DI key, and additive database column.
2. Confirm the implementation branch still has no conflicting `principal_kind` migration or `TC-AUTH-063` test ID.

### During Implementation (Add to Spec)

1. Keep implementation byte-accurate with the spec: scope predicate, row lock, fresh-transaction unique-race retry, collision rules, system-actor guard, ledger/action-log redaction, atomicity, and undo constraints.
2. Audit all `AuthPrincipalService` consumers/mocks and prove older objects remain valid.
3. Use the dedicated migration DB harness for pre-column `up`/`down`; keep Playwright/runtime scope cases separate.
4. Run the selected Docker/local gate, generator/migration no-op checks, Shared/Core tests/build/typecheck, and never apply migrations without approval.

### Post-Implementation (Follow Up)

1. Deploy Auth before consumers; run dry-run/remediation twice; enable only after zero unresolved and same-scope verification.
2. Monitor bounded consumer unknown/error classification metrics without PII.
3. Require a separate spec for any public reclassification API/UI or new principal-kind value.

## Recommendation

**Ready to implement after named maintainer approval.** The design is cohesive, additive, organization-scoped, executable for both new and legacy non-human principals, and complete across migration, command, audit, undo, compatibility, and integration testing.

## Re-Audit Changelog

- 2026-08-22: Initial audit blocked implementation on organization scoping, missing Auth-owned non-human provisioning/remediation, and non-executable enablement.
- 2026-08-22: Re-audited remediated spec. All blockers and important gaps resolved; verdict advanced to ready after maintainer approval.

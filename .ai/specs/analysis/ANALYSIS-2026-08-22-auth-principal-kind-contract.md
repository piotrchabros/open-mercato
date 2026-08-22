# Pre-Implementation Analysis: Auth Principal Kind Contract

## Executive Summary

The specification is structurally strong and its proposed database, type, import, DI, API, and generated-file changes are additive across all protected backward-compatibility surfaces. It is **not ready to implement** because two source-verified design gaps remain: the proposed resolver intentionally omits `organization_id` despite the repository's hard scope rule and the existing Auth principal-service precedent, and no supported Auth-owned write/provisioning seam can classify existing or future non-human rows even though Connect requires a real `system_bot` row and the spec gates enablement on remediation.

Recommendation: revise the specification before coding. Resolve the scope contract, add or explicitly bind a trusted Auth-owned classification/provisioning operation, and place the migration assertions in a test harness that can actually exercise pre-migration state and rollback.

## Analysis Method and Evidence

- Read the target specification in full.
- Read `BACKWARD_COMPATIBILITY.md`, including every protected category. The current repository document has 14 numbered headings because AI surfaces are a separate category; the pre-implementation skill's requested 13-category table combines/omits that AI-only category. This report checks all 13 categories named by the skill and also records AI surfaces as N/A.
- Read root, spec, Core, Auth, Customers-reference, CLI, and Shared `AGENTS.md` guidance.
- Scanned `.ai/lessons.md` by `auth`, `shared`, tenant-scope, migration, and contract tags; opened the relevant stale-snapshot, MikroORM string-default, and shared-security-consumer-audit lessons.
- The shared code-review checklist path named by the skill (`.agents/skills/om-code-review/references/review-checklist.md`) is not installed in this worktree. The repository extension points to `.ai/review-checklist.md`; that full checklist was used instead.
- The skill requires Explore subagents. Spawning was attempted and rejected because the collaboration thread limit was reached. The audit therefore used direct source inspection and exhaustive `rg` searches.

### Actual source verified

| Area | Evidence |
|---|---|
| User entity | `packages/core/src/modules/auth/data/entities.ts:14-52` has no discriminator; `organizationId` is nullable and user email is encrypted. |
| Auth principal interface | `packages/shared/src/lib/auth/principal-service.ts:24-50` is a public interface; `queryActiveRolePage?` establishes the additive optional-method precedent. |
| Principal implementation | `packages/core/src/modules/auth/services/principalService.ts:46-170` uses `findWithDecryption`; user existence and label reads filter exact tenant plus `organizationId: null OR selected organization`. |
| DI | `packages/core/src/modules/auth/di.ts:41-49` registers the stable `authPrincipalService` key. |
| Existing optional consumer | `packages/documents/src/modules/documents/lib/platformServices.ts:28-39` uses `tryResolve` and runtime method checks. |
| Admin API | `packages/core/src/modules/auth/api/users/route.ts:60-105,470-499` uses passthrough route input, does not expose kind, and delegates writes to commands. |
| Authoritative writes | `packages/core/src/modules/auth/commands/users.ts:112-145,215-256` owns create/update Zod validation; kind is absent. |
| Provisioning | `packages/core/src/modules/auth/lib/setup-app.ts:260-449` creates/reuses only primary/admin/employee users; `packages/core/src/modules/auth/cli.ts:30-84` creates ordinary users. Neither offers trusted kind input. |
| Channel system author | `packages/core/src/modules/communication_channels/lib/system-user.ts` finds a convention row, accepts a fallback ID, or returns zero UUID; it never creates or classifies a row. |
| Consumer requirement | `.ai/specs/2026-08-21-app-spec-mercato-connect.md:342` requires the bot's real Auth row to carry `system_bot`; `.ai/specs/2026-08-22-connect-sla.md:103` relies on Auth backfill and same-tenant principal resolution. |
| Migration style | Auth migrations have reversible `up`/`down`; snapshot table starts at `packages/core/src/modules/auth/migrations/.snapshot-open-mercato.json:490`. |

## Backward Compatibility

### Violations Found

No breaking backward-compatibility violation is specified. The following table audits every category required by the skill against actual source.

| # | Surface | Proposed change / source check | Classification | Severity | Required handling |
|---:|---|---|---|---|---|
| 1 | Auto-discovery file conventions | Modifies existing `data/entities.ts`; adds a normal module migration. No convention filename/export changes. | Compatible | None | Keep existing `User` export and `di.ts` `register(container)` signature. |
| 2 | Type definitions & interfaces | Adds three exported types/constants and an **optional** method to public `AuthPrincipalService`. Existing required members remain. | Additive | None | Keep method optional for at least as long as old implementations are supported; add compile/runtime tests for partial implementations. |
| 3 | Function signatures | No existing function parameter, order, or return shape changes. New optional interface method is a new capability. | Additive | None | Do not retrofit a required parameter onto an existing method. |
| 4 | Import paths | Existing `@open-mercato/shared/lib/auth/principal-service` export-map path remains; new names are added there. | Additive | None | Preserve the path and existing exports. |
| 5 | Event IDs | No event added, renamed, removed, or payload changed. | N/A | None | None. |
| 6 | Widget injection spot IDs | No UI/widget change. | N/A | None | None. |
| 7 | API route URLs | Existing route URLs/methods/responses remain unchanged; kind is deliberately absent. | Behavior-preserving | None | Route-through-command smuggling regression is required. |
| 8 | Database schema | Adds `users.principal_kind text NOT NULL DEFAULT 'human'` and a CHECK. No rename/removal/narrowing. | Additive under BC §8 | None | Keep the permanent default and update Auth snapshot; migration down may drop only after consumers are rolled back. |
| 9 | DI service names | Retains `authPrincipalService`; implementation gains an optional method. | Additive | None | Do not introduce a renamed replacement key. |
| 10 | ACL feature IDs | No ACL change. | N/A | None | A future mutable classification API will require a new immutable feature ID. |
| 11 | Notification type IDs | No notification change. | N/A | None | None. |
| 12 | CLI commands | No command/flag rename or removal. Existing `auth add-user` remains behaviorally human. | Behavior-preserving | None | If CLI is chosen for remediation, add an optional new command/flag; never repurpose an existing required flag. |
| 13 | Generated file contracts | No generated export/`BootstrapData` change; entity registry class set is unchanged. | N/A | None | Run `yarn generate` as verification and do not commit unrelated output. |
| — | AI agent/tool/override IDs (current BC §12) | No AI surface change. | N/A | None | None. |

### Warnings

| Surface | Issue | Severity | Proposed fix |
|---|---|---|---|
| Type/interface behavior | `AuthPrincipalService` is shared and already consumed by Documents. Although optional is source-compatible, all production consumers and mocks must be enumerated so a runtime capability test never accidentally treats the whole service as absent. | Warning | Add a consumer audit to the implementation plan covering the source hits listed above; preserve existing resolver guards and test an old implementation object. |
| Database behavior | Backfilling every row to `human` is compatible for ordinary users but semantically unsafe for pre-existing convention bot/integration rows. This is not a BC break; it is an enablement/data-quality risk. | Warning | Ship an explicit inventory/remediation operation and gate SLA enablement on its successful result. |

### Missing BC Section

Not missing. `## Migration & Backward Compatibility` covers forward migration, rollback, and additive classifications. It must be revised to include the concrete pre-existing non-human remediation path and organization-scope decision.

## Spec Completeness

### Missing Sections

None. TLDR, Overview, Problem Statement, Proposed Solution, Architecture, Data Models, API Contracts, UI/UX, risks, phasing, implementation plan, test coverage, compliance report, and changelog are present. API/UI are correctly marked N/A for the proposed read-only contract.

### Incomplete Sections

| Section | Gap | Recommendation |
|---|---|---|
| Architecture / tenant isolation | The proposed method takes only `tenantId` and explicitly ignores organization, while root and review rules require both and current Auth user reads use `PrincipalScope` with `organizationId: null OR selected organization`. | Change input to `scope: PrincipalScope` and filter exact tenant plus the approved organization rule, or obtain explicit maintainer approval for a system-scope exception and define who may call it. Add same-tenant/different-org negative coverage. |
| Commands/events/undo | It says trusted provisioners may directly construct `User`, but no Auth-owned service/command exists, and optional consumers must not import Auth entities/business logic. Existing Auth setup and CLI create humans only. | Add an Auth-owned trusted operation. Preferred minimal contract: an internal DI method/command that creates a non-human principal or classifies an identified row, requires trusted scope, validates kind, is audited, tenant/org scoped, and defines idempotency/undo. If existing-row remediation is operator-only, specify the exact CLI/upgrade action and audit trail. |
| Enablement | Risk mitigation says inventory and explicitly classify known bots before consumer enablement, but gives no algorithm, owner, executable path, idempotency, or failure signal. | Define an idempotent preflight/upgrade action, its input source, dry-run/report output, ambiguous-row handling, and the exact gate consumed by Connect SLA rollout. Never infer from email without operator confirmation. |
| Integration Test Coverage | `TC-AUTH-063` is asked to prove legacy-row backfill and down behavior, but ordinary Playwright integration starts after migrations and cannot naturally create the pre-column schema. No existing Auth migration-test harness was found. | Name a migration-specific database test/harness that creates the pre-migration schema, runs this migration's `up`, verifies default/CHECK, and runs `down`; keep runtime scope/facade cases in `TC-AUTH-063`. |
| Shared package compliance | The Final Compliance Report omits `packages/shared/AGENTS.md` even though a public shared type is added. | Add Shared to reviewed guides; record that the new interface is narrow, has no Core import, contains no `any`, and is an approved cross-package contract. |
| Input validation | The service accepts raw `{ ids, tenantId }`, manually normalizes, and throws an unspecified internal error beyond 1,000. Shared rules prefer precise Zod-derived inputs. | Define a module-local Zod schema or an exact internal validation helper/error contract. Do not add a user-facing untranslated error. |
| File manifest | Explicit-kind creation is a required use case but no production creation/provisioning file is listed. | Add the chosen Auth service/command/CLI/upgrade action and its tests to the manifest. |
| Final Compliance Report | Verdict says fully compliant despite the organization-scope conflict and missing supported remediation seam. | Change verdict to blocked until both design decisions are repaired, then rerun compliance review. |

## AGENTS.md Compliance

### Violations

| Rule | Location | Severity | Fix |
|---|---|---|---|
| Root/review checklist: all tenant-scoped entity queries filter by `organization_id` **and** `tenant_id` | Architecture → source-owned read contract; Invariant 5 | High | Accept trusted `PrincipalScope`, use the existing Auth user predicate, and test same-tenant cross-org omission. If a system-scope exception is truly required, it needs an explicit approved contract and caller restrictions, not an unqualified tenant-only method. |
| Core optional coupling: consumer owns glue; do not directly import peer business logic/entity | Commands/events/undo says trusted provisioners may construct `User` but never defines an Auth seam | High | Keep `User` construction inside Auth; expose a narrow DI/command/upgrade action for explicit classification/provisioning. |
| Shared Ask First: ask before adding a shared public cross-package type | Implementation Phase 1 | High gate | Named maintainer approval is acknowledged generally, but the spec should explicitly record approval of these shared exports and optional method before implementation. |
| Shared: precise types, Zod-derived validation, no vague internal errors | Architecture → 1,000-ID bound/errors | Medium | Define the exact validation schema/error or a typed internal contract; use the `[internal]` error convention if it cannot surface to users. |
| Pre-implementation skill: use code-review checklist at installed shared path | Analysis workflow | Tooling limitation | `.agents/.../review-checklist.md` does not exist; `.ai/review-checklist.md`, referenced by the local extension, was used. Install shared skills before the implementation review if the canonical checklist is required. |

### Compliant / N/A highlights

- Correct package placement: shared contract under Shared; implementation/schema under Core Auth.
- Uses `findWithDecryption`; no raw ORM user read is proposed.
- No PII or credential field is added; encryption-map change is correctly N/A.
- No public API, UI, i18n, OpenAPI, CRUD, cache, event, queue, worker, notification, ACL, or search surface is introduced.
- The MikroORM text default uses plain `'human'`, matching the relevant lesson; no pre-quoted default is proposed.
- Migration/snapshot workflow and unrelated-drift cleanup match Core/CLI guidance.
- No local `db:migrate` is authorized.

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Same-tenant cross-organization classification | A consumer can probe or credit an author outside the event's organization, violating hard scoping rules and potentially misattributing compliance facts. | Use `PrincipalScope`; apply both tenant and approved organization predicates; test same-tenant/different-org and organization-null system rows explicitly. |
| No supported non-human provisioning/remediation | The migration marks known bot rows human and no current API, command, setup hook, or CLI can correct them; SLA can ship with false human credit or remain permanently gated. | Add an Auth-owned, audited and idempotent operation plus rollout preflight. Make consumer enablement fail until all known non-human principals are classified. |
| Shared security contract consumer drift | Documents and test mocks implement/shape `AuthPrincipalService`; a careless resolver guard change could disable existing document authorization/labels. | Keep new method optional; enumerate every production consumer and mock; add old-object compatibility tests; do not require the new method in existing Documents resolver. |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Migration test placed in wrong harness | Backfill/CHECK/down claims remain untested despite a green runtime integration suite. | Add a database migration test with pre-migration schema; separate it from Playwright API tests. |
| DDL on a large users table | Deployment may briefly lock writes; operational behavior depends on PostgreSQL version/table size. | Confirm supported PostgreSQL metadata-default behavior, test on representative row count, and document lock-time rollback threshold. |
| Unspecified validation error | A >1,000 call may leak a hard-coded error or behave differently across implementations. | Define typed validation and `[internal]` error semantics; test exactly 1,000 and 1,001. |
| Consumer failure swallowing | Treating every service error as unknown is safe from false credit but can silently depress SLA performance. | Consumer records bounded unknown-classification telemetry/metrics without PII and alerts above a threshold. Auth normal misses remain log-free. |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Shared constant imported into entity metadata | An unnecessary runtime dependency or circular import could appear if only the type is needed. | Use `import type` for `AuthUserPrincipalKind`; keep runtime constants in validation/service code only and run package cycle/build checks. |
| No discriminator index | Future reporting by kind could scan users. | Current point-ID access needs no index; require a new access-pattern review before adding kind-wide reporting. |
| Integration test ID collision | `TC-AUTH-063` could collide with concurrent Auth work. | Re-run `rg` immediately before implementation and select the next free ID if needed. |

## Gap Analysis

### Critical Gaps (Block Implementation)

- **Organization scope contract:** replace or formally approve the tenant-only exception; current design contradicts project rules and current Auth precedent.
- **Non-human write/remediation seam:** specify how a real bot/integration row is created or an existing row is classified without a cross-module entity import or unsupported direct SQL.
- **Enablement gate:** define the executable, idempotent inventory/remediation check required before Connect SLA can rely on the default-human migration.

### Important Gaps (Should Address)

- Define a migration-specific test harness and exact file path for pre-column `up`/`down` coverage.
- Add `packages/shared/AGENTS.md` to compliance and explicitly approve the new shared public contract.
- Define precise runtime validation/error behavior for service inputs.
- Enumerate all existing `AuthPrincipalService` production consumers and mocks in the test plan.
- Add operational telemetry expectations for repeated unknown/error classifications on the consumer side.

### Nice-to-Have Gaps

- State the supported PostgreSQL baseline and expected lock behavior for constant-default DDL.
- Decide whether the shared constant is runtime-needed by the entity or should be a type-only dependency.
- Reserve the next available Auth integration case ID only at implementation time.

## Remediation Plan

### Before Implementation (Must Do)

1. **Revise resolver scope:** use `PrincipalScope` and organization filtering, or document and obtain named approval for a tightly bounded system-scope exception.
2. **Design the Auth-owned write seam:** add the exact internal service/command/CLI/upgrade-action contract for explicit `system_bot`/`integration` creation or classification, including validation, trusted authorization, tenant/org scope, audit, idempotency, and rollback/undo.
3. **Define rollout remediation:** specify inventory source, ambiguous-row behavior, dry-run/reporting, repeatability, and the hard Connect enablement condition.
4. **Repair compliance verdict:** include Shared guidance and mark the spec ready only after items 1-3 are resolved and approved.
5. **Name the migration test harness:** separate schema-up/down verification from post-migration API integration.

### During Implementation (Add to Spec)

1. Audit every `AuthPrincipalService` consumer and test double; prove the optional addition does not change existing Documents behavior.
2. Run `yarn db:generate`, discard unrelated drift per the lesson, review SQL/snapshot, and rerun as a no-op probe.
3. Test exact tenant+organization predicates, zero sentinel, active/deleted rows, 1,000/1,001 IDs, old service objects, explicit provisioning, rerun idempotency, and API smuggling.
4. Record selected Docker/local runner and do not apply migrations locally without approval.

### Post-Implementation (Follow Up)

1. Deploy Auth schema and remediation action before Connect SLA; run dry-run then classification; enable SLA only after a clean report.
2. Monitor consumer unknown/error classification counts and investigate sustained non-zero rates.
3. Keep historical consumer snapshots immutable; any future reclassification UI/API requires its own spec, ACL, audit, optimistic-lock, and undo design.

## Recommendation

**Needs spec updates first.** The additive BC strategy is sound and no deprecation bridge is needed, but implementation must not begin until organization scoping and supported non-human classification/remediation are concretely specified and approved. These are correctness and tenant-boundary blockers, not implementation details.

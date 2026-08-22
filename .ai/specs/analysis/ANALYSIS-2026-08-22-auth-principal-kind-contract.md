# Pre-Implementation Analysis: Auth Principal Kind Classification Contract

## Executive Summary

**Ready to implement.** The owner-selected split is clean: this contract now contains only the additive User field/default/CHECK, shared closed type, and optional bounded scoped read resolver. Actual Auth code supports the stated existing principal-service predicate and command/API regression plan; all mutation, ledger, undo, collision, retry, and enablement work is absent and belongs to the provisioning spec.

## Evidence Reviewed

Full revised spec; provisioning sibling; `BACKWARD_COMPATIBILITY.md`; root/spec/core/auth/customers/CLI/shared/QA guidance; actual User entity, Auth principal service/DI, user route/command schemas, setup/demo creation, migrations/snapshot, and integration discovery.

## Backward Compatibility

### Violations Found

None.

| # | Surface | Result |
|---:|---|---|
| 1 | Auto-discovery | Existing entity file/class identity retained; one mapped property only. |
| 2 | Types/interfaces | Constants/types and optional service method are additive. |
| 3 | Function signatures | Existing signatures unchanged. |
| 4 | Import paths | Unchanged. |
| 5 | Event IDs | Unchanged. |
| 6 | Widget spots | Unchanged. |
| 7 | API URLs/shapes | Unchanged and tested against passthrough smuggling. |
| 8 | Database | Defaulted additive column/CHECK only. |
| 9 | DI keys | Existing key unchanged; optional method additive. |
| 10 | ACL IDs | Unchanged. |
| 11 | Notification IDs | Unchanged. |
| 12 | CLI commands | Unchanged. |
| 13 | Generated contracts | No class/export rename or bootstrap shape change. |

### Missing BC Section

None. Forward/down migration, operational rollback order, all 13 surfaces, and deprecation conclusion are explicit.

## Spec Completeness

No required section is missing or materially incomplete. API/UI/ACL/events/commands/cache are explicitly N/A. File manifest, package-local tests, migration harness, risks, compliance, review, and changelog are present.

## AGENTS.md Compliance

No violation found. The spec uses Shared for narrow cross-package types without domain imports, five-argument scoped decryption reads, existing Auth organization/null semantics, additive migration/snapshot/generation workflow, no public auth/session change, no direct consumer dependency, and package-local integration coverage.

## Risk Assessment

### High

| Risk | Mitigation |
|---|---|
| Unknown credited as human | Miss omission, exact-kind check, absent/error fail closed. |
| Existing creates break | ORM+DB default and API/setup/CLI regression. |
| Cross-scope leak | Existing dual-scope/null predicate, deleted filter, selected fields. |
| Public smuggling | Authoritative command schemas exclude field; real route tests. |

### Medium

| Risk | Mitigation |
|---|---|
| Lookup abuse | Dedupe, 1,000 cap, one PK query, no cache. |
| Misordered rollback | Consumers/provisioning first; optional reads fail closed. |

### Low

Migration lock duration is limited to one constant-default additive column/check; review generated SQL in the normal gate.

## Gap Analysis

### Critical Gaps

None.

### Important Gaps

None.

### Nice-to-Have

None required before implementation.

## Split Verification

- No `authPrincipalProvisioningService`, ensure command, ledger entity, email creation, reclassification, retry, undo, or enablement inventory remains.
- Provisioning spec depends on this contract; this contract does not depend on provisioning.
- Classification migration down drops only its own check/column after dependent rollback.

## Remediation Plan

### Before Implementation

None.

### During Implementation

Implement and validate the manifest/migration/test gates exactly as specified; inspect additive generated diffs and do not apply migrations.

### Post-Implementation

Provisioning may land next; kind-sensitive consumers still require their own snapshot/fail-closed coverage.

## Recommendation

**Ready to implement.** All 13 BC categories and actual-code assumptions are verified; no critical or important gap remains.

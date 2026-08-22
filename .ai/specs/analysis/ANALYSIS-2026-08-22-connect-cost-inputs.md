# Pre-Implementation Analysis: Mercato Connect — Cost Accounting Inputs

## Executive Summary

**Ready to implement.** The revised specification resolves every previous blocker and important gap against actual repository conventions. It now has deterministic analytics-foundation ordering, an extension-owned adapter over the source-owned base-currency service with fail-closed behavior, lossless bigint wire/storage rules, privacy-safe undo/audit design, exact provider-line replay semantics, complete owning-file/test manifests, and bounded API/reader contracts.

## Evidence Reviewed

- Full revised cost-input specification plus base analytics and cost-per-contact specifications.
- `BACKWARD_COMPATIBILITY.md` and all 13 categories.
- Root/spec/core/customers/currencies/shared/UI/backend UI/CLI/QA guidance and repository review checklist.
- Actual Connect module/entities/metrics/ACL/setup/DI/routes/commands/migrations and generated conventions.
- Actual currencies DI contract: confirms `baseCurrencyService.resolveBaseCurrency({ tenantId, organizationIds })` is source-owned and already consumed soft-optionally by other modules; the extension can validate one scoped base currency without changing or importing currencies storage.
- QA discovery rules: executable module-local `__integration__` path is now correct and `.ai/qa/tests` remains config-only.

## Backward Compatibility

### Violations Found

None. All proposed changes are additive.

| # | Surface | Verified Result |
|---:|---|---|
| 1 | Auto-discovery file conventions | Base AN-MOD-01 ownership/order is explicit; new/modified index, ACL, setup, DI, entity, validation, encryption, events, search, API, page, and integration files retain conventions. |
| 2 | Type definitions & interfaces | New extension-local currency/cost readers and schemas are additive; required fields and decimal-string semantics are pinned. |
| 3 | Function signatures | No existing signature changes; both reader methods are new stable additions. |
| 4 | Import paths | No moves/removals; cross-module reads remain DI/API based. |
| 5 | Event IDs | Three new correctly formed past-tense CRUD event IDs; existing IDs unchanged. |
| 6 | Widget injection spot IDs | No change. |
| 7 | API route URLs | CRUD and sanitized currency-options routes are additive with exact schemas/guards. |
| 8 | Database schema | Two new analytics tables/checks/indexes only; normal generated down and operational retention are distinguished. |
| 9 | DI service names | `connectCostInputReader` is additive and stable; the base-currency adapter is extension-internal and consumes an existing key unchanged. |
| 10 | ACL feature IDs | Two additive IDs with dependency/default-role/wildcard behavior pinned. |
| 11 | Notification type IDs | No change. |
| 12 | CLI commands | No change. |
| 13 | Generated file contracts | Expected module/entity/API/page/ACL/DI/event/search additions are pinned and asserted by COST-INT-009. |

### Missing BC Section

None. The section covers prerequisite order, additive surfaces, migration/snapshot generation, schema rollback, operational disable/data preservation, and stability of newly published IDs.

## Spec Completeness

### Missing Sections

None. Required feature-spec sections are present; cost-per-contact remains intentionally separate.

### Incomplete Sections

None blocking or important. Implementation chooses code organization inside the named files without changing the published contracts.

## AGENTS.md Compliance

### Violations

None.

- Both tenant and organization scope are mandatory on entity, readers, routes, selectors, uniqueness, undo revision lookup, and tests.
- Currency validation is owned by the Connect extension adapter and uses the source-owned `baseCurrencyService`; no peer ORM import, generic peer-entity query, platform modification, or hard module requirement exists.
- All route/internal inputs are exact Zod schemas with `z.infer`; money is never a JS number or JSON bigint.
- Description fields are in encryption maps and decrypted only through five-argument scoped helpers. Command/audit/event payloads are redacted; undo reads a scoped encrypted revision secret.
- CRUD uses commands, `runCrudCommandWrite`, `extractUndoPayload`, canonical side effects, optimistic locking, CrudForm/DataTable/apiCall, ACL/setup, search exclusion, i18n, and DS primitives.
- Integration tests are module-local, self-contained, discoverable, and include UI/API/key-boundary/privacy coverage.

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Sensitive description escapes encrypted entity | Privacy breach through command/audit/search/event/log surfaces. | Encrypted cost and revision fields, redacted payloads, scoped undo lookup, exhaustive COST-INT-005/006. |
| Bigint precision/serialization | Incorrect stored money or runtime JSON failure. | Canonical regex, signed-bigint maximum, BigInt only after parse, `.toString()` on every DTO, boundary tests. |
| Currency dependency absent/invalid | Financial row lacks defined currency meaning. | Extension-owned dual-scoped active query adapter; write 422 and selector 503 fail closed; no format-only acceptance. |
| Cross-scope disclosure | Financial/actor data leaks across organization/tenant. | Server-derived scope on every seam, scoped uniqueness/lookups, guessed-ID tests. |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Provider invoice replay ambiguity | Duplicate cost or blocked multi-line invoice. | Canonical invoice+line keys, exact replay comparison, original result on match, 409 on changed payload. |
| Parallel base analytics delivery | Shared module files conflict or grants drift. | AN-MOD-01 strict prerequisite/unchanged fallback scaffold, then additive modifications and generated coexistence test. |
| Undo collides with newer provider row | Restore violates uniqueness or overwrites newer state. | Optimistic version and uniqueness checks; unified conflict; revision ID scope binding. |
| Reader returns excessive history | Memory/latency spike. | 366-day input cap, indexed overlap, deterministic order, hard 10,000-row failure. |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Peer selector unavailable to editor | Agent/channel row cannot be safely authored. | Disable affected type with localized reason; retain inaccessible stored-ID fallback. |
| Additive generated registry changes | Snapshot/manifests require updates. | Generation plus exact COST-INT-009 assertions. |

## Gap Analysis

### Critical Gaps (Block Implementation)

None.

### Important Gaps (Should Address)

None.

### Nice-to-Have Gaps

- Future provider ingestion can add a provider namespace if two providers can emit the same invoice/line identifiers; this manual/provider-invoice v1 contract intentionally has no provider integration.

## Remediation Verification

| Previous Finding | Revised Contract | Status |
|---|---|---|
| Forbidden `.ai/qa/tests` executable file | Module-local `connect_analytics/__integration__/TC-CONNECT-COST-INPUTS` plus metadata | Resolved |
| Missing analytics module prerequisite/scaffold | AN-MOD-01 strict order or unchanged fallback scaffold; complete shared-file manifest | Resolved |
| Missing currency seam/selector authorization | Extension-owned base-currency adapter; singleton analytics options route; fail-closed absence | Resolved |
| Undefined bigint conversion/bounds | Canonical string grammar, bigint maximum, ORM/DTO/OpenAPI conversions | Resolved |
| Sensitive undo/audit snapshot | Encrypted revision-secret entity; redacted command/audit/event payload; scoped undo | Resolved |
| Provider normalization/grain/idempotency | Exact NFC/whitespace/lowercase canonicalization; invoice+line unique key; replay comparison | Resolved |
| Missing ACL/setup/search/metadata | Exact modifications, safe search policy, events, generated manifest test | Resolved |
| Incomplete CRUD/OpenAPI/errors | Method-specific schemas, guards, responses, status codes, organization resolution | Resolved |
| Unbounded/unordered reader | Exact overlap, 366-day/10,000-row bounds, stable ordering | Resolved |
| Rollback ambiguity | Generated down separated from operational disable/data retention | Resolved |

## Remediation Plan

### Before Implementation (Must Do)

None; the specification is implementation-ready.

### During Implementation (Required by Spec)

1. Land/verify AN-MOD-01 before additive cost changes and generate only intended discovery/schema diffs.
2. Implement currency and cost readers, revision-secret privacy boundary, exact money/provider schemas, commands/routes/UI, and COST-INT-001..009.
3. Run migration probe/no-op confirmation, package/root gates, integration/UI coverage, i18n/DS checks, and record runner mode.

### Post-Implementation (Follow Up)

1. Cost-per-contact consumes only `connectCostInputReader` and preserves its decimal-string contract.
2. Provider integration, if added, reuses or versions the invoice-line identity contract rather than silently changing it.

## Recommendation

**Ready to implement.** No critical or important readiness gap remains after re-audit.

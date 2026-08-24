# Pre-Implementation Analysis: Mercato Connect — SLA and Business Calendars

## Executive Summary

The optional `connect_sla` module is architecturally ready and its SLA source-facts prerequisite has landed through PR #47. Implementation is blocked by one residual prerequisite defect: Connect reparenting neither snapshots nor propagates `slaGeneration`, so split/merge/undo clocks cannot be reconciled according to the approved contracts. A second contract clarification is required for the new Inbox injection host because the proposed host context contains SLA-owned values that Connect cannot resolve without reversing the declared dependency.

## Backward Compatibility

### Violations Found

| # | Surface | Issue | Severity | Proposed Fix |
|---|---|---|---|---|
| 2/5 | Types and events | Reparent snapshots/events omit the additive generation required by the merged source-facts contract. | Critical | Add `slaGeneration` to the Connect-owned snapshot/view/event lineage contract and copy it to split children before implementing the consumer. |
| 6 | Widget injection spot | The proposed host context asks Connect to supply SLA-owned clock state despite the strict one-way dependency. | Critical | Freeze a Connect-owned host context (`caseId`, optional `retryLastMutation`) and let the SLA widget load its own clock, or explicitly approve a different dependency architecture. |

No existing contract is removed, renamed, or narrowed. The remaining discovery, API, schema, DI, ACL, command, event, and generated-registry changes are additive.

### Missing BC Section

The spec discusses migration and backward compatibility, but does not use the contract-required exact heading `Migration & Backward Compatibility`. Rename the section before release and enumerate the current 14-category contract (including AI identifiers), rather than the historical 13-category count.

## Spec Completeness

### Missing Sections

| Section | Impact | Recommendation |
|---|---|---|
| Exact file/API/DI manifest | Public names cannot be audited or frozen from the current summary. | Record exact routes, command IDs, DI keys, entity IDs, and files during implementation. |

### Incomplete Sections

| Section | Gap | Recommendation |
|---|---|---|
| Integration coverage | Scenarios are comprehensive but not assigned stable test IDs/files. | Add SQL-only Playwright suites for APIs, clocks, rebuild races, tenancy/RBAC, reparenting, OpenAPI, and UI/locales. |
| Widget host | Context ownership contradicts module independence. | Resolve as described above before binding the host. |

## AGENTS.md Compliance

### Violations

| Rule | Location | Fix |
|---|---|---|
| Optional consumers may use DI and scalar IDs only. | `connect:inbox:case-detail:sla` context | Keep SLA-owned state out of the Connect host context. |
| New public identifiers must be explicit and additive. | API/command/DI summary | Pin exact identifiers in the spec changelog/implementation status. |
| Prerequisites must be implemented before dependent work. | Reparent generation lineage | Complete and test generation propagation first. |

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Missing generation on split/undo | Clocks attach to the wrong lifecycle generation. | Add generation to immutable lineage snapshots/events and integration tests. |
| DST/business-time arithmetic | Incorrect contractual deadlines. | Pure deterministic library with gap/fold/non-hour/property tests. |
| Watermark/live-event races | Missing or double-applied facts. | Transactional receipts, bounded watermark, deterministic keys, lease/concurrency PostgreSQL tests. |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Deadline contention | Duplicate breach transitions or DB pressure. | Bounded `SKIP LOCKED` claims and conditional updates. |
| Optional dependency absence | Broken Inbox or retry storms. | Soft DI resolution, explicit unhealthy state/503, idempotent no-op workers. |
| Host/template activation drift | Feature is generated but unavailable or stale. | Mirror module activation, run generate/template checks and structural-cache refresh. |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Locale drift | Missing labels in one locale. | Ship en/de/es/ko/pl and run sync/usage checks. |

## Gap Analysis

### Critical Gaps (Block Implementation)

- Reparent generation lineage: `ReparentCaseSnapshotV1`, `ReparentCaseView`, `buildCaseSnapshot`, split child creation, and lineage events do not carry `slaGeneration`.
- Injection ownership: Connect cannot populate SLA-owned clock fields without importing or resolving the optional consumer.

### Important Gaps (Should Address)

- Normalize the BC heading/count and record exact frozen identifiers.
- Add real PostgreSQL coverage for partial uniqueness, leases, receipts/outbox atomicity, and `SKIP LOCKED` behavior.

### Nice-to-Have Gaps

- None; reporting, notifications, routing, remote calendars, bots, and costing remain intentionally out of scope.

## Remediation Plan

### Before Implementation (Must Do)

1. Complete the Connect-owned generation lineage prerequisite in its source/reparenting contract.
2. Approve a Connect-owned injection context and SLA-side clock fetch.

### During Implementation (Add to Spec)

1. Record the exact file manifest and frozen identifiers.
2. Add phase status and stable integration test IDs as each slice lands.
3. Normalize the migration/backward-compatibility section and category count.

### Post-Implementation (Follow Up)

1. Run the ordered validation gate locally or in Docker, the executable Playwright suites, template parity, module decoupling, i18n advisory checks, and structural-cache refresh.

## Recommendation

Ready to implement. On 2026-08-24 the owner approved bundling the generation-lineage prerequisite and selected the Connect-owned host context with SLA-side clock loading.

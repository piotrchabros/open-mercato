# Mercato Connect — Operational Metrics Baseline

| Field | Value |
|---|---|
| Date | 2026-08-21 |
| Status | Proposed; independently deployable after Foundation and Inbox |
| Scope | Measurable operational events, daily aggregates, and an admin metrics screen |
| Depends on | Connect Foundation and Inbox Operations; projection metric family additionally activates only when Customer Projection is present |

## 📝 TLDR

Instrument Connect with metrics whose numerators, denominators, writers, and time windows are explicit. The first release establishes an operator baseline; it does not claim ROI. Inbound reconciliation, loop suppression, projection lag, first-response time, and handle time are computed only from Connect-owned facts or explicit source-owned event contracts.

## 📝 Problem Statement

Earlier success criteria named counters that could not measure their claims: opened Cases were compared with all inbound messages despite valid attachments, a tenant-daily suppression count was used for a per-sender bound, pending projections measured the opposite population, and handle time had no writer. Metrics shipped under those definitions would look authoritative while concealing failures.

## 📝 Proposed Solution

Store immutable Connect operational facts at each domain write, then aggregate daily in tenant scope. Define each measure with a formula and accountable writer. The product reports observed baseline values after 30 complete days; thresholds beyond safety gates are configured only after that baseline exists.

The metrics package remains a separate specification because Connect works without it and reporting can ship or roll back independently.

## 📝 Metric Contracts

| ID | Definition | Source/writer | Window |
|---|---|---|---|
| `inbound_claimed` | count of receipts entering processing | receipt-claim cohort | immutable claim UTC date |
| `cases_opened` | receipts with disposition `opened` | ingest transaction | day |
| `cases_attached` | receipts with disposition `attached` | ingest transaction | day |
| `inbound_suppressed` | receipts classified suppressed | classifier transaction | day |
| `ingest_unreconciled` | `inbound_claimed - opened - attached - suppressed - dead_lettered`, plus processing age | claim/disposition facts | must equal 0 after processing lease; dead letters reported separately |
| `observed_max_permitted_inbound_per_sender_window` | observed maximum unique receipts permitted (not suppressed) for `(channel,sender_hash)` under the applied setting snapshot; total suppressed remains `inbound_suppressed` | suppression decision facts | rolling event-time window |
| `outbound_attempted` | durable outbound attempts created | enqueue transaction | day |
| `outbound_sent|failed|unknown` | terminal/current attempt states | send/reconcile workers | day/cohort |
| `first_response_seconds` | first confirmed human outbound time minus first inbound time | sent reconciliation | per Case; p50/p90 daily |
| `elapsed_assigned_to_resolution_seconds` | wall-clock resolved time minus first assignment/claim time; includes waiting and off-hours | resolve event | per Case; p50/p90 daily; not active handle time |
| `projection_lag_ms` | upstream projection/tombstone completion minus staged time | Customer Projection persistent events | p50/p90/max daily; omitted when Projection is absent |
| `reopened_cases` | legal resolved->in_progress transitions | lifecycle transition transaction | day |

Safety acceptance criteria:

- **MET-SC-001** `ingest_unreconciled = 0` for every complete day.
- **MET-SC-002** `observed_max_permitted_inbound_per_sender_window <= suppression_count_limit`; the first `limit` unique external-message receipts are permitted and receipt `limit+1` plus an arbitrarily long later stream are suppressed whether earlier receipts opened or attached. Suppressed volume is reported separately and does not make the safety criterion fail. Violations are inspectable without raw handles.
- **MET-SC-003** When Customer Projection is enabled, every resolved linked Case has a successful projection or visible pending/failure fact; p90 lag is reported, not pre-claimed. The family is unavailable, never zero, when that module capability is absent.
- **MET-SC-004** Unknown outbound age and count are visible; no unknown attempt is counted as sent or failed.
- **MET-SC-005** After 30 complete UTC days, volume, inbound/opened/attached split, outbound outcomes, first response, and elapsed assignment-to-resolution baseline are available. No improvement target is asserted until an owner approves one from observed data.

Cross-tenant/cross-customer disclosure remains a release-test hard gate, not a business KPI.

## 📝 Architecture

Metrics consumes persistent Connect domain events and appends idempotent `connect_operational_fact` rows in its own transaction. Domain writes never depend on metrics tables, subscribers, or availability. A daily worker aggregates facts into `connect_metric_daily`; it never queries `messages` or `communication_channels` tables. Optional Inbox/Projection event families register only when their source capability exists. If a peer fact is needed later, the owning module must publish an additive event or facade contract in a separate upstream PR.

```
Connect persistent events -> idempotent operational facts -> daily aggregate worker -> metrics API/UI
                                                    \-> invariant/age alerts
```

Facts use stable event names and dimensions limited to tenant, channel ID, case ID, disposition/status, timestamps, and sender hash where required for suppression analysis. Raw handles and message bodies are forbidden. Subscriber failure retries independently and cannot roll back or reject the source domain transaction.

Event ledger:

| Event ID | Source writer/outbox | Required payload |
|---|---|---|
| `connect.inbound.claimed` | Foundation receipt claim | tenantId, organizationId, receipt ID, channel ID, claimCohortUtcDate, claimedAt, leaseExpiresAt |
| `connect.inbound.disposed` | Foundation terminal transaction | tenantId, organizationId, receipt ID, channel ID, claimCohortUtcDate, sender hash?, disposition, terminalReason?, appliedWindowMinutes?, appliedCountLimit?, occurredAt |
| `connect.case.assigned` | Inbox assign command | tenantId, organizationId, Case ID, from/to assignee, firstAssignedAt, occurredAt |
| `connect.case.resolved` | Inbox resolve command | tenantId, organizationId, Case ID, firstInboundAt, firstAssignedAt, resolvedAt |
| `connect.case.reopened` | Inbox reopen command | tenantId, organizationId, Case ID, occurredAt |
| `connect.outbound.attempted` | Inbox enqueue/retry command | tenantId, organizationId, logical/attempt IDs, enqueueCohortUtcDate, occurredAt |
| `connect.outbound.status_changed` | Inbox hub-outcome subscriber | tenantId, organizationId, Case ID, logical/attempt IDs, immutable firstInboundAt, from/to status, occurredAt, firstConfirmedHumanOutboundAt |
| `connect.projection.status_changed` | Projection workers | tenantId, organizationId, Case/projection IDs, from/to status, stagedAt, completedAt |

Payloads are additive-only after publication. Foundation/Inbox/Projection tasks that introduce a writer also add its domain-outbox record and integration test; Metrics only subscribes.

First-response aggregation joins no mutable Case table: the first confirmed outbound event carries both Case ID and its immutable first-inbound timestamp. Acceptance includes a replied-but-never-resolved Case and verifies its fact enters the daily percentile cohort exactly once.

Outbound outcomes cohort by immutable enqueue UTC date. The denominator is attempts enqueued in that cohort; each attempt occupies exactly one current bucket (`queued|sending|unknown|sent|failed`). Late transitions rebuild/version the enqueue cohort, and UI labels “attempts enqueued on DATE,” never outcome day.

Inbound terminal facts always update/version their immutable claim cohort, including after midnight. The processing lease cutoff defines when a claim becomes unreconciled; UI labels “receipts claimed on DATE.” Dead-letter count is separate from zero-reconciliation and links to authorized exception detail.

## 📝 Data Model

- `connect_operational_fact`: tenant, non-null organization, fact type, Case/conversation/attempt/projection IDs, channel ID, optional sender hash, numeric value, occurred_at, unique scoped source key.
- `connect_metric_daily`: tenant, organization, UTC date, counters above, first-response p50/p90, elapsed-assignment-to-resolution p50/p90, projection p50/p90/max, unknown outbound count/max age, generated_at; unique `(tenant_id, organization_id, date)`.

Facts are append-only and idempotent by source key. Aggregates are rebuildable. Retention and hash access follow privacy policy; raw PII is not stored.

## 📝 API Contracts

- `GET /api/connect/metrics/summary?from&to`: tenant-and-organization-scoped complete-day aggregates, max range and page limits.
- `GET /api/connect/metrics/exceptions?type&cursor`: authorized exceptions including unreconciled inbound, `dead_lettered`, suppression violations, stale unknown sends, and projection failures. Dead-letter detail exposes safe reason code/scope/timestamps and links to Foundation-owned replay/ack commands; Metrics never mutates receipts.
- `POST /api/connect/metrics/rebuild`: privileged guarded command for a bounded date range; creates a shared `ProgressJob`, queues work, and returns 202 with operation ID.

All per-method metadata uses `connect.metrics.view` or `connect.metrics.manage`. Organization is an authorization boundary. Cross-tenant and cross-organization identifiers return 404. Rebuild exposes queued/running/partial/failed/completed progress, prevents overlapping organization/date jobs, retries failed partitions, and keeps last-good aggregates marked stale until atomic replacement; cancel stops only unstarted partitions.

## 📝 UI/UX

`/backend/connect/metrics` is an admin/operations screen, not a front-line Inbox tab. It labels all day boundaries UTC and shows the selected complete range, baseline maturity (complete UTC days out of 30), reconciliation equation, outcome distributions, p50/p90 response and elapsed assignment-to-resolution times, projection lag, and actionable exception counts. Empty states distinguish no traffic, incomplete UTC day, and missing aggregation. Charts reuse shared backend components and semantic tokens.

Every chart has a synchronized table/text equivalent, non-color encoding, keyboard navigation, visible focus, and screen-reader labels. Progress/exceptions announce updates without stealing focus. Browser tests cover keyboard/screen-reader traversal and high-contrast/non-color comprehension.

## 📝 Edge Cases & Failure Scenarios

- Late event crosses day boundary: rebuild only the affected tenant+organization+UTC days idempotently; sibling organizations are untouched and covered by isolation tests.
- Worker rerun: unique source facts and deterministic aggregate replacement prevent double count.
- Unknown send later resolves: cohort outcome updates on rebuild; historical attempted count does not change.
- No assignments: elapsed assignment-to-resolution population is empty and shown as unavailable, never zero.
- Fewer than 30 days: baseline maturity shown; no trend claim.
- Tenant timezone change: history is not reinterpreted because Phase 1 reporting is explicitly UTC.

## 📝 Risks & Impact Review

| Risk | Severity | Mitigation | Residual risk |
|---|---|---|---|
| Misleading KPI | High | Formula/source/window table and reconciliation invariant | Operators may still over-interpret short samples |
| PII leakage in dimensions | High | Sender hash only, restricted exceptions ACL, retention | Hash correlation is sensitive and access-controlled |
| Aggregate drift | High | Append-only source facts, deterministic rebuild, invariant alerts | Bugs can require historical rebuild |

Rollback hides the screen and stops aggregation; immutable facts remain available for rebuild. No domain behavior depends on metrics availability.

## 📝 Migration & Backward Compatibility

This spec adds only Connect-owned tables, APIs, ACL IDs, jobs, and UI routes. Published metric field names and formulas become STABLE; changing a formula requires a versioned field rather than silently reinterpreting history. No peer contract changes are included.

## 📋 Phasing

1. Operational fact schema and independent persistent-event subscribers.
2. Deterministic aggregation, rebuild, and exception APIs.
3. Admin metrics screen and 30-day baseline maturity.

## 📋 Implementation Plan

- **MET-DATA-01** metrics entities, validators, migration, indexes, and retention configuration.
- **MET-WRITE-01** idempotent metrics subscribers and fact mapping for the event ledger; source specs own definitions/emits/outbox integration tests, and metrics failure never blocks source writes.
- **MET-AGG-01** deterministic daily aggregation and percentile utilities with tests.
- **MET-WRK-01** Aggregate/rebuild worker on `connect.metrics.aggregate`; `setup.seedDefaults` registers stable per-organization schedule `connect:{organizationId}:metrics-daily` through optional `schedulerService` with documented UTC cadence/late-event rebuild window. Metrics stays unavailable with explicit health when scheduling is absent. Test stable registration, scheduler absence, commit-before-enqueue/late-event recovery, tenant isolation, optional-family capability detection, progress reporting, and bounded concurrency.
- **MET-API-01** summary, exceptions, and guarded rebuild routes with OpenAPI and per-method metadata.
- **MET-UI-01** admin metrics page using shared chart/KPI/detail components and complete locales.
- **MET-TEST-01** Reconciliation arithmetic across opened/attached/suppressed and duplicate ingest.
- **MET-TEST-02** Per-pair permitted-receipt maximum with attachment-heavy, duplicate-message, and long post-limit suppressed streams remaining safety-green; unknown-send aging, projection lag, percentile (including replied-before-resolve), late/reversed delivery-revision rebuild without terminal regression, and idempotent rerun.
- **MET-TEST-03** Cross-tenant API isolation and proof that no raw handle/body enters facts, API, logs, or search.
- **MET-TEST-04** Cross-organization fact/API/rebuild isolation, proving an org rebuild cannot replace a sibling aggregate.
- **MET-TEST-05** Accessible chart/table/progress navigation, enqueue-cohort late transitions, and suppression limit boundary/settings-change rebuild.
- **MET-TEST-06** Dead-letter exception detail, replay eligibility/idempotency, acknowledgement audit, and midnight claim-cohort late-terminal rebuild.

## 📝 Final Compliance Report

- Every measure has a formula, writer, source, and window.
- Metrics never query peer storage or become a dependency of domain writes.
- ROI is explicitly deferred until 30 days of operator data exist.
- Sensitive dimensions exclude raw handles and message content.

## Changelog

- 2026-08-21: Successor split from v2; replaced unmeasurable criteria with reconciled Connect-owned facts and explicit baseline semantics.

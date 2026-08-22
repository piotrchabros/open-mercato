# Mercato Connect — SLA and Business Calendars

| Field | Value |
|---|---|
| Date | 2026-08-22 |
| Status | Proposed; ready after prerequisite contracts |
| Scope | `connect_sla` policies, calendars, generation-aware clocks, response stamping, reconciliation |
| Depends on | Auth principal-kind contract; Connect Case re-parenting contract; Phase 1 Connect |

## TLDR

Add a separately activatable `connect_sla` module with versioned policies and timezone-correct business calendars. Each Case generation receives an immutable policy/calendar snapshot and deadlines. `responded_at` is stamped exactly once only from confirmed delivery with immutable evidence of a human author or human-accepted AI draft. Split inherits the parent's response clock; merge terminates the losing clock as `merged`. Enable-time reconciliation derives clocks from Phase 1 facts idempotently.

Out of scope: routing, offers, live channels, bots/AI generation, remote iCalendar synchronization, and changing Phase 1 Case API fields.

## Overview

Phase 1 stores `ConnectCase.firstOutboundSentAt`, but it is not human-qualified and cannot be the canonical SLA response value. SLA therefore consumes identifier-only Connect events plus scoped source-owned readers; it never imports Connect or Auth ORM entities. Disabling the module removes its routes/navigation/workers while retaining data.

> **Market references:** Zammad makes calendars first-class SLA inputs with timezone, business hours, and holidays; Cal.com models timezone-bound weekly availability plus date overrides. We adopt those shapes and deterministic policy precedence. We reject runtime coupling to `planner`, whose fixed-millisecond recurrence is not DST-correct, and defer remote iCalendar sync because it adds SSRF, provenance, and retry semantics.

## Problem Statement

Elapsed wall time cannot represent support commitments across local working hours, holidays, and DST. A mutable deadline derived from today's policy would rewrite history. Concurrent delivery outcomes can also double-claim a first response, while missing/system authors must fail closed rather than count as human.

## Proposed Solution

- New module `packages/connect/src/modules/connect_sla` with its own entities, ACL, DI, APIs, workers, events, migrations, snapshot, and five locales.
- Connect exposes `connectCaseSlaReader`; Auth exposes `authPrincipalKindReader`. Both return scoped plain values and are resolved softly through DI.
- Policies and calendars are editable identities whose published versions are immutable. Clocks reference versions and snapshot computed targets.
- Persistent subscribers install before reconciliation. Every source event is deduplicated; reconciliation paginates and upserts the same deterministic keys.
- Business-time arithmetic operates on IANA zones/local dates, explicitly resolves DST gaps/folds, and never adds fixed UTC milliseconds.

## Architecture

```text
Auth principal reader ──┐
Connect outbox events ──┼─> connect_sla subscribers -> clock/event receipt transaction
Connect SLA reader  ────┘                 │
policy + calendar versions ───────────────┘
                                          └─> scoped SLA reader/API/optional UI injection
```

Policy precedence is ascending `priority`, then stable policy UUID. The first active matching policy wins. A clock snapshots the selected policy version and calendar version; later edits affect only new generations or an explicit guarded rebuild that creates a new versioned outcome, never historical values in place.

Response clocks never pause. Resolution pause accrues only for a proven customer-wait interval; calendar closures already exclude non-business time and are never also added as pause seconds.

## Data Models

Every row has UUID `id`, non-null `tenant_id` and `organization_id`, `created_at`; editable identities also have optimistic-lock `updated_at` and nullable `deleted_at`.

### `connect_sla_business_calendar`

`name`, `timezone` (validated IANA), `is_default`, `published_version`, lifecycle columns. At most one active default per organization.

### Immutable calendar versions

`connect_sla_business_calendar_version`: `(calendar_id, version)`, timezone snapshot, publisher/time. Children are non-overlapping `connect_sla_business_window` rows (weekday `0..6`, local start/end) and unique-date `connect_sla_business_holiday` rows. Holiday label is operator free text and is encrypted through `connect_sla/encryption.ts`; reads use `findWithDecryption`.

### Policy and version

`connect_sla_policy`: `name`, `priority`, `is_active`, `current_version`, lifecycle columns. Immutable `connect_sla_policy_version`: `(policy_id, version)`, optional scalar `channel_id`, response/resolution target business minutes, warning minutes, calendar-version ID, effective/published metadata.

### `connect_sla_case_clock`

Unique `(tenant_id, organization_id, case_id, generation)`; policy/calendar version IDs; `started_at`, `response_due_at`, nullable immutable `responded_at`, `resolution_due_at`, `response_paused_seconds = 0`, `resolution_paused_seconds`, `resolved_at`, `outcome = open|met|breached|merged|superseded`, nullable `superseded_by_case_id`, `response_evidence = human|human_accepted_ai|unknown`, optimistic version.

### Idempotency state

`connect_sla_event_receipt` stores a scoped unique source-event ID; `connect_sla_rebuild_checkpoint` stores a resumable page watermark. No message body, address, handle, subject, or customer identity enters SLA storage/events.

## Commands and Events

All mutations use commands; CRUD commands provide audit/undo for identity edits while published versions are superseded, never altered.

- `connect_sla.policy.create|update|delete|publish`
- `connect_sla.business_calendar.create|update|delete|publish`
- internal `connect_sla.clock.start|stamp_response|resolve|reparent|rebuild`

Events declared through `createModuleEvents` are identifier-only: `connect_sla.clock.started`, `.responded`, `.resolved`, `.breached`, `.merged`. Subscribers to `connect.case.opened|reopened|resolved`, `connect.outbound.status_changed`, `connect.case.split`, and `connect.case.merged` are persistent and idempotent.

Stamping uses a conditional update under a transaction (`responded_at IS NULL`) plus receipt uniqueness. Human evidence is snapshotted by Connect when enqueueing and emitted only when delivery is confirmed. `system_bot`, `integration`, missing/deleted/cross-tenant principals, sentinel IDs, and unknown values never stamp. A human-accepted AI draft requires non-null, same-scope `acted_by_user_id` independently resolved as human.

Split creates the child's generation with the parent's policy/calendar version, response due/value, and generation; only resolution may restart. Merge marks every losing open clock `merged`, sets `superseded_by_case_id`, and excludes it from attainment. The winning Case clock is unchanged.

## API Contracts

All route files export OpenAPI and per-method metadata.

- `GET|POST|PUT|DELETE /api/connect-sla/policies` — `makeCrudRoute`, `connect_sla.policies.view/manage`, `updatedAt`, conflict 409.
- `GET|POST|PUT|DELETE /api/connect-sla/calendars` — canonical CRUD and version publication.
- `GET /api/connect-sla/clocks?caseId&cursor` — `connect_sla.clocks.view`; source-owned Case access is rechecked; foreign scope returns 404.
- `POST /api/connect-sla/clocks/rebuild` — guarded custom update, bounded organization/date/cursor request, shared ProgressJob, returns 202.

Lists use cursor pagination and page size ≤100. Invalid timezone/windows return field-level 400; missing dependency returns explicit 503; overlapping rebuild returns 409.

## UI/UX and i18n

Settings pages use `DataTable` and `CrudForm`. Inbox SLA state arrives through an optional injection host/read facade; Connect never imports SLA UI. Status uses `StatusBadge`, async states use shared detail/empty primitives, dialogs support Cmd/Ctrl+Enter and Escape, and icon-only actions have labels. All strings ship in `en`, `de`, `es`, `ko`, and `pl`.

## Enablement and Backfill

Auth and Connect evidence migrations land first. SLA installs subscribers, then paginates `connectCaseSlaReader`. Historical outbound rows carry `actor_user_id`; the reader resolves their same-tenant principal kind after auth backfill. Missing/deleted authors remain unknown, never guessed human. A watermark plus unique clock/receipt keys makes enable, retry, crash recovery, and live-event races converge.

## Integration Test Coverage

- Human, bot, integration, sentinel, deleted, malformed, cross-tenant and accepted-AI evidence; concurrent sends produce one stamp.
- DST spring gap/fall fold, holidays, overnight/adjacent windows, timezone versions and monotonic deadlines.
- Duplicate/out-of-order events, live/backfill races, split inheritance and merge loser closure.
- Tenant/org/API/worker/cursor isolation, ACL wildcards, dependency absence, disable/enable and PII scans.
- Optimistic-lock update/delete conflicts, accessible CRUD/Inbox state and complete locales.

## Migration & Backward Compatibility

All schemas, APIs, ACLs, events, DI services and injection hosts are additive. Existing `connect.*` contracts remain unchanged. New event IDs and API fields become frozen/stable on publication. No migration is applied by automation; `yarn db:generate` is a diff probe and the module snapshot ships with intended SQL only.

## Risks & Impact Review

#### Incorrect business-time deadline
- **Scenario:** DST or overlapping windows shift a due date.
- **Severity:** High
- **Affected area:** SLA attainment and warnings.
- **Mitigation:** IANA-zone algorithm, validated immutable versions, transition-boundary property tests.
- **Residual risk:** Timezone database updates may change future, never historical, calculations.

#### False human response
- **Scenario:** Missing/system principal is treated as human or two sends race.
- **Severity:** Critical
- **Affected area:** Compliance reporting.
- **Mitigation:** Fail-closed reader, immutable evidence, conditional stamp, scoped receipt uniqueness.
- **Residual risk:** Pre-contract deleted authors remain explicitly unknown.

#### Reconciliation overload
- **Scenario:** Enablement scans millions of Cases or races live events.
- **Severity:** Medium
- **Affected area:** Database load and completeness.
- **Mitigation:** Cursor batches, bounded workers, checkpoints and idempotent upserts.
- **Residual risk:** Large tenants expose progress until complete.

## Implementation Plan

1. **SLA-DATA:** scaffold, ACL/setup/DI, entities, encryption, migration/snapshot.
2. **SLA-CAL:** timezone calendar engine and policy/version commands with property tests.
3. **SLA-CLOCK:** scoped readers, subscribers, conditional stamping, re-parenting and events.
4. **SLA-BACKFILL:** resumable worker, progress and enablement reconciliation.
5. **SLA-API/UI:** APIs, settings pages, optional Inbox widget and five locales.
6. **SLA-TEST:** integration/browser isolation, concurrency, DST, locking and accessibility.

## Final Compliance Report — 2026-08-22

### AGENTS.md Files Reviewed

- `AGENTS.md`, `.ai/specs/AGENTS.md`, `packages/core/AGENTS.md`, `packages/core/src/modules/auth/AGENTS.md`
- `packages/events/AGENTS.md`, `packages/queue/AGENTS.md`, `packages/ui/AGENTS.md`, `packages/ui/src/backend/AGENTS.md`, `packages/cli/AGENTS.md`

### Compliance Matrix

| Rule | Status | Notes |
|---|---|---|
| Module isolation and organization scoping | Compliant | Scalar IDs, scoped DI readers, 404 isolation |
| Canonical CRUD/HTTP/guards/locking | Compliant | Factory, guarded rebuild, `CrudForm`, `updatedAt` |
| Events/workers idempotent | Compliant | Persistent receipts and standard workers |
| Encryption and PII minimization | Compliant | Holiday-label map; no message/customer content |
| Design system/i18n/accessibility | Compliant | Shared primitives, semantic tokens, five locales |
| Additive compatibility | Compliant | New module/surfaces only |

### Internal Consistency Check

| Check | Status | Notes |
|---|---|---|
| Models match APIs/UI | Pass | Editable identities and read-only clocks align |
| Commands cover mutations | Pass | CRUD/version/rebuild/clock commands named |
| Risks cover writes/backfill | Pass | Concurrency, DST and scan load covered |
| Cache strategy | Pass | No cache in v1 |

### Verdict

Fully compliant and ready after prerequisite contracts and readiness audit.

## Changelog

### 2026-08-22

- Initial successor specification; owner chose a `connect_sla`-owned calendar and separate Auth/Connect prerequisites.

# Mercato Connect — SLA and Business Calendars

| Field | Value |
|---|---|
| Date | 2026-08-22 |
| Status | Proposed; ready after prerequisite implementation and maintainer contract approval |
| Scope | Optional `connect_sla` calendars, policies, clocks and reconciliation |
| Depends on | Connect SLA source facts contract; Connect Case re-parenting contract |

## TLDR

Add the soft-optional `connect_sla` consumer. It owns immutable policy/calendar versions, independent response/resolution states, deadline workers and reconciliation. It consumes the separate Connect SLA source-facts contract and never infers from mutable Connect rows. Existing unverifiable sends arrive as `unknown` and never count.

Out of scope: routing, offers, bot generation, remote iCalendar sync, reporting and cost accounting.

## Overview and Problem

Wall time cannot represent timezone business commitments, mutable policies must not rewrite history, and asynchronous facts must converge across duplicate/live/backfill races. The separate source contract supplies immutable evidence, generation and complete lifecycle facts.

The dependency direction is strict: SLA accesses Connect only through DI and scalar IDs. Missing facades make workers no-op with unhealthy state and routes return `503 dependency_unavailable`. Disabling SLA retains data and changes no Connect behavior.

## SLA Data Model and State Machines

All tables are plural snake-case with UUID, tenant, organization and created time. Peer links are scalar IDs.

- `connect_sla_business_calendars`: name, default flag, current version, updated/deleted; scoped active-name unique and one active default; optimistic lock.
- `connect_sla_business_calendar_versions`: calendar/version/timezone/publisher/published; scoped unique and immutable.
- `connect_sla_business_windows`: version, weekday Sunday=0..Saturday=6, local start/end; publication normalizes overnight and rejects overlap.
- `connect_sla_business_holidays`: version/date/encrypted nullable label; scoped unique. Label is in `connect_sla/encryption.ts`; reads use `findWithDecryption`.
- `connect_sla_policies`: name, priority, active/current version, updated/deleted; optimistic lock.
- `connect_sla_policy_versions`: policy/version, nullable channel, positive response/resolution target minutes, nonnegative warnings below targets, calendar version, effective/published metadata; immutable.
- `connect_sla_case_clocks`: scoped unique case/generation; source/version IDs; immutable start/due values; independent response and resolution fields; pause/lineage; internal version and updated time.
- receipts unique scoped source-event/consumer-version; rebuild runs unique scoped command key with watermark, three cursors, lease, status/counts/ProgressJob; append-only clock revision audit.

Policy match at start: active/effective exact Case channel before null wildcard, then ascending priority and policy UUID. No match creates an observable `no_policy` result and no clock. Referenced versions cannot delete. Publish inserts next immutable version; undo supersedes rather than edits history.

Response state is `open|met|breached|unknown`; resolution is `open|met|breached|merged|superseded`. Response never pauses. Due worker makes open→breached once; later response stores timestamp but remains breached. Unknown never stamps. Resolution breach likewise remains after late resolution. Merge changes only losing current open resolution to merged; prior generations/response remain. Rebuild creates an audited replacement revision and supersedes erroneous state rather than rewriting history.

## Normative Business-Time Algorithm

Use existing `date-fns-tz`, no new dependency.

1. Validate IANA zone with `Intl.DateTimeFormat`.
2. Windows are local `[start,end)` at second precision; integer minutes become seconds; zero target returns input.
3. Publication splits overnight windows across dates, merges adjacent segments, rejects overlap; a holiday removes segments whose local start date equals it.
4. Resolve boundaries by round-trip local components. In a DST gap advance to first valid instant after the gap. In a fold choose earlier instant for start and later for end, counting the repeated interval once across full real duration.
5. Iterate local dates, intersect resolved segments with cursor onward, consume real seconds. Bound search to 3,660 dates/10 years; no reachable time is `calendar_exhausted`; empty calendars cannot publish.
6. Pause measurement intersects `[waitStart,waitEnd)` with the same business segments, so closed time is not double-counted. Recomputed due is addBusinessSeconds(start,target+businessPauseSeconds).

Tests pin gaps/folds, non-hour offsets, overnight/adjacent, holidays, leap day, exact boundaries, monotonicity and add/measure round trips. Persisted UTC deadlines do not change with future tzdata.

## Commands, Events, Workers and Reconciliation

Strict Zod/inferred commands: policy/calendar create/update/delete/publish; internal clock apply-source/evaluate-due/reparent/rebuild. User CRUD uses canonical logs and `extractUndoPayload`; unsafe referenced publication/delete rejects. Internal facts are idempotent, not user undo. Rebuild has reason, guards, optimistic run version and revision audit.

SLA events: `connect_sla.clock.started|responded|response_breached|resolved|resolution_breached|merged|superseded`, exact V1 payload `{schemaVersion,clockId,caseId,generation,responseState,resolutionState,occurredAt,sourceEventId}`. Receipt, conditional clock update and outbox event share one transaction.

Queues are `connect_sla.deadline_sweep` and `connect_sla.rebuild`. One-minute sweep claims ≤100 due open clocks by `(next_due_at,id)` with `FOR UPDATE SKIP LOCKED`; conditional transitions converge. Warning is derived presentation; v1 adds no notification ID.

Enable/rebuild: verify Auth remediation and facade schema plus Connect reader v1; install persistent subscribers; create run and capture watermark; page all three streams through it; upsert deterministic case/generation and receipts; treat pre-evidence rows as unknown; commit each cursor with its page. Live events ≤watermark converge by keys; >watermark are subscriber-only. One scoped/range lease; same key replays, overlap is 409; expired lease reclaims; cancel preserves applied facts and retry resumes.

Split copies parent response facts/policy/calendar/start/due into child same-number generation; only future resolution pause diverges. Merge marks losing current resolution merged. Undo creates audited clock revision only when lineage version proves safety; otherwise manual review. Reconciliation uses the reparenting reader.

## API, ACL and UI Contracts

Canonical collection/item routes for policies and calendars, plus `[id]/publish`; clocks GET; guarded `POST /api/connect-sla/clocks/rebuild`; rebuild status GET. Every route exports OpenAPI/per-method metadata. `makeCrudRoute` handles identity CRUD; publish/rebuild use mutation guards plus legacy bridge. Exact errors: field 400, hidden 404, optimistic/overlap 409, dependency 503. Clock read calls Connect `canReadCase`. Lists are cursor ≤100.

ACL IDs: `connect_sla.policy.view|manage`, `connect_sla.calendar.view|manage`, `connect_sla.clock.view|rebuild`; setup syncs administrator grants for new/existing tenants and wildcard tests. Workers use scoped system authority.

UI uses DataTable, CrudForm, apiCall, guarded mutations, shared conflict/loading/error/empty primitives, StatusBadge, semantic tokens, keyboard controls and accessible icon labels. Additive host `connect:inbox:case-detail:sla` carries `{caseId,clockId,responseState,resolutionState,responseDueAt,resolutionDueAt,retryLastMutation?}`; Connect never imports SLA. Keys ship en/de/es/ko/pl.

## Migration, Phasing and Tests

Deploy order: approved Connect SLA source facts and reparenting contracts; SLA schema disabled; then scoped enable/reconcile. Generate/review intended SLA SQL/snapshot; remove unrelated drift; never automate `db:migrate`.

Phases/files: create `connect_sla` discovery/ACL/setup/DI/events, data/validators/encryption/migration, business-time, commands/subscribers, deadline/rebuild/schedule workers, APIs/UI/locales/tests. No Connect source file is modified by this spec except the separately approved injection host integration. Run generate, focused DB/concurrency/integration/browser tests, package build/typecheck, decoupling, i18n advisory checks and standalone harness refresh.

Self-contained tests create API fixtures and clean in `finally`: all principal/evidence variants; distinct-attempt race; generations/late delivery/wait boundaries; DST/property cases; policy matching/version deletion/locking; watermark crash/live races/leases/unknown history; split/merge/undo; tenant/org/worker/cursor/ACL/dependency/PII; every API and accessible UI/locales.

## Risks and Backward Compatibility

Critical risks—false human, wrong generation, missing pause—are mitigated by immutable evidence, enqueue generation and complete facts. High risks—DST and backfill races—use normative arithmetic and subscriber-first watermark. Medium risks—due contention/dependency absence—use bounded indexed claims and explicit health/503.

All 13 surfaces are additive: discovery files; exact SLA types/functions; no import moves; new SLA event IDs; new widget host; new API URLs; additive SLA schema; new SLA DI keys; six ACL IDs; no notifications; no CLI; additive generated registries. Connect source contracts belong exclusively to the prerequisite spec. New identifiers require named maintainer approval and freeze on release.

## Final Compliance Report — 2026-08-22

Scope cohesion passes after owner-selected split: this spec owns only the optional SLA consumer. Isolation/scoping, deterministic calendar, canonical commands/undo, guarded APIs/locking, encryption/PII, idempotent workers/rebuild, UI/DS/i18n and all 13 BC categories pass at contract level.

## Review — 2026-08-22

Owner selected SPLIT. Source facts moved to the Connect-owned prerequisite; this consumer retains only calendars/policies/clocks/reconciliation. Verdict: ready after named maintainer approval and prerequisite implementation.

## Changelog

- 2026-08-22: Initial successor spec; calendar owned by optional SLA and Auth/reparenting split.
- 2026-08-22: Remediated all readiness blockers with exact Connect source facts and SLA contracts.
- 2026-08-22: Owner selected SPLIT; moved all Connect source-fact ownership to `2026-08-22-connect-sla-source-contract.md` and narrowed this spec to the optional consumer.

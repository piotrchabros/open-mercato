# Mercato Connect — SLA Source Facts Contract

| Field | Value |
|---|---|
| Date | 2026-08-22 |
| Status | Proposed; ready after Auth prerequisite and maintainer approval |
| Scope | Connect-owned immutable response evidence, generation lifecycle, wait facts and scoped SLA reader |
| Depends on | Auth principal-kind contract; Phase 1 Connect; Case re-parenting contract for lineage integration |

## TLDR

Add independently deployable, SLA-agnostic source facts to `connect`. Enqueue snapshots immutable human/accepted-AI evidence and Case generation; delivery serializes the legacy first-send stamp; Connect publishes complete generation/wait/delivery events and exposes a scoped keyset reader. Existing unverifiable sends remain `unknown`. Connect never imports or resolves `connect_sla`.

## Overview and Problem Statement

Phase 1's `firstOutboundSentAt` is unqualified and its writer is not serialized. Case events lack a generation, confirmed outbound/inbound attachment do not produce a complete customer-wait stream, and no bounded read facade exists. Optional clock consumers cannot infer these facts safely from mutable rows.

This contract adds neutral Connect lifecycle/evidence facts useful to any authorized consumer. It does not add calendars, policies, clocks, deadlines, SLA APIs/UI/workers, routing, bots, reporting, or cost accounting.

## Architecture

Auth owns principal classification. Connect softly resolves `authPrincipalKindReader` during evidence-capable enqueue and stores a fact; Auth absence/error yields `unknown` without changing send behavior. Connect owns all source writes, outbox events and `connectCaseSlaReader`. Consumers use DI and scalar IDs only. No cross-module ORM relation or consumer callback exists.

## Data Models

### Case generation

Add `ConnectCase.slaGeneration` / `sla_generation integer not null default 0 CHECK >=0`. Existing/open Cases start at 0. Reopen locks the scoped Case `FOR UPDATE`, increments once with transition/outbox, and emits the new generation. Resolve/close do not increment. Split child inherits source generation; merge leaves target unchanged; reparent snapshots/events carry it.

Add `ConnectOutboundMessage.caseGeneration` / `case_generation integer not null`, read while the Case is locked at enqueue. A late delivery belongs to its enqueue generation, never a later current generation.

### Immutable response evidence

Add to `connect_outbound_messages`:

| Column | Contract |
|---|---|
| `content_origin` | `human_authored|ai_draft|automation` CHECK |
| `author_principal_kind` | nullable `human|system_bot|integration` |
| `accepted_by_user_id` | nullable uuid |
| `accepted_by_principal_kind` | nullable closed kind |
| `response_evidence` | `human|human_accepted_ai|unknown` CHECK |
| `response_evidence_version` | integer, initially 1 |

`human` requires `human_authored` and same-scope human author. `human_accepted_ai` requires `ai_draft`, non-null same-scope acceptor and independently resolved human acceptor kind. All other cases—including Auth absence/error, missing/deleted/wrong-scope/sentinel/future kinds, bot and integration—are `unknown`. Existing trusted human reply routes set origin server-side; clients cannot submit kind snapshots. Future AI actions must supply authenticated acceptance. Evidence is computed once in the enqueue transaction, immutable, and contains no name, email, body, handle or customer data.

### Append-only source facts

Add plural scoped tables `connect_case_generation_facts`, `connect_case_wait_facts`, and `connect_outbound_delivery_facts`, each with UUID, tenant, organization, source event ID, occurred time, created time, closed enum checks and unique scoped source-event ID. Generation fact stores case/generation/cause/start-or-resolution. Wait fact stores case/generation/start/end boundary. Delivery fact stores case/generation/message/attempt/revision/confirmed time/evidence/version/nullable author and acceptor IDs. Index every table on scoped `(occurred_at,id)` and scoped `(case_id,generation,occurred_at,id)`. Facts are append-only and PII-free.

## Commands and Concurrency

Reply command strict Zod input adds server-owned `contentOrigin` and optional authenticated `acceptedByUserId`; types derive with `z.infer`. Enqueue locks scoped Case, resolves Auth through DI, snapshots generation/evidence, and persists outbound/message/attempt/outbox atomically.

`applyDeliveryOutcome` retains delivery-revision idempotency and locks the scoped Case `FOR UPDATE`. It performs a scoped conditional `UPDATE connect_cases SET first_outbound_sent_at=:at WHERE ... AND first_outbound_sent_at IS NULL RETURNING`. Only the returning winner emits the legacy non-null operational field; that legacy field remains unqualified. Attempt revision, Case status, wait/delivery facts and outbox commit atomically. Race tests use two distinct attempts.

These fact applications are idempotent domain commands, not reversible user edits. Existing reply/transition command undo semantics remain unchanged; facts are historical and never deleted by undo.

## Events and Lifecycle

Declare additive identifier-only events with `createModuleEvents`:

- `connect.case.generation_started`
- `connect.case.generation_resolved`
- `connect.case.customer_wait_started`
- `connect.case.customer_wait_ended`
- `connect.outbound.delivery_confirmed`

Every V1 payload has `schemaVersion`, deterministic durable `sourceEventId`, case ID, generation and occurredAt. Delivery adds message/attempt IDs, revision, confirmedAt, evidence/version and nullable author/acceptor IDs. Open emits start generation 0; reopen emits after increment; resolve emits resolved; close alone does not. First confirmed outbound entering waiting emits wait-start. Inbound attached while waiting emits wait-end. Resolve closes an open wait before resolved at the same instant. Repeats outside a boundary emit none. IDs derive from transition/receipt/attempt+revision. Existing events/payloads remain unchanged.

## Exact DI Reader

Register `connectCaseSlaReader`:

```ts
type Scope={tenantId:string;organizationId:string}; type Cursor={occurredAt:string;id:string}
type Page<T>={items:T[];nextCursor:Cursor|null;highWatermark:Cursor}
type GenerationDto={id:string;caseId:string;generation:number;channelId:string;startedAt:string;resolvedAt:string|null;mergedIntoCaseId:string|null;lineageVersion:number;updatedAt:string}
type WaitDto={id:string;caseId:string;generation:number;startedAt:string;endedAt:string|null}
type DeliveryDto={id:string;caseId:string;generation:number;outboundMessageId:string;attemptId:string;deliveryRevision:number;confirmedAt:string;responseEvidence:'human'|'human_accepted_ai'|'unknown';responseEvidenceVersion:1;authorUserId:string|null;acceptedByUserId:string|null}
type ConnectCaseSlaReader={
 captureHighWatermark(scope:Scope):Promise<Cursor>
 listGenerations(scope:Scope,input:{after?:Cursor;through:Cursor;limit:number}):Promise<Page<GenerationDto>>
 listWaitIntervals(scope:Scope,input:{after?:Cursor;through:Cursor;limit:number}):Promise<Page<WaitDto>>
 listConfirmedDeliveries(scope:Scope,input:{after?:Cursor;through:Cursor;limit:number}):Promise<Page<DeliveryDto>>
 canReadCase(scope:Scope&{userId:string},caseId:string):Promise<boolean>
}
```

Every query includes tenant and organization; limit 1..100; stable order/cursor `(occurred_at,id)` ascending; pages are `>after AND <=through` over append-only facts. Empty watermark is epoch/zero UUID. Malformed enum values fail typed/internal, never coerce. Reader types are Connect-owned and import no consumer.

## API/UI/i18n

No new public route, page, widget, notification or user-facing string. Existing reply route contract remains behavior-compatible; new evidence fields are trusted server inputs/internal persistence and are not exposed. Future AI endpoint requires its own contract.

## Migration and Rollout

Deploy Auth principal-kind/read facade first and complete exact-ID remediation. Add generation/evidence columns plus fact tables/indexes. Existing Cases become generation 0. Existing outbounds backfill origin/kinds/evidence as unknown; never resolve present-day users to retro-credit. For large tables use nullable columns, bounded backfill, validate, then set default/not-null. Reparenting migration must include generation snapshots. Generate/review intended SQL and Connect snapshot; remove unrelated drift; never automate `db:migrate`.

Rollback consumers first. Released evidence/events/DI/schema are additive frozen contracts and are not dropped while any consumer exists.

## Implementation Plan and Tests

Modify Connect entities/events/DI and enqueue, delivery, ingest, transition and reparent snapshot call sites. Add `connect/lib/sla-source-reader.ts`, migration/snapshot and focused unit/database/integration tests. Run generate, package build/typecheck, decoupling and standalone harness refresh.

Self-contained tests with fixtures/finally cleanup cover human/bot/integration/sentinel/deleted/wrong-org/Auth absence; accepted/unaccepted AI; immutable classification after user change/deletion; two-attempt delivery race; open/reopen/resolve/close and late old-generation delivery; exact wait boundaries; duplicate/out-of-order events; reader watermark/cursors/scope/limit/malformed rows; historical unknown backfill; split/merge/undo generation; PII scan; old consumer/provider compatibility.

## Risks and Impact Review

False human evidence is critical and mitigated fail-closed at immutable enqueue. Wrong generation and missed waits are high and mitigated with locks, generation snapshot and transactional facts. Large-table migration is medium and uses bounded rollout. Auth absence is medium and produces unknown without send failure. Residual risk is explicit unknown history.

## Backward Compatibility — All 13 Surfaces

Discovery additions; exact additive types/functions; no import moves; five additive event IDs; no widget; no API URL; additive DB; additive DI key; no ACL/notification/CLI; additive generated registry changes. Existing contracts are unchanged. New IDs/types/schema require named maintainer approval and freeze on release.

## Final Compliance Report — 2026-08-22

Scope cohesion passes: this is one independently deployable Connect capability and has no SLA behavior. Isolation, scope, Zod, PII minimization, command/idempotency, concurrency, events, migration, tests and all thirteen BC categories pass at contract level. API/UI/encryption map are N/A because facts contain no free text/PII and no surface is added.

## Review — 2026-08-22

Owner selected SPLIT. Fresh boundary review result: keep this Connect-owned source-fact capability separate from the optional SLA consumer. Ready after Auth prerequisite and named contract approval.

## Changelog

- 2026-08-22: Split from the combined SLA spec by owner decision; exact neutral Connect evidence/generation/lifecycle/reader contract created.

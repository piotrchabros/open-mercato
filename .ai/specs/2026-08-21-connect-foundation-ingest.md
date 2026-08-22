# Mercato Connect — Foundation and Inbound Ingest

| Field | Value |
|---|---|
| Date | 2026-08-21 |
| Status | Proposed; activation blocked on Upstream Shared-Channel Authorization and Inbound Envelope minimum contract versions |
| Scope | OSS; `packages/connect` foundation and inbound e-mail ingest |
| Depends on | Existing inbound event; Upstream Shared-Channel Authorization; Upstream Inbound Envelope Contract |
| Enables | Connect Inbox, Customer Projection, Operational Metrics |
| Supersedes | Foundation/ingest portions of `2026-08-21-connect-phase-1-merged.md` and `2026-08-22-connect-phase-1-v2.md` |
| Evidence | `SPIKE-FINDINGS-2026-08-21-connect.md`; gated claims ledger; executed local validation at commit `a68bc446d` |

## 📝 TLDR

Add the `connect` package, its Case aggregate, encrypted contact identities, lifecycle rules, and idempotent inbound e-mail ingestion. Every shared channel has one owning organization; an inbound event opens exactly one organization-scoped Case or attaches to a qualifying Case in that organization. Auto-responder and bounce traffic is suppressed by a real `(organization, channel, sender-hash)` window. This spec deliberately stops before agent UI, outbound sending, customer projection, and reporting.

## 📝 Problem Statement

`communication_channels` stores transport conversations. Connect needs a separate Case aggregate with ownership and lifecycle semantics. Earlier Connect specs repeatedly prescribed values that the inbound event never publishes; the vertical spike also proved that nullable-organization Cases are a CRUD visibility black hole. The owner has therefore required every shared channel and resulting Case to belong to one organization.

## 📝 Proposed Solution

Create an organization-scoped `connect_case` aggregate and consume `communication_channels.message.received`. Key the peer binding from the event's `conversationId`; that value is the hub-owned `ExternalConversation.id` and is persisted locally as `external_conversation_id`. Read bounded sender/subject/classification metadata through the separately approved source-owned inbound-envelope contract keyed by the event IDs; the frozen event remains free of raw PII. The source channel's non-null `organization_id` is copied to every Connect row and is an authorization predicate. This capability exposes ingestion settings only; manual Case CRUD, search, and agent-facing discovery belong to Inbox Operations.

Alternatives rejected:

- Tenant-wide or nullable-organization Cases: rejected because they violate the repository organization boundary and the spike proved ordinary CRUD cannot safely expose them.
- Query-index CRUD for the reproduced Connect route: preserved spike evidence showed its generated import could not be resolved by the current OpenAPI bundler. The later Inbox list uses the directly verified non-core ORM precedent; this does not claim every non-core indexer configuration fails.
- Read-then-create idempotency: races; the database unique constraint must arbitrate.
- Tenant-wide suppression buckets: one looping sender would suppress unrelated customers.

## 📝 Requirements and Invariants

- **FDN-FR-001** One inbound event creates exactly one Case or attaches to exactly one qualifying Case.
- **FDN-FR-002** The receipt is claimed before any non-idempotent classification or counter. Duplicate delivery is resolved by a unique insert, caught unique violation, and lookup of the winner; no read-before-create arbitration.
- **FDN-FR-003** Every row carries non-null tenant and organization scope copied from the owning channel; every query, command, event, unique key, and candidate predicate enforces both.
- **FDN-FR-004** An unresolved identity never cross-attaches. It opens a distinct Case for its external conversation.
- **FDN-FR-005** A linked identity may attach only to a non-closed Case in the same tenant, organization, and customer when the attach or reopen window permits it.
- **FDN-FR-006** Auto-responder, bounce, and loop traffic neither opens a Case nor triggers acknowledgement.
- **FDN-FR-007** Suppression is keyed by `(tenant_id, organization_id, channel_id, from_handle_hash)` with a configurable count and window, and each increment is idempotent by external message ID; there is no organization- or tenant-wide fallback.
- **FDN-FR-008** Handle values are encrypted at rest and equality-matched through a hash written even when encryption is disabled. Search documents exclude the decrypted handle value.
- **FDN-FR-009** Generic CRUD cannot change status, assignee, resolved time, or closed time. Named commands own lifecycle transitions.
- **FDN-FR-010** Every new user-editable entity has `updated_at`, API `updatedAt`, and optimistic-lock coverage.
- **FDN-FR-011** Cross-tenant identifiers return 404 on every route and command.

Invariant writers:

| Invariant | Writer and transaction | Peer absent/failure behavior |
|---|---|---|
| One Case decision per inbound | `ingest-message-received` claims the receipt, then locks the identity's active-Case binding before classification/selection and writes Case/conversation history | Subscriber retries; unique receipt prevents duplicate counters or Cases |
| Identity hash always present | identity creation/update service writes hash beside encrypted value | Reject write; never store a lookup-invisible identity |
| Legal lifecycle only | domain transition function writes Case and transition audit together | Reject with field error; no partial transition |
| Suppression isolation | rate limiter increments the composite-key counter atomically | Fail closed for acknowledgement only; log and continue storing a legitimate inbound rather than suppressing tenant-wide |

## 📝 Architecture

```
communication_channels.message.received
  -> connect subscriber
     -> insert receipt (unique external message key)
     -> classify suppression with receipt-keyed counter
     -> resolve/create encrypted identity
     -> lock active identity binding; deterministically attach or create Case
     -> update conversation current-Case binding and append binding history
```

`connect` does not import peer ORM entities, query peer tables, or resolve entity registrations to query them. The auto-discovered persistent subscriber is always registered and checks a versioned activation/capability service before work. Before any Connect-managed channel exists, unavailable prerequisites keep it inert. After Contract E enables one, a prerequisite/DI/scheduler outage is retryable: the handler fails delivery without acknowledging the persistent source event until it can read Contract D and durably claim the scoped receipt. Once Contract D confirms event-time `connect_managed+enabled`, receipt claim commits before acknowledgement and recovery processes deferred receipts idempotently. It consumes the frozen event plus the narrow source-owned inbound-envelope facade; it does not assume sender/header/body fields exist on the event.

Every event additionally requires Contract D's immutable event-time `connect_managed+enabled` result before Connect claims a receipt. Legacy/disabled results create no Connect receipt, identity, conversation, or Case and only increment a bounded non-PII integration-health counter; reprovisioning never reclassifies an older event.

Ingest is one atomic activation: setup records compatible Contract D/E DI versions in the activation service. Missing/incompatible prerequisites keep the always-registered handler inert with an operator-visible configuration error; partial Foundation deployment is never advertised as active.

### Attach rule

An inbound serializes on the tenant+organization+identity active-binding row. It considers the bound Case first, then eligible legacy candidates in the same tenant+organization+customer ordered by `last_inbound_at DESC, id ASC`. It attaches only when identity is linked, status is not `closed`, and the attach/reopen window permits. Otherwise it opens a new Case and changes the active binding. A closed Case is terminal; later inbound creates a successor with `previous_case_id` and preserves conversation history.

### Lifecycle

Legal states are `new`, `in_progress`, `waiting_customer`, `resolved`, and `closed`. Foundation implements and tests the pure transition function; Inbox commands become its external writers. Inbound moves `waiting_customer -> in_progress`, and may reopen `resolved -> in_progress`. `reopen_window_days <= auto_close_after_days` is validated.

## 📝 Data Model

All entities use UUID primary keys, `tenant_id`, timestamps, soft deletion where applicable, and no cross-module ORM relationships.

- `connect_case`: number, encrypted subject plus optional source-minimized non-PII display label, priority, status, nullable assignee/customer IDs, non-null organization/channel, inbound/lifecycle timestamps, encrypted wrap-up, `previous_case_id`, version timestamp. Subject/wrap-up are excluded from search, logs, and analytics and follow retention erasure.
- `connect_conversation`: one row per hub conversation with unique `(tenant_id, organization_id, external_conversation_id)`, mutable `current_case_id`, last external message ID/timestamp, and latest source-issued opaque reply-target reference+masked label with exact validated message/external-message provenance and version. Ingest serializes the row; only a newer accepted inbound for that conversation replaces the target.
- `connect_conversation_case_binding`: append-only conversation-to-Case intervals (`bound_at`, nullable `unbound_at`, reason) preserving successor lineage.
- `connect_contact_identity`: handle type, encrypted handle value, handle hash, link state, customer kind/id, confidence, match method, channel ID.
- `connect_identity_case_binding`: tenant-scoped identity-to-current-Case provenance and version; the shared serialization point for ingest/link/unlink/resolve.
- `connect_case_transition`: Case ID, actor ID/kind, from/to state, payload, timestamp.
- `connect_inbound_receipt`: channel/external message/event IDs, immutable `claim_cohort_utc_date`, nullable Case ID, status (`processing|completed`), terminal disposition (`opened|attached|suppressed|dead_lettered`), terminal reason, lease/attempt timestamps; unique `(tenant_id, organization_id, channel_id, external_message_id)`. Processing has no disposition/Case; completed opened/attached require Case; suppressed/dead-lettered require null Case. Winner lookup/counter idempotency uses the identical scope.
- `connect_settings`: attach/reopen/auto-close windows, per-handle match thresholds, suppression count/window.
- `connect_domain_outbox`: source event ID, aggregate ID/version, event type/payload, publish status/lease; inserted with Connect domain mutations and drained idempotently.

Migration generation uses `corepack yarn db:generate` against a scratch database. Keep only Connect SQL and the affected snapshot; do not run `db:migrate`.

## 📝 API Contracts

- `GET/PUT /api/connect/settings`: guarded, optimistic-locked settings access.
- `POST /api/connect/inbound-receipts/{id}/replay|acknowledge`: organization-scoped guarded dead-letter command. Replay is eligible only after remediable reason validation and reuses the same receipt/idempotency scope; acknowledge records actor/reason without deleting evidence.
- Domain commands are internal in this spec: inbound attach/reopen and transition validation. Inbox adds Case reads and authenticated action routes.

Settings are API-only in this capability and use conservative seeded defaults. Validation returns field errors for thresholds and `reopen_window_days <= auto_close_after_days`; an administrator settings UI is deferred to its own experience scope.

All mutating non-CRUD handlers collect registered guards, append `bridgeLegacyGuard(container)`, run `runMutationGuards` with `userFeatures`, use `modifiedPayload`, and run/log `afterSuccessCallbacks`. Cross-tenant references are indistinguishable from missing records.

## 📝 Edge Cases & Failure Scenarios

- Duplicate events racing: one insert wins; losers resolve the receipt and return success.
- Identity collision: scoped unique hash constraint wins; retry reads and locks the tenant-scoped identity/binding.
- Missing/mismatched channel organization: reject and dead-letter as channel misconfiguration; never create an unscoped Case or fall back to tenant scope.
- Suppression cache unavailable: never replace with a broader bucket. Do not auto-ack; store legitimate inbound once and emit an operational warning.
- Illegal status transition or stale version: 400 field error or standard 409 conflict; no audit row on failure.
- Peer event payload lacks `conversationId`: reject and retry/dead-letter; never substitute the command return field `externalConversationId` or invent a thread identifier.

## 📝 Risks & Impact Review

| Risk | Severity | Mitigation | Residual risk |
|---|---|---|---|
| Cross-tenant attachment | Critical | Tenant in every candidate predicate; hard isolation tests | Application bugs remain review-gated |
| Auto-responder loop | Critical | Composite rate limit, classifier, no broad fallback | Provider headers may be incomplete |
| Decrypted handle leakage | High | Hash lookup, encrypted storage, search exclusion | Authorized UI may display values later |
| Silent omission from platform guards | High | Widen curated guard scan/maps for `packages/connect` | Future guard additions need package coverage |

Rollback disables the module/subscriber first, then leaves additive tables intact. No peer contract changes are required by this spec.

## 📝 Migration & Backward Compatibility

New module IDs, entity IDs, API URLs, ACL IDs, event IDs, and DI keys are additive and become protected surfaces once released. The plan does not remove or narrow an existing contract. Changes outside `packages/connect` are additive registration/template/guard coverage and ship in the Connect PR with their Gate 2 classification.

## 📋 Phasing

1. Package and data foundation.
2. Inbound classification, idempotency, identity resolution, and attach logic.
3. Settings surface and isolated integration verification.

## 📋 Implementation Plan

- **FDN-SET-01** `packages/connect/{package.json,tsconfig.json,jest.config.cjs,src/index.ts}` — scaffold the workspace package using the executed spike path.
- **FDN-SET-02** Register root workspace/package graph, app module registry, create-app template mirror, TS/Jest mappings, generator discovery, and package guard scans; run template sync, `corepack yarn generate`, package builds, and focused guard tests.
- **FDN-SET-03** Before Foundation activation, remove/disable the executed spike's generated `api/cases/route.ts` (`orgField:null`, manual CRUD); Foundation exposes no Case CRUD route until Inbox supplies its exact guarded contract. Migrate existing nullable-organization/plaintext-subject spike rows by requiring an owning channel organization and encrypting subject; quarantine rows that cannot be deterministically scoped. Test every old Case method is unreachable and no null-org/plaintext row remains active.
- **FDN-DATA-01** `packages/connect/src/modules/connect/data/entities.ts` — Case, conversation, identity, transition, receipt, and settings entities with optimistic locking.
- **FDN-DATA-02** `data/validators.ts`, `data/encryption.ts`, `data/extensions.ts` — schemas, hash/encryption hooks, and links without ORM relations.
- **FDN-DATA-03** Generate Connect-only migration and snapshot update; do not migrate locally.
- **FDN-DOM-01** `lib/case-lifecycle.ts` and tests — legal transitions, attach predicate, ordering validation.
- **FDN-ING-01** `subscribers/message-received.ts` + `commands/ingest-inbound-message.ts` — unique-insert idempotency, Case decision transaction, and atomic per-conversation reply-target/provenance update from Contract D.
- **FDN-EVT-01** `events.ts`, `lib/domain-outbox.ts`, `workers/publish-domain-outbox.ts` — durable post-commit events including `connect.inbound.claimed`, `.disposed`, and `connect.contact_identity.unresolved`. The unresolved event is inserted atomically when an identity enters unresolved state and carries stable source event ID, tenantId, organizationId, identityId, identityVersion/status, and occurredAt; collisions reuse the winning identity/source ID.
- **FDN-EVT-02** Register queue `connect.domain_outbox.publish` with an after-commit best-effort wake job plus per-organization scheduler entry `connect:{organizationId}:domain-outbox-sweep` from `setup.seedDefaults` through optional `schedulerService`, targeting the same queue at a documented bounded interval. Activation remains disabled and health reports `scheduler_unavailable` when the service cannot register. The worker uses bounded batches, leased claims, and idempotent event IDs; test stable re-registration, scheduler absence, commit-before-enqueue crash, worker crash after publish, duplicate wake jobs, lease expiry, and scheduled recovery.
- **FDN-ING-02** `lib/inbound-classifier.ts` + tests — bounce/auto-responder classification.
- **FDN-ING-03** `lib/inbound-rate-limiter.ts` + tests — composite key, configured window, no tenant fallback.
- **FDN-ING-04** `lib/identity-resolver.ts` + tests — thresholds, unresolved behavior, encrypted/hash persistence.
- **FDN-ING-05** Register per-organization schedule `connect:{organizationId}:inbound-receipt-sweep` targeting `connect.inbound.receipts`; activation health detects scheduler/subscriber/version outages. Persistent source delivery is never acknowledged during a post-enable prerequisite outage; after Contract D confirmation the durable receipt is claimed before acknowledgement, then unprocessed receipts retry with bounded leases, dead-letter exhausted work, and replay resumes after recovery. Test outage between channel enable/event delivery/receipt claim, stable registration, scheduler absence, inactive-to-active recovery, commit-before-enqueue, and crash boundaries.
- **FDN-API-01** `api/settings/route.ts`, `api/openapi.ts` — ingestion settings route and per-method metadata.
- **FDN-API-02** `api/inbound-receipts/[id]/{replay,acknowledge}/route.ts` — guarded dead-letter remediation, audit, optimistic conflict, and integration/browser acceptance.
- **FDN-ACL-01** `acl.ts`, `setup.ts`, `i18n/{en,pl,es,de,ko}.json` — features, defaults, complete locales.
- **FDN-GUARD-01** Widen optimistic-lock/package scan coverage required by the Foundation entities; record each external file in Gate 2. Inbox owns later global-search guard coverage.
- **FDN-TEST-01** Unit tests for lifecycle, hashing, classification, suppression, and idempotency race.
- **FDN-TEST-02** Self-contained integration: inbound opens once; duplicate does not duplicate; linked attach; unresolved isolation; cross-tenant and cross-organization 404; missing-org channel dead-letter; legacy/disabled channel events create no Connect rows; a post-enable activation outage retries source delivery and converges to one receipt/Case after recovery; suppression pair does not suppress another sender or organization.

## 📝 Final Compliance Report

- Scope is one deployable capability: the minimum package/data/settings foundation required to run inbound ingestion.
- Every requirement names a concrete writer or test task.
- No direct cross-module ORM relation or peer-table query.
- Tenant isolation, optimistic locking, mutation guards, encryption, i18n, and search leakage are explicit gates.
- Full validation uses local Node 24 with the runner recorded in the handoff.

## Changelog

- 2026-08-21: Successor drafted from the executed vertical spike; corrected tenancy, event-key, CRUD/OpenAPI, and suppression mechanisms.

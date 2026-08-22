# Mercato Connect — Customer Identity and Timeline Projection

| Field | Value |
|---|---|
| Date | 2026-08-21 |
| Status | Proposed; blocked on the separately specified expanded upstream PR B |
| Scope | Manual identity matching, Customer 360 projection, and full unlink retraction |
| Depends on | Connect Foundation; Inbox resolve action; Upstream Customer Interaction Retraction |

## 📝 TLDR

Link Connect identities to person/company customers, project resolved Cases to the Customer 360 timeline, and make incorrect links truly reversible. Unlink clears every affected Case association and tombstones each projected `CustomerInteraction` through an expanded source-owned customers contract while preserving immutable audit evidence.

## 📝 Problem Statement

An identity link can expose another customer's orders and timeline. Earlier designs changed only the identity row on unlink, leaving already-associated Cases and timeline interactions exposed. Blocking unlink would preserve safety at the cost of reversibility; the owner chose full retraction through an upstream contract.

## 📝 Proposed Solution

Treat identity link/unlink as audited, guarded workflows rather than scalar edits. The current source-owned create contract accepts caller-supplied IDs but flushes duplicates without recovery; separately specified PR B therefore adds scoped duplicate-key reconciliation and idempotent tombstoning. Connect never imports `CustomerInteraction` or writes customer tables directly. Linking and projection remain feature-disabled until retraction is deployed and verified, so the product can never create an association it cannot safely undo.

## 📝 Requirements and Invariants

- **PROJ-FR-001** Linking requires an authorized user, explicit customer kind/id, and tenant-safe customer validation; cross-tenant/cross-customer references return 404.
- **PROJ-FR-002** Link writes identity state, immutable link audit, and closes the manual-match task in one Connect transaction.
- **PROJ-FR-003** Every resolve atomically inserts one deterministic `connect.case.resolved` domain-outbox intent; the Projection subscriber idempotently materializes one pending projection row. Linked work drains after materialization and unresolved work waits for a valid link.
- **PROJ-FR-004** A crash after resolve cannot lose the outbox intent; subscriber reconciliation/backfill materializes any missing pending row before upstream creation.
- **PROJ-FR-005** Customer candidates and projections must belong to the Case organization; cross-organization customer references return 404 and are never linked or staged.
- **PROJ-FR-006** Unlink clears `customer_entity_id` from the identity and every Case attached through that identity, writes immutable audits/transitions, reopens a manual-match task, and stages retraction work atomically in Connect.
- **PROJ-FR-007** Every previously created interaction first enters a source-owned `retraction_pending` state hidden from ordinary Customer timelines, then is finalized as tombstoned through PR B. Connect does not clear its local association until the source confirms the pending-hidden token.
- **PROJ-FR-008** Retraction is idempotent and retryable; no hard delete destroys audit history.

Invariant writers:

| Invariant | Writer | Failure behavior |
|---|---|---|
| One projection per Case | deterministic projection ID + PR B's scoped duplicate-key reconciliation | 23505 is success only after the existing winner is tenant/customer-validated |
| No active exposure after unlink | PR B synchronously marks owned interactions pending-hidden, then Connect clears associations and stages finalize jobs | Neither Connect nor Customer timeline exposes the old association after local commit |
| Audit survives reversals | append-only link audit and Case transition | Never overwrite prior customer ID/history |

## 📝 Architecture

```
manual match/link -> Connect transaction -> projection drain -> customers facade (PR B)
unlink -> commit saga intent -> begin-hide in Customers -> commit local clear/decision
       -> finalize hidden interactions as tombstoned
```

PR B is specified by `2026-08-21-connect-upstream-customer-interaction-contract.md` and owns authorization/storage semantics for interaction creation plus pending-hidden/final tombstone states. This spec consumes but does not implement that peer capability. Existing declared Customer detail spots and DataTable injection are reused; no new host address is required. `connect` supplies deterministic source keys and scoped plain inputs. Direct ORM relations, raw SQL, or imported customer entities are forbidden.

Contract E marks every participating channel `connect_managed`; the legacy Customers inbound/outbound projection subscribers skip that mode. Therefore PR B is the only Customer timeline writer for Connect traffic, and the unlink inventory cannot be bypassed by a parallel legacy projection.

Inbox resolve inserts `connect.case.resolved` into the Foundation domain outbox in the same Case transaction. Projection's persistent subscriber idempotently upserts the pending row; activation and scheduled reconciliation backfill any resolved Case without one, so subscriber outages cannot lose work.

### Deterministic identity

Projection ID derives from the stable Connect Case ID and projection version, not retry time. Retraction references that ID. Relinking to another customer creates a new versioned projection ID after the old one is tombstoned, preserving the audit chain without reviving old content.

### Unlink ordering

1. Acquire the shared identity/binding lock, validate scope/state/source ownership, set durable `unlink_pending_saga_id` on the identity/binding, and commit the saga intent with stable ID/epoch/complete inventory before peer mutation. Projection creation first reserves its deterministic source key and association epoch durably under this same lock before the peer call; unlink includes every reservation or waits/aborts it. Every ingest/link/resolve/projection writer checks this fence under the same lock and rejects or waits, so no admitted peer create can fall outside an undecided inventory.
2. Call idempotent PR B `beginRetractionSaga(sagaId, epoch, completeInventory)` once. Customers validates and hides the whole inventory in one source transaction or hides none, journals tokens, and exposes `listRetractions(sagaId, epoch)` with the complete saga status/inventory result; partial user-visible hide is impossible.
3. After the whole inventory is pending-hidden, reacquire the shared lock, verify fence+saga epoch and revalidate inventory/version unchanged, then append audit, clear associations/bindings/fence, create transitions/manual-match task, and record monotonic `commit` plus finalize jobs.
4. Publish `commitRetractionSaga(sagaId, epoch)` to Customers; only committed source sagas may finalize. Neither UI exposes the old association.
5. If local mutation cannot commit, record monotonic `abort`, call source abort, then reacquire the identity lock and clear only the matching saga+epoch fence after abort confirmation. Recovery performs the same idempotently and never clears a newer fence.
6. Recovery reads both saga ledgers and converges an undecided saga; it never guesses from a lost acknowledgement.

## 📝 Data Model

- `connect_identity_link_audit`: identity, action, actor, from/to customer kind/id, reason, timestamp; append-only.
- `connect_manual_match_task`: identity, status, resolution, timestamps, optimistic version. Phase 1 has no task assignee; the organization queue is oldest-first with status/kind filters.
- `connect_pending_projection`: Case, identity, target customer snapshot, deterministic projection ID/version, status/error/timestamps.
- `connect_pending_retraction`: Case, identity, former customer snapshot, projection ID, status/error/attempt timestamps.
- `connect_retraction_saga`: identity, epoch, complete source-key inventory, peer tokens/status, monotonic decision (`undecided|commit|abort`), recovery lease/timestamps.
- Case and identity active customer fields are nullable and cleared on unlink; historical values live only in audit/transition rows.

Link/unlink `reason` is encrypted with the Connect module encryption hook. Customer references store only opaque kind/UUID pairs, not copied names, e-mail addresses, or phone numbers. No search document indexes encrypted handles, reasons, or wrap-up text.

## 📝 API Contracts

Immutable features are `connect.customer_match.read`, `.link`, `.unlink`, `.recover`, and `.audit`. Default handlers receive read/link only; organization managers receive unlink/recover; restricted auditors receive audit without mutation. Candidate search and queue require `.read`, link requires `.link`, unlink requires `.unlink`, saga status/retry requires `.recover`, and historical audit requires `.audit`; every server command rechecks organization membership and wildcard features, and no role may self-escalate.

- `GET /api/connect/manual-matches`: tenant-and-organization-scoped workable queue.
- `POST /api/connect/contact-identities/{id}/link`: guarded link with customer kind/id and optimistic lock.
- `POST /api/connect/contact-identities/{id}/unlink`: guarded full-retraction workflow with reason and optimistic lock.
- `GET /api/connect/cases/{id}/customer-context`: only current active association; never serves audit-only prior customer data.
- `GET /api/connect/customer-context?kind&id` and batched `POST /api/connect/customer-context/query` (<=100 refs): guarded tenant+organization+customer-reference validation returning `{ kind, id, openCaseCount, lastCaseAt?, lastCaseStatus? }` only; list enrichers use the batch route to avoid N+1 and foreign/missing refs contribute nothing.
- `GET /api/connect/contact-identities/{id}/unlink-status`: resumable saga status (`pending_hide|committing|finalizing|aborted|completed`) with safe retry guidance.

Candidate discovery reuses the authorized `/api/customers/people` and `/api/customers/companies` list APIs through `apiCall`, with debounced query, kind tabs, page size <=100, and server scope. Results show only name, masked primary contact, and kind; the guarded link command revalidates the selected UUID. Empty, ambiguous, loading, error, and many-result states are explicit. Confidence/match method are explanatory evidence, never authorization.

The guarded link command revalidates with PR B `resolveCustomerReference({ tenantId, organizationId, kind, id, trustedActor })` before writing any link audit, association, task, or projection row. A missing result produces the same 404 for stale, forged, deleted, wrong-kind, sibling-organization, and foreign-tenant IDs.

PR B DI contract:

- `createInteraction(input)` retains current additive source-owned semantics and accepts caller-supplied deterministic ID.
- `beginRetractionSaga(input)` requires trusted service/actor, tenant+organization, feature, saga ID/epoch, and complete immutable source-key inventory; one source transaction hides all or none and journals tokens.
- `listRetractions`, `commitRetractionSaga`, `abortRetractionSaga`, and finalize revalidate trusted service/actor, tenant+organization, source namespace, saga ID/epoch, and monotonic state. Tokens are never bearer authority. Cross-scope/source mismatches are indistinguishable from missing.

## 📝 UI/UX

- Manual-match screen shows identity type and masked handle, paged people/company candidate search, match confidence/method, and explicit confirmation.
- Unlink confirmation states that customer context and timeline projection will be removed; reason is required.
- Immediately after unlink, old customer orders/timeline context disappears even if the upstream drain is pending.
- Retraction failures show an admin-operational state, not stale customer data to agents.
- While unlink is undecided, link/resolve controls are disabled and UI shows resumable progress. Timeout/lost response polls status; reload resumes. Cancel is available only before source begin, while later abort is coordinator-controlled. Browser tests cover timeout, eventual commit, and abort restoration.
- All writes use guarded mutations, own-row optimistic versions, shared dialogs, translated strings, and DS tokens.
- Manual matching supports keyboard-only kind-tab → search → select → confirm, restores focus on cancel/conflict, announces result counts/errors/masked values, and has browser acceptance for optimistic-conflict recovery.

## 📝 Edge Cases & Failure Scenarios

- Link races with another link: optimistic conflict; no second audit/projection.
- Unlink races with resolve: row locks and versions serialize; resolve cannot project after active association is cleared.
- Upstream create succeeds but local acknowledgement fails: deterministic retry accepts a duplicate only when tenant, customer, source namespace/key, and immutable payload match exactly.
- Finalize worker fails: source interaction remains pending-hidden; job retries with bounded backoff and operational alert.
- Relink before old tombstone completes: new projection waits until old retraction reaches terminal success.
- Customer deleted upstream: link returns 404; retraction of an absent interaction is idempotent success.

## 📝 Risks & Impact Review

| Risk | Severity | Mitigation | Residual risk |
|---|---|---|---|
| Wrong-customer disclosure after unlink | Critical | Immediate local clear + source-owned tombstone + isolation tests | Drain latency leaves tombstoned upstream work pending, never shown by Connect |
| Cross-module partial success | High | Deterministic IDs and durable outbox jobs | Eventual consistency is visible operationally |
| Audit leaks prior customer | High | Restricted audit ACL, no agent context enrichment from audit rows | Privileged auditors retain legitimate access |

Rollback disables new linking first, drains or freezes pending jobs, and never restores cleared associations automatically. PR B is additive; its facade remains available if Connect is disabled.

## 📝 Migration & Backward Compatibility

PR B adds DI lifecycle operations and additive storage fields; it does not mutate the `CustomerInteraction.entity` relation or existing API shapes. The new lifecycle DI key/semantics are STABLE after release and documented in the customers module contract table. Connect reuses the existing FROZEN `detail:customers.person:footer`, `detail:customers.company:footer`, and applicable DataTable host contracts without changing their context. Connect projection/retraction events and command IDs are frozen once published. PR B lands separately before this spec's Connect implementation.

## 📋 Phasing

1. Verify the separately released PR B lifecycle contract and existing host compatibility.
2. Build manual match, link/projection, unlink/retraction, and retry drains behind a disabled feature gate.
3. Build customer-context widgets and end-to-end isolation verification.
4. Enable linking/projection only after unlink retraction passes integration and failure-recovery tests.

## 📋 Implementation Plan

- **PROJ-DATA-01** Connect audit, manual-match, pending projection/retraction, and `connect_retraction_saga` entities plus migration. The saga stores tenant+organization scope, identity, monotonic epoch, precommitted projection inventory, phase, lease/attempt timestamps, last error, and source acknowledgements; the identity row stores `unlink_pending_saga_id` plus epoch. Add uniqueness/claim/recovery indexes and clear only a matching saga fence on commit or abort.
- **PROJ-ING-01** Persistent `connect.contact_identity.unresolved` subscriber plus activation/reconciliation backfill, ensuring one open manual-match task per currently unresolved identity. It keys idempotency by stable source event/identity, re-reads the scoped current identity version before upsert, ignores a stale event when the identity resolved before delivery, and closes/supersedes work on later resolution.
- **PROJ-ING-02** `connect.case.resolved` subscriber plus reconciliation backfill, idempotently upserting pending projection rows.
- **PROJ-CMD-01** guarded link command using PR B `resolveCustomerReference` before any Connect mutation, followed by atomic link audit/task close and drain staging.
- **PROJ-CMD-02** guarded saga coordinator using precommitted inventory, shared identity lock, source begin/list, fenced commit/abort, local clear, and finalize jobs.
- **PROJ-WRK-01** Register queue `connect.projection.drain` and a best-effort after-commit wake plus stable per-organization schedule `connect:{organizationId}:projection-drain-sweep` through optional `schedulerService`. The leased bounded worker idempotently drains ordinary pending projections, durably reserves its deterministic source key/retraction group under the identity lock before the peer call, and handles deterministic IDs/23505 plus reservation recovery. Projection activation requires both drain and saga-recovery schedules; test scheduler absence, commit-before-enqueue, duplicate wake, worker crash/lease expiry, and scheduled recovery.
- **PROJ-WRK-02** idempotent retraction worker with bounded retry and alert state.
- **PROJ-WRK-03** Saga recovery worker on queue `connect.projection.recovery`; `setup.seedDefaults` registers stable per-organization schedule `connect:{organizationId}:projection-recovery-sweep` through optional `schedulerService` at a documented bounded interval and keeps Projection disabled if unavailable. The worker resumes lost begin/commit/abort acknowledgements, re-reads source status under the identity lock, rejects stale epoch/lease owners, reconciles inventory drift, and safely completes or aborts after coordinator crashes; test stable registration, scheduler absence, commit-before-enqueue and scheduled recovery.
- **PROJ-EVT-01** Add Projection-owned domain-outbox writes/tests for `connect.projection.status_changed` at create/retraction transitions.
- **PROJ-API-01** Link/unlink/manual-match, Case-oriented context, and guarded customer-keyed single/batch context routes with per-method metadata, bounded aggregation, <=100 references, and 404/no-contribution isolation.
- **PROJ-ACL-01** Define immutable feature IDs/default grants and server guards for queue/candidate read, link, unlink, saga recovery, and restricted audit; test handler/manager/auditor/ordinary-viewer denials, wildcard grants, self-escalation denial, and cross-organization 404.
- **PROJ-UI-01** manual-match workflow, unlink confirmation, pending/failure admin state, complete locales.
- **PROJ-WID-01** Add response enrichers for customer person/company list/detail entities exposing the exact customer-keyed `connectContext` projection through the bounded batch/single routes; render columns in DataTable hosts `customers.people.list` and `customers.companies.list`, and detail widgets at `detail:customers.person:footer` and `detail:customers.company:footer` using the `customers.detail.v1` context (`recordId`, tenant/organization scope, retry hook). Name the widget/enricher files in `widgets.ts`/`data/enrichers.ts`; contribute nothing for missing/foreign scope and test batching/no-N+1, both hosts, both footers, no-contribution, and cross-organization isolation.
- **PROJ-TEST-01** Integration: new unresolved identity event opens one task; duplicate/reordered delivery, resolve-before-delivery, subscriber outage and activation backfill converge correctly; linked resolve projects once; unresolved stages then drains; wrong-kind, deleted, stale, cross-tenant, and cross-organization customer selection returns 404 before any link/audit/task/projection mutation.
- **PROJ-TEST-02** Integration: unlink clears identity and all Cases immediately; tombstones every projection; retry idempotency; relink ordering; a projection reserved before unlink but created upstream after fence acquisition; lost begin/commit/abort acknowledgements; stale epoch and expired lease; source inventory drift; crash at each durable phase; and matching-only saga-fence clearing on commit/abort.
- **PROJ-TEST-03** Hard isolation: wrong-tenant and wrong-customer IDs return 404 and never leak context in API/widget responses.
- **PROJ-TEST-04** Browser: accessible manual search/select/confirm, masking announcements, empty/error/pagination, focus restoration, and conflict recovery.

## 📝 Final Compliance Report

- Unlink is reversible in product behavior and auditable in storage.
- Link/projection cannot be enabled before the retraction path is deployable and verified.
- Peer mutation stays behind a source-owned additive contract.
- Cross-module partial success has a durable, idempotent recovery path.
- Customer context never reads historical audit association as active.

## Changelog

- 2026-08-21: Successor split from v2; expanded unlink to full Case and timeline retraction through PR B.

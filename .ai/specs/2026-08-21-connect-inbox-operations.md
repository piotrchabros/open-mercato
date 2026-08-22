# Mercato Connect — Inbox Operations

| Field | Value |
|---|---|
| Date | 2026-08-21 |
| Status | Proposed; blocked on the separately specified PR A and PR C contracts |
| Scope | Agent inbox, assignment, lifecycle actions, thread reading, asynchronous replies |
| Depends on | Connect Foundation and Inbound Ingest; Upstream Contract A (shared send); Upstream Contract C (thread reader) |
| Enables | Customer Projection and Operational Metrics |

## 📝 TLDR

Ship the three-pane Connect Inbox where agents can see unassigned or owned Cases, claim or assign them through one guarded command, read the bound transport thread, reply asynchronously, and resolve/close/reopen Cases. Provider timeouts after dispatch become `unknown`, are reconciled without automatic resend, and require an explicit operator retry only after a terminal failure.

## 📝 Problem Statement

The earlier design filtered ordinary agents to their own Cases while providing no way to assign an unassigned Case, producing an empty Inbox. It also claimed asynchronous send without a send worker and treated indeterminate provider outcomes as retryable failures, risking duplicate customer replies. Thread rendering requires a narrowly authorized peer reader because inbound messages are system-authored and outside the existing participant predicate.

## 📝 Proposed Solution

Add a custom composite Inbox and named guarded commands. One `/assign` command supports self-claim and privileged assignment: agents with `connect.inbox.handle` may assign an unassigned Case to themselves; `connect.cases.assign` may select another active tenant user or unassign. Connect durably submits one logical attempt to the hub; the hub's existing delivery worker calls the provider and PR A publishes correlated outcome evidence. A provider-dispatch timeout is `unknown`, reconciliation decides `sent` or `failed`, and unknown rows are never auto-resent. Inbox navigation stays disabled until assignment, thread reading, lifecycle actions, outbound delivery, and the required PR A/PR C versions are all present; its internal build phases are not separately released.

Official shared-inbox APIs reinforce two choices without being copied wholesale: [Intercom models assignment as an explicit conversation action and permits an unassigned state](https://developers.intercom.com/docs/references/2.2/rest-api/conversations/assign-a-conversation), while [Zendesk exposes one assignee per ticket and dedicated assigned-ticket views](https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/). Connect keeps one assignee and a named audit-producing command, but defers teams and routing rules.

## 📝 Requirements and Invariants

- **INB-FR-001** Agents see unassigned Cases plus their own Cases in the active organization; `connect.cases.view.all` sees all Cases in that organization, never sibling organizations.
- **INB-FR-002** One assign command supports self-claim, privileged assignment, transfer, and unassign with explicit ACL rules and an audit transition.
- **INB-FR-003** The Inbox reads messages only through PR C using `externalConversationId`s loaded from tenant-and-organization-scoped Connect rows.
- **INB-FR-004** PR C is class (e), requires maintainer sign-off, and enforces tenant plus caller-supplied conversation allowlist; it is not a general message reader.
- **INB-FR-004A** Thread access is Case-authorized before PR C: active handlers may read unassigned or self-assigned Cases, not another handler's Case; managers with all-Cases feature may read any organization Case. Direct URLs and every cursor continuation recheck the current Case assignment/access epoch; denied or transferred-away Cases return indistinguishable 404 and the already-open UI becomes read-only without retaining thread content.
- **INB-FR-005** Replies require a client command key unique within tenant+Case. The logical message, first attempt, and transactional outbox row commit together; duplicate requests return the existing logical message and never enqueue twice.
- **INB-FR-005A** Reply destination is the source-issued opaque `replyTargetRef` stored on a Case-bound conversation and revalidated by Contract D at enqueue and dispatch. The send command requires `conversationId`, locks the Case+conversation, verifies current binding/scope and uses that conversation's latest replyable inbound provenance. Connect persists the reference and masked label, never a caller-selected address; ambiguous/stale targets fail before outbox creation.
- **INB-FR-006** Delivery states are `queued|sending|unknown|sent|failed`. A dispatch timeout writes `unknown`; no automatic resend is legal from `sending` or `unknown`.
- **INB-FR-007** Reconciliation is idempotent. `sent` stamps first human outbound once and may move the Case to `waiting_customer`; `failed` does neither.
- **INB-FR-008** Explicit retry is allowed only from `failed`, locks/consumes the failed attempt, creates one child attempt/idempotency key, retains the old attempt, and needs a confirmation affordance. A unique predecessor constraint prevents concurrent retry forks.
- **INB-FR-009** Resolve requires a non-empty wrap-up note. Close, reopen, resolve, assign, and send use named guarded routes; generic CRUD cannot perform them.
- **INB-FR-010** Each pane sends its own `updatedAt` optimistic-lock header and surfaces the unified conflict bar.
- **INB-FR-011** Every write uses `useGuardedMutation(...).runMutation(...)`; injection context includes `retryLastMutation`.

## 📝 Architecture

```
Inbox list/detail -> Connect APIs
thread pane -> Connect route -> communicationChannelsThreadReader (PR C)
composer -> logical message + attempt + DB outbox -> dispatcher -> PR A send facade
                                                       timeout -> unknown -> PR A reconciliation facade
```

### Upstream PR A — prerequisite only

PR A lands this cycle under `2026-08-21-connect-upstream-send-contract.md`. This Inbox spec consumes but does not implement that contract.

### Upstream PR C — prerequisite only

PR C lands under `2026-08-21-connect-upstream-thread-reader.md`. This Inbox spec consumes but does not implement that class (e) contract.

### Assignment semantics

`POST /api/connect/cases/{id}/assign` accepts `{ assigneeUserId: uuid|null }`. Self-claim is the same command with the caller's ID. A normal handler may self-claim only an unassigned Case. Privileged assigners may assign/unassign/transfer. The target must be active and authorized in the Case tenant+organization; sibling-organization, cross-tenant, and unknown targets return 404. The Case update and transition/audit row commit together.

Ordinary `connect.inbox.handle` agents may reply/resolve/reopen only their own assigned Case; unassigned Cases must be claimed first and another agent's Case is read-only. `connect.cases.assign` managers may override ownership for actions with an audit reason. Close requires `connect.cases.manage`. Every action rechecks owner/version at submit, so transfer during a draft preserves the draft but rejects send until reclaimed/reassigned.

### Lifecycle contract

| From | To | Trigger/precondition |
|---|---|---|
| `new` | `in_progress` | successful claim/assign or first manager override action |
| `new|in_progress|waiting_customer` | `resolved` | owner/manager resolve with non-empty wrap-up |
| `in_progress` | `waiting_customer` | first confirmed human outbound sent |
| `waiting_customer` | `in_progress` | inbound or owner action |
| `resolved` | `in_progress` | explicit owner/manager reopen or inbound inside `reopen_window_days` |
| `resolved` | `closed` | manage-feature close or auto-close after configured quiet window |

`closed` is terminal; later inbound opens a successor. UI shows only legal actions and translated disabled reasons; API tests cover every allowed and denied edge, ownership rule, window boundary, and close prerequisite.

### Send state machine

| From | To | Writer |
|---|---|---|
| `queued` | `sending|sent|failed|unknown` | Connect precomputes correlation, submits idempotently, then applies any already-arrived outcome |
| `sending` | `sent` | PR A correlated hub outcome confirms external message ID |
| `sending` | `failed` | PR A outcome/lookup proves definitive rejection |
| `sending` | `unknown` | PR A outcome reports timeout/connection loss after provider dispatch begins |
| `unknown` | `sent|failed` | source-owned PR A reconciliation by provider/idempotency evidence |
| `failed` | — | terminal attempt; explicit retry creates a new attempt |

Connect generates one immutable unique `hubCorrelationId` per attempt before enqueue and persists the correlation↔attempt binding with the attempt/outbox. A failed-only child retry gets a new attempt ID and new hub correlation while retaining its parent logical-message/client command key; response retry of the same attempt reuses both. PR A atomically enforces that binding and deduplicates enqueue by scoped correlation, so outcome subscribers require both matching values even before the facade returns. Consumers store the highest delivery revision and never regress or conflict with a terminal sent/failed decision. Post-return lookup closes any event-before-response race. A lease expiry never means safe-to-resend. Unsupported/inconclusive attempts remain unknown for escalation, not resend.

## 📝 Data Model

- `connect_outbound_message`: logical customer reply with tenant+organization+Case-scoped client command key, encrypted immutable send payload, payload fingerprint, opaque reply-target reference+masked label, actor, channel and created timestamp; unique `(tenant_id, organization_id, case_id, client_command_key)`. The outbox scanner can reconstruct submission after a crash; retention erases ciphertext only after policy permits and no retry/reconciliation needs it.
- `connect_case_read_state`: tenant+organization+Case+user, last-read inbound sequence/timestamp and optimistic version; unread is per user, becomes true on a newer inbound, is not transferred between assignees, and marking read is an idempotent own-user write.
- `connect_outbound_attempt`: logical message ID, predecessor attempt ID, status, attempt number, provider idempotency/message IDs, error and timing fields; unique predecessor child.
- `connect_outbox`: attempt ID, payload fingerprint, dispatch status/lease/timestamps; inserted with the logical message/attempt and scanned until correlated hub acceptance.
- `connect_assignment_audit`: Case ID, actor, from/to assignee, reason, timestamp.
- Existing Case transition rows record lifecycle effects; message bodies remain in the owning messages/hub path.

No ORM relationship crosses module boundaries.

## 📝 API Contracts

- `GET /api/connect/inbox`: paged unassigned+mine view, or all with feature; page size <=100.
- `GET/PUT /api/connect/cases`: ORM-backed tenant-and-organization-scoped Case list/detail surface; generic PUT may change only `priority` with optimistic locking. Customer/identity/channel/conversation/status/assignee/lifecycle timestamps/subject/wrap-up/reply-target provenance are forbidden and change only through named commands or ingest. Manual Case creation is deferred from Phase 1; Cases originate only from authorized inbound receipts. Cases are closed through lifecycle actions and are not generically deleted.
- `GET /api/connect/cases/{id}/thread`: facade projection, tenant and conversation allowlist enforcement.
- `POST /api/connect/cases/{id}/assign`: unified self/manager assignment.
- `POST /api/connect/cases/{id}/messages`: guarded enqueue requiring Case-bound `conversationId` and `clientCommandKey`; 202 returns the existing or new `{ messageId, attemptId, status:'queued', updatedAt }`.
- `POST /api/connect/cases/{id}/read`: idempotently advances only the authenticated user's read watermark with optimistic conflict handling.
- `POST /api/connect/cases/{id}/messages/{attemptId}/retry`: failed-only explicit retry.
- `POST /api/connect/cases/{id}/{resolve|close|reopen}`: guarded lifecycle command with optimistic lock.

Every route exports per-method `metadata`. Cross-tenant and cross-organization references return 404, not 403. Provider timeout is not returned synchronously because the API only enqueues.

## 📝 UI/UX

The Inbox is a responsive three-pane composite: Cases, selected thread, customer/context+composer. It reuses backend page scaffolding, DataTable/list states, shared buttons, banners, dialogs, conflict bar, and `apiCall` helpers. No raw `<button>`, raw `fetch`, arbitrary Tailwind values, or hardcoded status colors/strings.

- Unassigned and Mine are explicit filters; self-claim is available from list and detail.
- Assignment control shows current owner before confirmation.
- Composer shows sending channel and masked source-derived destination before submit; unavailable/ambiguous targets disable send with recovery guidance.
- Queued/sending/unknown/sent/failed are distinct accessible states. Unknown explains that delivery is being checked and disables retry.
- Failed offers explicit retry explaining that it creates a new attempt after source-proven rejection; generic duplicate-risk wording is not used.
- Poll on focus plus 30-second interval; no SSE contract in this phase.
- Dialogs support Cmd/Ctrl+Enter and Escape.

Wide screens render three panes. Narrow screens use list → thread → context/composer navigation with browser-back semantics and preserve list filters, scroll, selection, and a Case-keyed draft. Keyboard order follows list, thread, context, composer; selection and delivery updates use live announcements. Focus moves to the thread heading after selection and returns to the originating row on back.

Each pane owns loading, empty, stale, and error states. Poll failures back off, retain last-good data with a stale banner, and offer manual retry. Offline or pre-commit enqueue failure retains the draft and never shows a queued message; the draft clears only after durable 202. Default triage is unassigned+mine, non-closed, latest-inbound first, with unread state and persisted filters. If polling removes/reassigns the selected Case, detail becomes read-only with a reason and return-to-list action.

The composer generates `clientCommandKey` when a draft first becomes dirty and keeps the Case-keyed draft+key for the browser session. A timeout/lost 202 never rotates it; retry sends the identical fingerprint/key and receives the existing logical message. Confirmed 202 clears draft/key. Reload queries a retained key before enabling a new send. Browser acceptance simulates response loss and proves one message/attempt.

Before UI lands, run `om-ds-guardian` and capture browser screenshots for normal, empty, loading, error, unknown-send, conflict, and narrow viewport states.

## 📝 Edge Cases & Failure Scenarios

- Two agents self-claim: optimistic lock allows one; loser gets conflict and refreshed owner.
- Assignee deactivated between load and submit: 404/validation without mutating Case.
- PR C returns missing vs empty: missing binding is an error state; empty is a valid new thread.
- API/queue crash after commit: the DB outbox scanner dispatches the durable row; duplicate scanner claims are lease/idempotency safe.
- Worker crashes after provider acceptance: lease expiry produces `unknown`, never resend.
- Reconciliation remains inconclusive: stays unknown, warns at configured age, and creates an Inbox-owned authorized recovery-queue row plus notification even when Metrics is absent. The queue shows scope/channel/Case/attempt, evidence age and lookup support, supports refresh/acknowledge only, and deep-links to the Case; Phase 1 has no force-sent/force-failed override and retry remains disabled until source evidence is terminal.
- Provider definitive rejection: failed with safe explicit retry.
- Late `sent` after UI showed unknown: idempotent reconciliation updates once and transitions Case once.

## 📝 Risks & Impact Review

| Risk | Severity | Mitigation | Residual risk |
|---|---|---|---|
| Thread-reader boundary bypass | Critical | Class (e), source-owned checks, tenant+allowlist, human sign-off | In-process caller misuse requires review/test gates |
| Duplicate customer reply | Critical | Unknown state, no automatic resend, reconciliation | Provider with no lookup/idempotency may remain unknown |
| Empty front-line Inbox | High | Unassigned+mine predicate and unified claim | No routing automation in Phase 1 |
| Stale multi-pane writes | High | Per-pane versions and conflict bar | Poll interval allows benign staleness |

Rollback disables Inbox navigation and send worker, leaving queued/unknown attempts visible for manual reconciliation. Never delete indeterminate attempts during rollback.

## 📝 Migration & Backward Compatibility

PR A and PR C modify STABLE type/DI surfaces additively. Required fields are not removed or narrowed; new sender fields remain optional for existing callers. PR C's new reader DI key and semantics are documented in the hub AGENTS public-contract table. API, ACL, command, event, widget, and DI identifiers introduced here become protected after release. Both upstream PRs land separately before the Connect Inbox PR.

## 📋 Phasing

1. Verify separately released PR A and PR C contract versions.
2. Build assignment, lifecycle, Case CRUD/search, and thread routes behind disabled navigation.
3. Build durable outbound state machine and workers behind the same release gate.
4. Enable the DS-compliant Inbox only after end-to-end browser/integration verification of the complete vertical capability.

## 📋 Implementation Plan

- **INB-DATA-01** `data/entities.ts`, validators/encryption hooks, indexes, migration, and retention worker — logical messages with encrypted payload/fingerprint, attempts, DB outbox, assignment audit, and ciphertext erasure rules.
- **INB-DATA-02** Add per-user Case read-watermark and unknown-delivery exception entities, indexes, optimistic locking, retention/audit, and safe list projections.
- **INB-API-00** `api/cases/route.ts` and `search.ts` — non-core ORM Case read/list plus priority-only optimistic update and safe search document; reject every association/lifecycle/provenance-field mutation, and exclude decrypted handles, subject, wrap-up, and message content with bypass/leakage tests.
- **INB-GUARD-01** Widen global-search guard coverage to the Connect package when the search surface is added.
- **INB-CMD-01** `commands/assign-case.ts` — unified claim/assign/unassign with audit and optimistic lock.
- **INB-CMD-02** `commands/transition-case.ts` shared by interactive lifecycle routes and auto-close, preserving guards/audit/domain-outbox invariants under tenant+organization+Case lock.
- **INB-API-01** `api/cases/[id]/assign/route.ts` and lifecycle action routes — guards, metadata, callbacks.
- **INB-SEND-01** `commands/enqueue-outbound.ts` + route — command-key winner lookup and atomic logical message/attempt/outbox insert.
- **INB-SEND-01A** Under the Case+conversation lock, validate the requested currently bound conversation, load its latest reply-target provenance, and resolve Contract D server-side before insert/revalidate at dispatch; test wrong/stale/cross-Case conversation, multiple conversations with distinct Reply-To values, later inbound changing the target, ingest-vs-send race, Reply-To precedence, ambiguous multi-party failure, masked UI, and no recipient leakage.
- **INB-SEND-01B** Map Contract D reply results exactly: transient before provider retains queued with bounded retry; stale/wrong/ambiguous/unavailable becomes definitive no-provider `failed` with safe reason; channel disable/authorization uses Contract A terminal reasons; no resolver failure enters unknown. Test every enqueue and dispatch outcome.
- **INB-SEND-02** `workers/dispatch-outbox.ts` plus queue registration for `connect.outbound.dispatch` — recoverable idempotent submission to the hub facade and correlation capture. `setup.seedDefaults` uses optional `schedulerService` to register stable per-organization `connect:{organizationId}:outbound-dispatch-sweep` targeting that queue at a documented bounded interval; Inbox activation/health fails closed with `scheduler_unavailable`. An after-commit best-effort wake job and scheduled recovery sweep claim bounded leased batches. Test stable re-registration, scheduler absence, commit-before-enqueue crash, duplicate wake jobs, worker crash/lease expiry, and scheduled recovery. Connect never calls a provider.
- **INB-SEND-03** `subscribers/outbound-delivery-status.ts` + `workers/reconcile-outbound.ts` — consume fully scoped PR A outcome events, retain highest per-attempt revision, reject stale/conflicting terminal transitions, use read-only lookup, apply idempotent terminal states, and raise bounded-age alerts.
- **INB-EVT-01** Add Inbox-owned domain-outbox writes/tests for `connect.case.assigned`, `.resolved`, `.reopened`, `connect.outbound.attempted`, and `.status_changed` at source commands/subscriber.
- **INB-SEND-04** failed-only retry route creating a child attempt with a new immutable hub correlation while retaining the logical-message/client command lineage.
- **INB-OPS-01** Inbox-owned unknown-delivery recovery queue/API/notification with age escalation, refresh and acknowledge commands; test fully without Metrics installed.
- **INB-READ-02** Per-user read command/list projection with new-inbound, assignment/transfer, concurrency, and unassigned/multi-agent tests.
- **INB-WRK-01** Register queue `connect.case.auto-close` and stable per-organization schedule `connect:{organizationId}:case-auto-close-sweep`. The source-owned scheduler constructs an unforgeable server-only system principal scoped from the schedule's tenant+organization with actor kind `system:auto_close`; the shared transition command still runs registered+legacy guards under `reason:auto_close`, and any veto prevents closure. Browser/API callers cannot select this actor/reason. Claim resolved Cases whose last inbound/lifecycle activity is strictly older than the configured UTC quiet-window boundary, revalidate under the Case lock, and call the command. Test spoof denial, guard veto, audit actor, exact boundary, inbound/reopen race, scheduler absence, duplicate/crash/idempotent sweep, and one audit/outbox transition.
- **INB-READ-01** Thread API using `tryResolve` PR C facade and plain projections only after enforcing the unassigned/self/manager Case-access matrix; bind cursors to the current Case assignment/access epoch and fail closed after transfer.
- **INB-UI-01** Inbox list/detail/thread/context/composer using shared UI primitives and guarded mutations.
- **INB-UI-02** assignment, lifecycle, delivery, error, conflict, and responsive states; five locales.
- **INB-DS-01** Run DS Guardian and remediate before screenshots.
- **INB-TEST-01** Integration: unassigned visible; self-claim race; manager assign; unauthorized target; every cross-tenant route 404.
- **INB-TEST-02** Integration: enqueue 202; confirmed send; definitive failure; timeout→unknown; no auto-resend; late reconciliation; reversed/duplicate delivery revisions cannot regress terminal state; failed-only retry creates a second hub/provider submission with a new correlation while client response retry does not.
- **INB-TEST-03** Integration/browser: thread allowlist isolation, empty/missing distinction, guarded mutations, per-pane conflicts, polling refresh, stable unavailable placeholders, cursor retry, cursor reuse after transfer and across Cases fails closed, sanitized display-only attachment metadata, and an item-level retry that preserves the rest of the thread.
- **INB-TEST-04** Browser: narrow navigation, keyboard/focus/live announcements, draft preservation, stale/offline recovery, persisted filters, unread state, and selection removed by polling.
- **INB-TEST-05** Browser/API response-loss retry reuses command key/body fingerprint across timeout/reload and produces one logical message/attempt.

## 📝 Final Compliance Report

- Assignment and send each have named writers and durable audits.
- Assignment, lifecycle, thread reading, outbound, and UI are one atomic release capability; partial phases remain disabled.
- The security-boundary relaxation is explicit, classified, compensated, and human-gated.
- Indeterminate delivery cannot trigger automatic duplicate sends.
- UI follows repository mutation, HTTP, i18n, optimistic-lock, and design-system rules.

## Implementation Status

| Phase | Status | Date | Notes |
|-------|--------|------|-------|
| INB-DATA-01/02 — outbound message/attempt/outbox, assignment audit, read state, unknown-delivery entities | Done | 2026-08-22 | `Migration20260823010000_connect`; reply payload encrypted, unique predecessor index prevents retry forks |
| INB-API-00 — Case read/list + priority-only update | Done | 2026-08-22 | The projection carries no subject, wrap-up, decrypted handle or message content; the update schema has no other writable field, so a `status` or `assigneeUserId` in the body is ignored rather than partially applied |
| INB-GUARD-01 — search guard coverage | N/A | 2026-08-22 | No search surface is added in this slice; `search.ts` arrives with the Case search Inbox does not yet expose |
| INB-CMD-01 — unified assign/claim/transfer/unassign | Done | 2026-08-22 | One command with audit + optimistic lock; self-claim is the same command with the caller's id |
| INB-CMD-02 — shared transition command | Done | 2026-08-22 | Used by the interactive routes AND the auto-close sweep, so the two cannot drift |
| INB-API-01 — assign + lifecycle routes | Done | 2026-08-22 | Guarded, per-method metadata, optimistic conflict surfaced as 409 |
| INB-SEND-01/01A/01B — enqueue with server-resolved destination | Done | 2026-08-22 | Message + attempt + outbox commit together; Contract D resolved before insert; transient stays queued, stale/ambiguous/unavailable is a definitive pre-provider failure |
| INB-SEND-02 — dispatch worker + queue/schedule | Done | 2026-08-22 | Leased batch claim, re-resolves the target at dispatch, indeterminate submission becomes `unknown` and is never resubmitted. Connect never calls a provider |
| INB-SEND-03 — outcome subscriber + reconciliation worker | Done | 2026-08-22 | Matches on full scope + attempt, monotonic revisions, terminal decisions fenced, read-only lookup only |
| INB-SEND-04 — failed-only retry | Done | 2026-08-22 | Child attempt with a NEW correlation, parent consumed, unique predecessor index arbitrates concurrent clicks |
| INB-EVT-01 — Inbox domain-outbox events | Done | 2026-08-22 | `connect.case.assigned/.resolved/.reopened`, `connect.outbound.attempted/.status_changed` |
| INB-OPS-01 — unknown-delivery recovery queue | Done | 2026-08-22 | Inbox-owned, works with Metrics absent; refresh + acknowledge only, no force-sent/force-failed |
| INB-READ-02 — per-user read watermark | Done | 2026-08-22 | Own-user only, monotonic, never transferred with an assignment |
| INB-WRK-01 — auto-close sweep | Done | 2026-08-22 | Server-only `system:auto_close` principal built from the schedule's own scope; still runs guards, and there is no request shape that can select it |
| INB-READ-01 — thread route | Done | 2026-08-22 | Case matrix first, then Contract C; cursors carry the access epoch and fail closed after a transfer |
| INB-UI-01/02 — three-pane Inbox | Done | 2026-08-22 | Shared primitives, guarded mutations, masked non-editable destination, `unknown` disables retry with an explanation, five complete locales |
| INB-DS-01 — DS Guardian | Partial | 2026-08-22 | The DS ESLint pass is clean on `packages/connect`; the interactive `om-ds-guardian` review and screenshots need a running app |
| INB-TEST-01..05 — integration/browser | Not Started | — | Require a live database and browser harness. Unit coverage exists for the access matrix, epoch binding, outcome application, and the lifecycle/attach rules |

## Changelog

- 2026-08-22: Implemented the data model, assignment, lifecycle, thread reading, the durable outbound state machine, reconciliation, the recovery queue and the three-pane UI with unit coverage; integration and browser verification outstanding.
- 2026-08-21: Successor split from v2; added unified assignment, explicit send worker, unknown/reconcile semantics, and class (e) PR C decision.

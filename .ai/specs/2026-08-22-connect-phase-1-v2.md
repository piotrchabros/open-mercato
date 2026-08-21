# Mercato Connect — Phase 1: One Inbox (v2)

| Field | Value |
|---|---|
| **Date** | 2026-08-22 |
| **Status** | **Proposed.** Gate 1 claims ledger is GATED (verified by a non-author). Awaiting review round 1 on *this* document. |
| **Scope** | OSS |
| **Supersedes** | [`2026-08-21-connect-phase-1-merged.md`](2026-08-21-connect-phase-1-merged.md) — **frozen**, retained as the audit trail |
| **Module(s)** | new `packages/connect`; new `packages/channel-webform`; additive upstream changes to `communication_channels`, `customers`, `sales` |
| **Method** | [`spec-pipeline-runbook.md`](../docs/spec-pipeline-runbook.md) |
| **Evidence** | [`CLAIMS-LEDGER`](../analysis/spec-pipeline/CLAIMS-LEDGER-2026-08-21-connect-phase-1-merged.md) · [`FINDINGS-REGISTER`](../analysis/spec-pipeline/FINDINGS-REGISTER-2026-08-21-connect-phase-1.md) |

## Why this document exists

The merged spec drew 91 findings (19 Critical) from four reviewers run in parallel and blind to
each other. Rather than revise it a second time in place — the documented path to a "fourth
variant" — it was frozen and this document written **whole**, per
[`spec-pipeline-runbook.md`](../docs/spec-pipeline-runbook.md) § 8.

Four decisions were taken by the owner and are settled here: the `senderUserId` relaxation is
**dropped**, send becomes an **async delivery-status** model, the ROI claim is **withdrawn**, and
Phase 1 is rewritten whole rather than narrowed.

**Retraction carried forward.** The frozen spec's claim that
*"`system-user.ts` returns a sentinel UUID with no `auth.users` row, so the column cannot be
satisfied for system-authored sends"* is **[RETRACTED — see CLAIMS-LEDGER row 8]**. It is false:
`messages.sender_user_id` has no foreign key (ORM snapshot records `"foreignKeys": {}`), and
`communication_channels/commands/ingest-inbound-message.ts:378` already system-authors messages
through `resolveCommunicationChannelsSystemUserId`. Nothing in this document depends on relaxing it.

## TLDR

Replace a shared support mailbox with a real service desk. Every inbound e-mail and web-form
submission becomes a **Case** with one owner, one status and one thread; the agent replies from a
three-pane Inbox with the customer's orders on screen; resolving writes a note and projects an
interaction onto the Customer 360 timeline.

No SLA clock, no queues, no routing, no AI, no bots, no portal. Phase 1 proves the Case aggregate,
the hub binding and the `customers` projection contract on channel adapters that already ship
(`channel-gmail`, `channel-imap`).

## Scope

**In.** Case + Conversation + contact-identity aggregates · inbound ingest with auto-responder and
bounce suppression · auto-acknowledgement to the customer · identity resolution with
per-`handle_type` thresholds · manual-match queue · attach-window rule · three-pane Inbox ·
reply on connected channels with async delivery status · resolve with wrap-up · close, reopen and
transfer · Cases list and detail · Customer 360 · projection to `CustomerInteraction` ·
`channel-webform` · the counting layer and the screen that reads it.

**Out, deliberately.** SLA clocks · service queues, presence, routing offers · AI suggestions,
summaries, wrap-up drafts · bots and intents · the customer portal · campaigns · quality review.
`connect_case.service_queue_id` is nullable and **always null in Phase 1**.

**Dropped from Phase 1 relative to the frozen spec.** The `escalated` status and
`escalation_reason`. Phase 1 has no queues, presence or routing, so an escalation has **no
recipient** — the state was unreachable and the column had no writer. Both return in the phase that
ships queues.

**Partially satisfied by design.** The product names nine channel types. Phase 1 supports e-mail
(Gmail/IMAP) and web form. Say so in the release note rather than implying omnichannel coverage.

## Success criteria

The frozen spec shipped none, and its inherited business case was self-referential — every
"Baseline" was the design prototype's current KPI minus that KPI's own month-over-month delta chip
(6.20+1.10=7.30; 78.4−6.1=72.3; 4:38+52s=5:30). That measured Connect against Connect one month
earlier. **The ROI claim is withdrawn.** These replace it, and each is measurable from the counting
layer this phase ships:

| # | Criterion | Measured from |
|---|---|---|
| SC-001 | 100% of inbound e-mail on a connected channel becomes exactly one Case or attaches to one | `connect_metric_daily.cases_opened` vs `ExternalMessage` count |
| SC-002 | Zero auto-responder loops: no `(channel, sender)` pair opens more than `N` Cases per window | `connect_metric_daily.suppressed_inbound` |
| SC-003 | Zero cross-tenant and cross-customer disclosures | T-TEST-05, T-TEST-06 |
| SC-004 | Every resolved Case with a linked identity has a `CustomerInteraction` within 60 s | `connect_pending_projections` drain lag |
| SC-005 | The operator baseline (volume, inbound/outbound split, handle time) exists after 30 days | the counting layer itself |

SC-005 is the honest form of the withdrawn ROI: Phase 1 **produces** the baseline that a business
case needs. It cannot also **be** measured against one that does not yet exist (Q3).

## Requirements

Numbered for traceability; each names the task that performs its write.

### Case lifecycle

- **FR-001** An inbound message MUST become exactly one Case, or attach to an existing Case per
  § Attach rule. → T-ING-01, T-ING-04
- **FR-002** A Case MUST carry number, subject, customer, originating channel, owner (or an explicit
  unassigned state), priority and status. → T-DATA-01, T-SEQ-01
- **FR-003** Status transitions MUST follow § Status machine exactly; illegal transitions are
  rejected with a field error, and every transition MUST write a `connect_case_transition` row
  recording actor, from, to and time. → T-DOM-01, T-DATA-06
- **FR-004** A Case MUST NOT reach `resolved` with an empty wrap-up note. → T-API-04
- **FR-005** `resolved → closed` MUST happen by explicit action, or by the auto-close job after
  `auto_close_after_days` with no inbound **measured on `connect_conversation.last_inbound_at`**.
  → T-API-05, T-WRK-01
- **FR-006** An inbound on a `resolved` Case within `reopen_window_days` MUST reopen it in place per
  § Status machine; an explicit reopen action MUST do the same. → T-API-06, T-ING-01
- **FR-007** Concurrent edits MUST NOT silently overwrite; the later writer receives **409** with the
  standard conflict body. → T-API-02, T-UI-07
- **FR-024** The generic CRUD route MUST NOT be able to change `status`, `resolved_at`, `closed_at`
  or `assignee_user_id`; those move only through the action routes that enforce § Status machine.
  → T-API-01

### Conversations and delivery

- **FR-008** A Conversation MUST bind 1:1 to one `ExternalConversation` and have exactly one parent
  Case, and MUST store the `message_thread_id` and `last_message_id` it learns from the hub.
  → T-DATA-02
- **FR-009** The agent MUST be able to reply on any **connected** channel, and the chosen channel
  MUST be visible before sending. → T-UI-04, T-API-07
- **FR-010** Send is **asynchronous**. The route MUST enqueue and return **202** with a
  `connect_message` row in `queued`; it MUST NOT block on the provider. → T-API-07
- **FR-011** Delivery status MUST be reconciled from the hub: `sent` stamps `first_human_outbound_at`
  (once, never updated) and advances the Case to `waiting_customer`; `failed` does **neither**, and
  surfaces on the message with a retry. → T-WRK-02
- **FR-012** Auto-responder and bounce traffic MUST NOT open a Case, MUST NOT be acknowledged, and
  MUST be counted. → T-ING-02
- **FR-025** A first inbound that opens a Case MUST send exactly one auto-acknowledgement to the
  customer, suppressed by the same rules as FR-012 and never sent to a suppressed sender.
  → T-ING-05

### Identity

- **FR-013** Channel handles MUST resolve to a `CustomerEntity` with a recorded confidence and
  **match method**. → T-ING-03, T-DATA-03
- **FR-014** Below the per-`handle_type` threshold the system MUST link **nothing**, set
  `link_state='unresolved'`, and write a `connect_manual_match_task` row. → T-ING-03, T-DATA-07
- **FR-015** A link MUST be reversible and audited in `connect_identity_link_audit`; the identity row
  MUST NOT be deleted, and unlink MUST set `link_state='unresolved'` and re-open a manual-match task.
  → T-API-08, T-DATA-07
- **FR-016** Handle values MUST be encrypted at rest with equality lookup via a hash column, and the
  hash MUST be written **even when encryption is disabled**, or the unique index stops enforcing.
  → T-DATA-03
- **FR-026** A manual-match task MUST be workable from a screen, and resolving it MUST link the
  identity and drain any staged projection. → T-UI-10, T-API-10

### Projection and measurement

- **FR-017** Resolving a Case MUST project a `CustomerInteraction` onto the Customer 360 timeline.
  → T-API-04, T-PROJ-01
- **FR-018** When the identity is unresolved the projection MUST be **staged** and drained when the
  handle is later linked — `CustomerInteraction.entity` is a non-nullable `@ManyToOne` and
  `requireTimelineParentEntity` rejects any kind outside `{person, company}`, so an unidentified
  Case cannot project. → T-PROJ-02
- **FR-019** Phase 1 MUST ship the counting layer **and a screen that reads it**: cases
  opened/resolved/reopened, inbound/outbound counts, suppressed inbound, duplicate-reply candidates.
  → T-MET-01, T-DATA-08, T-UI-09
- **FR-027** A projection MUST NOT fail on a customer legitimately linked in another organisation;
  a cross-org customer stages instead of throwing. → T-PROJ-01

### Tenancy, access, i18n

- **FR-020** Every row MUST be scoped to tenant and organisation, and every route MUST enforce it.
  → T-API-01, T-API-11
- **FR-021** A cross-tenant or cross-org reference MUST return **404**, never 403, on **every**
  route. → T-API-11
- **FR-022** Every capability MUST be feature-gated; listing MUST narrow to the caller's own Cases
  without `connect.cases.view.all`, and narrowing MUST NOT rely on an `ids` list that truncates.
  → T-API-09
- **FR-023** No user-facing string may be hard-coded; **all five locales** (`en`, `pl`, `es`, `de`,
  `ko`) ship complete — `scripts/i18n-check-sync.ts:25` requires them. → T-I18N-01

## Architecture

### Aggregates

```
connect_case              the unit of work — owns grouping, status, owner, wrap-up
  ├─ connect_conversation   1:1 with communication_channels.ExternalConversation
  │                         stores message_thread_id + last_message_id (learned from the hub)
  ├─ connect_message        outbound send intent + delivery status (bodies stay in `messages`)
  └─ connect_case_transition  one row per status change
connect_contact_identity   channel handle → CustomerEntity, with confidence and match method
connect_manual_match_task  the work item FR-014 creates
```

### Attach rule (resolves the frozen spec's central ambiguity)

The frozen spec said "an open Case for the same identity" and defined neither term. Both readings
were unsafe: a row-based key is channel-scoped — re-imposing the exact limitation the merge faulted
package A for — and a `customer_entity_id` key collapses every unresolved sender into one bucket,
which is the R2 disclosure.

**The rule.** An inbound attaches when **all** hold:

1. the sender's identity is `link_state='linked'` — an **unresolved identity never attaches** and
   always opens its own Case; and
2. a Case exists for that `customer_entity_id` whose status is **not `closed`**; and
3. `now - last_inbound_at <= case_attach_window_minutes` (floor 60), **or** the Case is `resolved`
   and within `reopen_window_days`.

Otherwise a new Case opens. This makes cross-channel grouping real for identified customers,
keeps unidentified senders strictly isolated, and makes a customer reply after resolve reopen the
Case rather than orphan into a new one.

### Status machine

`escalated` is dropped from Phase 1 (see § Scope). The legal set is a table, not an arrow chain —
the frozen spec's chain forbade `in_progress → resolved`, which is the happy path.

| From | To | Trigger |
|---|---|---|
| `new` | `in_progress` | assign, or first agent action |
| `new` | `resolved` | resolve with wrap-up (FR-004) |
| `in_progress` | `waiting_customer` | outbound `sent` (FR-011) |
| `in_progress` | `resolved` | resolve with wrap-up |
| `waiting_customer` | `in_progress` | inbound arrives, or agent acts |
| `waiting_customer` | `resolved` | resolve with wrap-up |
| `resolved` | `in_progress` | reopen — explicit, or inbound within `reopen_window_days` (FR-006) |
| `resolved` | `closed` | close action, or auto-close (FR-005) |
| `closed` | — | terminal. A later inbound opens a **new** Case linked via `previous_case_id` |

Reopen clears `resolved_at`, preserves `wrap_up_note` as a `connect_case_transition` payload, and
increments `reopen_count`. Every transition writes a transition row (FR-003).

**Ordering invariant:** `reopen_window_days <= auto_close_after_days`. Validated in T-VAL-01 —
otherwise a Case auto-closes while still reopenable, and the two windows contradict.

### Reading peer data

`connect` MUST NOT query `messages` or `communication_channels` tables, import their entity classes,
write raw SQL against them, or resolve their entity-class DI registrations in order to query them.

**Thread ids come from events, not from a facade.** `connect_conversation` stores
`message_thread_id` and `last_message_id`, taken from the `message.received` event payload and from
`SendAsUserResult`. The frozen spec stored neither, which left `connect` with no reachable path to a
thread id at all — the same "requirement with no mechanism" defect it was written to repair.

**One facade, owned by `communication_channels` — not `messages`.** The frozen spec put
`messagesThreadReader` in `messages`, but that module cannot produce the declared projection:
`direction` does not occur in `messages` at all, and direction, channel type and delivery status
live on `MessageChannelLink`, which `communication_channels` owns. A `messages`-owned facade would
have to read its own consumer's table.

`communication_channels` is the correct owner: its `data/extensions.ts` already declares
`{ base: 'messages:message', extension: 'communication_channels:message_channel_link' }` and
documents the direction — *"The hub knows about other modules (auth, customers, messages) but those
modules do NOT know about the hub — dependency direction is one-way (hub → others)."*

So PR C exposes **`communicationChannelsThreadReader`** from the existing
`communication_channels/di.ts`, alongside the `communicationChannelsSendAsUser` precedent. Scope
parameters are mandatory, reads are batched, projections are plain (never ORM entities), empty is
distinguishable from missing, and the consumer logs via `createLogger` when `tryResolve` yields
nothing. → T-UP-04

**Containment.** The facade accepts only thread ids the caller already owns; `connect` passes ids
read from its own `connect_conversation` rows. The facade is therefore not a general message
reader. See **Q-D** — this still relaxes `messages`' sender-OR-recipient participant scope, because
an inbound message's sender is the system user and its recipient list is empty.

### Inbox freshness

The frozen spec specified no refresh mechanism while testing the conflict that its absence
maximises (U7). Phase 1 uses **poll-on-focus plus a 30 s interval** on the Case list and open Case,
with `updatedAt` driving the conflict bar. No `clientBroadcast`, no cache — both are deferred, and
the deferral is now a stated decision rather than a silent gap.

### Commands and undo

`resolve`, `transfer`, `close`, `reopen`, identity `link`/`unlink` are undoable commands exposing
`extractUndoPayload()`. **Send is not undoable** — an outbound message has left the building — and
that exemption is stated in the command header so nobody adds a false undo affordance.

## Blocking upstream PRs

| PR | Module | Change | Class |
|---|---|---|---|
| **A** | `communication_channels` | Shared-channel workstream: shared-channel creation command, tenant-scoped credential provisioning (`user_id IS NULL`), sender identity threaded through `SendMessageInput`, widened `SendAsUserActor`, shared-channel listing endpoint, authorisation delegated to `assertCanManageChannel`. **No `senderUserId` change** — see the retraction above. | **(e)** |
| **B** | `customers`, `sales` | Stability commitment on `customers.interactions.create` (already called cross-module from `apps/mercato/src/modules/example_customers_sync/lib/sync.ts:859`); four new detail injection spots plus one declaration. | (b) + (c) |
| **C** | `communication_channels` | `communicationChannelsThreadReader` in the existing `di.ts`, backed by `lib/thread-reader.ts`; a "Public Contract Surfaces" table in the module's `AGENTS.md`. | (a) + (b), **pending Q-D** |

PR A no longer touches `messages`, so `messages/di.ts` is not created and `messages/AGENTS.md` —
which does not exist — is not edited.

## Core-edit ledger — Gate 2

**The rule, quoted.** `packages/core/AGENTS.md` § Extensions: *"When extending another module's
data, add a separate extension entity — never mutate core entities."* Scoped to entities/data. Root
`AGENTS.md`'s `Never` list has no general core-edit item; editing core sits under `Ask First`.

| File | Class | Sanctioned alternative considered | Ships as |
|---|---|---|---|
| `communication_channels/lib/thread-reader.ts` + `di.ts` registration | (a)+(b) | None exists — the platform has extension mechanisms for core *data* and *UI*, but none for reading a peer module's data. `.ai/lessons.md` → *"Cross-module query precedent is not permission to copy storage coupling"* requires a source-owned facade. | PR C |
| `communication_channels/lib/send-as-user.ts` + `SendMessageInput` + `SendAsUserActor` | **(e)** | No extension point governs outbound authorisation. Delegating to the existing `assertCanManageChannel` keeps the check in the owning module rather than adding a bypass. A caller-supplied `allowSharedChannel` flag was rejected: it lets any in-process DI caller opt out of the only ownership check. | PR A |
| `customers`/`sales` `extension-points.ts` | (c) | n/a — declaring a new spot *is* the sanctioned mechanism | PR B |
| `apps/mercato/src/modules.ts` — `enabledModules` entries | (b) | n/a — a new workspace package is **not** auto-discovered; the CLI AST-parses this array (`packages/cli/src/lib/agentic-setup.ts:94-101`) | `connect` PR |
| `packages/create-app/template/src/modules.ts` mirror | (b) | n/a — required by the template-sync check | `connect` PR |
| `optimistic-lock-editable-entities.test.ts` resolver + curated map | (a) | n/a — the resolver is `packages/core`-only (`:72`), so it must widen before `connect` entries can be added | `connect` PR |
| `global-search-acl.test.ts` scan roots | (a) | n/a — same class: the guard does not scan `packages/connect` | `connect` PR |

**Zero (d)-class changes.** The frozen spec's only entity/table change was the `senderUserId`
relaxation, retracted above.

**No `auth.User` column.** `principal_kind` is not needed in Phase 1 and has a sanctioned
alternative — `communication_channels/data/extensions.ts:51-53` already declares
`{ base: 'auth:user', extension: 'communication_channels:communication_channel', join: { baseKey: 'id', extensionKey: 'user_id' } }`.

## Data model

All tables carry `id uuid PK`, `tenant_id uuid NOT NULL`, `organization_id uuid **NULL**`,
`created_at`, `updated_at`, `deleted_at`. `updated_at` drives optimistic locking (default ON).

**`organization_id` is nullable**, not NOT NULL. Every organisation column on the peer rows this
aggregate binds to is nullable — `ingest-inbound-message.ts:201,213` writes
`organizationId: input.scope.organizationId ?? null` — so a NOT NULL column could not be satisfied
from an org-less inbound.

**`connect_cases`** — `case_number` (`<prefix>-<seq>`, unique per tenant, prefix from
`connect_tenant_settings`, allocated via the `sales.SalesDocumentSequence` pattern) · `subject` ·
`status` · `priority` · `service_queue_id` (nullable, always null in Phase 1) · `assignee_user_id` ·
`customer_entity_id` (nullable until resolved) · `origin_channel_id` ·
`source_order_id`/`source_return_id`/`source_shipment_id` · `case_value_minor` +
**`case_value_currency`** (a minor-unit amount without a currency is not a monetary value) ·
`wrap_up_note` · `wrap_up_seconds` · `conversation_count` · `reopen_count` · `previous_case_id` ·
`first_agent_touch_at`/`last_agent_touch_at` · `resolved_at`/`closed_at` ·
`merged_into_case_id`/`split_from_case_id` (unused in Phase 1).
Indexes: `(tenant_id, organization_id, status)` · `(tenant_id, customer_entity_id, status)` ·
`(tenant_id, assignee_user_id, status)` · unique `(tenant_id, case_number)`.

**`connect_conversations`** — `case_id` · `external_conversation_id` (text — the hub's external ref)
· `message_thread_id` (uuid) · `last_message_id` (uuid) · `channel_id` · `contact_handle`
(**encrypted**) · `human_agent_message_count` · `first_human_outbound_at` (written once) ·
`started_at`, `ended_at`, `last_inbound_at`, `last_outbound_at`.
Unique `(tenant_id, external_conversation_id)`. Index `(tenant_id, case_id)`.

**`connect_messages`** — `conversation_id` · `message_id` (the `messages` id, once known) ·
`direction` · `delivery_status` (`queued|sent|failed`) · `failure_reason` · `queued_at`/`sent_at` ·
`retry_count`. Bodies are **never** stored here.

**`connect_case_transitions`** — `case_id` · `from_status` · `to_status` · `actor_user_id` ·
`reason` · `payload` (jsonb) · `occurred_at`. FR-003's audit.

**`connect_contact_identities`** — `handle_type` · `handle_value` (**encrypted**) ·
`handle_value_hash` · **`match_method`** · `customer_entity_id` (nullable) · `link_state` ·
`confidence` (integer 0–100) · `channel_id` · `unlinked_at`/`unlink_reason` ·
`first_seen_at`/`last_seen_at`.
Unique: a **raw-SQL partial index** on `(tenant_id, channel_id, handle_type, handle_value_hash)
where deleted_at is null and handle_value_hash is not null` — a plain `@Unique` on ciphertext is
meaningless, since every row has a distinct IV. Phone handles normalise to E.164 before encryption.

**`connect_identity_link_audit`** — `identity_id` · `action` (`link|unlink`) · `from_customer_id` ·
`to_customer_id` · `actor_user_id` · `reason` · `occurred_at`. FR-015 needs a history, which a pair
of single-valued columns cannot hold.

**`connect_manual_match_tasks`** — `identity_id` · `state` (`open|resolved|dismissed`) ·
`candidate_customer_ids` (jsonb) · `resolved_by_user_id` · `resolved_at`. FR-014's writer.

**`connect_pending_projections`** · **`connect_metric_daily`** (`day`, `cases_opened`,
`cases_resolved`, `cases_reopened`, `inbound_count`, `outbound_count`, `suppressed_inbound`,
`duplicate_reply_candidates`) · **`connect_tenant_settings`** (typed columns:
`case_attach_window_minutes`, `auto_close_after_days`, `reopen_window_days`, `case_number_prefix`,
`auto_ack_enabled`, per-`handle_type` thresholds) · **`connect_case_tags`** + assignments.

**Encryption.** `encryption.ts` exports `defaultEncryptionMaps` covering
`connect_conversations.contact_handle` and `connect_contact_identities.handle_value`, the latter as
`{ field: 'handle_value', hashField: 'handle_value_hash' }`. The unique index is on the **hash**
column. This is the platform's existing mechanism — `auth/encryption.ts:7`,
`customer_accounts/encryption.ts:7,21` and `messages/encryption.ts:9` all use `hashField`. All reads
go through `findWithDecryption` / `findOneWithDecryption`, and hash lookups use
`lookupHashCandidates` (`packages/shared/src/lib/encryption/aes.ts:159`) because two on-disk hash
formats coexist across a pepper rollout.

**Known limitation, stated not hidden:** during a pepper rollout the unique index cannot dedupe
across formats, because the same handle hashes two ways. T-ING-01's insert-and-catch still prevents
duplicate Cases; the identity row may transiently duplicate until a backfill recomputes hashes.

**No denormalised customer PII.** No `customer_snapshot` anywhere. Name and e-mail resolve live
through `customers`.

## API contracts

Tenant- and organization-scoped, `requireFeatures`-guarded, documented in `api/openapi.ts`.
**Every route file exports per-method `metadata`** — a top-level `export const requireAuth` is a
violation. Mutating routes honour optimistic locking and return **409** with the standard conflict
body. **Every** route returns 404 (never 403) for a cross-tenant or cross-org reference (FR-021).

| Method | Route | Feature | Guard op | Task |
|---|---|---|---|---|
| GET/POST/PUT/DELETE | `/api/connect/cases` | `connect.inbox.view` / `.handle` / `.cases.manage` | factory | T-API-01 |
| POST | `/api/connect/cases/{id}/resolve` | `connect.inbox.handle` | `update` | T-API-04 |
| POST | `/api/connect/cases/{id}/close` | `connect.cases.manage` | `update` | T-API-05 |
| POST | `/api/connect/cases/{id}/reopen` | `connect.inbox.handle` | `update` | T-API-06 |
| POST | `/api/connect/cases/{id}/transfer` | `connect.inbox.handle` | `update` | T-API-03 |
| POST | `/api/connect/cases/{id}/messages` | `connect.inbox.handle` | `create` | T-API-07 |
| GET | `/api/connect/cases/{id}/conversations` | `connect.inbox.view` | — | T-API-12 |
| GET | `/api/connect/contact-identities` | `connect.inbox.view` | — | T-API-13 |
| POST | `/api/connect/contact-identities/{id}/link` \| `/unlink` | `connect.inbox.handle` \| `connect.identities.manage` | `update` | T-API-08 |
| GET/POST | `/api/connect/manual-match-tasks` \| `/{id}/resolve` | `connect.inbox.handle` | `update` | T-API-10 |
| GET/PUT | `/api/connect/settings` | `connect.settings.manage` | `update` | T-API-14 |
| GET | `/api/connect/metrics/baseline` | `connect.cases.view.all` | — | T-API-15 |

CRUD uses `makeCrudRoute({ …, indexer: { entityType: E.connect.connect_case } })`, with `status`,
`resolved_at`, `closed_at` and `assignee_user_id` **excluded from the updatable set** (FR-024).

The seven mutating action endpoints are **not** CRUD and MUST NOT bypass the guard registry: collect
registered guards, append `bridgeLegacyGuard(container)`, call `runMutationGuards(...)`
(`packages/shared/src/lib/crud/mutation-guard-registry.ts:90,129`) with `{ userFeatures }` **before**
mutating, merge `modifiedPayload`, then run `afterSuccessCallbacks`, catching and logging callback
failures.

`api/interceptors.ts` narrows `GET /api/connect/cases` to the caller's own Cases without
`connect.cases.view.all` by injecting an `assignee_user_id` filter — **not** an `ids` list, which
truncates at 200 and would silently drop Cases.

### Frozen surfaces

Six Phase-1 ACL IDs, per `app-spec-notes/frozen-surfaces.md:68-70`: `connect.inbox.view` ·
`connect.inbox.handle` · `connect.cases.view.all` · `connect.cases.manage` ·
`connect.identities.manage` · `connect.settings.manage`. `/metrics/baseline` is guarded by
`connect.cases.view.all` until `connect_analytics` ships — a documented overload, not a new ID.

Ten `connect.*` event IDs freeze in Phase 1 (`frozen-surfaces.md:42,46-49`). `connect.case.assigned`
is emitted by T-API-03 (transfer) and by assignment on the CRUD route — the frozen spec froze it
with no writer.

## UI

`/backend/connect/inbox` — three-pane composite. Left: channel filter chips, **Case rows** (not
conversation rows) with a channel-badge cluster. Centre: header, thread rendering `in`/`out`/`sys`
distinctly, composer with reply-channel picker; Enter sends, Shift+Enter newlines; queued messages
show a pending state and failed ones a retry. Right: customer card, order context, contact-identity
panel with confidence and link/verify.

Also `/backend/connect/cases` (DataTable + CSV), `/cases/[id]`, `/manual-match`, `/metrics`,
`/settings`. Customer 360 is delivered **as injection widgets into the existing `customers` detail
page** — not as a second `/backend/connect/customers/[id]` screen, which would compete with the
`customers` module's own.

**Every screen defines empty, loading, error and permission-degraded states**; U6 asserts each empty
state has a working CTA.

**Canonical mechanisms.** HTTP via `apiCall`/`apiCallOrThrow`/`readApiResultOrThrow`; JSON via
`readJsonSafe`; raw `fetch` is a violation. The Inbox is a custom composite, so **every** write in it
is wrapped in `useGuardedMutation(...).runMutation(...)` with `retryLastMutation` in the injection
context, and each pane holds its own `updatedAt` and sends
`withScopedApiRequestHeaders(buildOptimisticLockHeader(...))` **per mutation target**.
`LoadingMessage`/`ErrorMessage` per pane. `Cmd/Ctrl+Enter` submits dialogs, `Escape` cancels. Icons
are lucide-react; the prototype's inline `<svg>` must not be ported. Pane widths use the DS spacing
scale — never `w-[336px]`.

Run `om-ds-guardian` over the Inbox before implementation locks the patterns in.

## Risks

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | **Auto-responder loop** | **Critical** | `Auto-Submitted`/`Precedence` header checks **plus** a `(channel_id, from_handle_hash)` window in `connect`'s own limiter. `inbox_ops/lib/rateLimiter.ts` cannot be reused: its cache keys are hardcoded to `inbox_ops:rate_limit:${key}` (`:74,:96`) and its only two call sites are a global bucket (`inbound.ts:294`) and a tenant bucket (`:339`). Never fall back to a tenant-wide bucket. → T-ING-02, T-TEST-14 |
| R2 | **Wrong identity link exposes another customer's orders** | **Critical** | Sub-threshold links nothing (FR-014); unresolved identities never attach (§ Attach rule); manual-match queue is a real surface; T-TEST-06 asserts cross-customer isolation |
| R3 | Shared-channel outbound widens a security boundary | **Critical** | Authorisation delegates to `assertCanManageChannel` (`access-control.ts:96-99`); no caller-supplied opt-out; T-TEST-07 |
| R4 | Upstream PR A rejected or delayed | High | Slices 1a–1b do not depend on it; only 1c does |
| R5 | **N+1 on the Inbox list** | High | The query engine's cross-module joins are `EXISTS`-only, so batching is done with a **response enricher** that batch-loads customers and orders per page — not with a join. T-TEST-08 asserts a query-count ceiling |
| R6 | `conversation_count` drifts | High | Written in the same transaction as attach/detach (§ Consistency); the baseline job reconciles and reports drift |
| R7 | **Redelivered inbound opens a duplicate Case** | High | Idempotency is a **mechanism**: `connect_conversations` unique `(tenant_id, external_conversation_id)` arbitrates. Attempt the insert, catch 23505, resolve to the existing row. → T-TEST-09 |
| R8 | Demo seed leaks across tenants | Medium | Seed through the same scoped commands as production writes; T-TEST-05 runs against seeded data too |
| R9 | Prototype is Polish-only and hard-codes every string | Low | Five locales from day one; `yarn i18n:check-hardcoded` in § Definition of done |
| R10 | **Pepper rollout breaks hash uniqueness** | Medium | Stated in § Data model; reads use `lookupHashCandidates`; a backfill recomputes |

## Consistency

The frozen spec named no transaction boundary anywhere. Each write path below states its boundary.

| Write path | Boundary | Notes |
|---|---|---|
| Ingest attach-or-create | one transaction: `connect_conversation` insert (unique arbitrates) → Case attach/create → `conversation_count` increment → transition row | The 23505 catch uses a **savepoint** so the outer transaction survives the conflict |
| Resolve | one transaction: status → `resolved`, `resolved_at`, `wrap_up_note`, transition row; then **separately** the projection | `customers.interactions.create` forks its own EM (`interactions.ts:382`) and flushes unconditionally (`:423`), so resolve + projection **cannot** be atomic. T-PROJ-01 supplies a deterministic id and handles 23505 |
| Send | route transaction writes `connect_message` in `queued` only | Provider call happens in the worker (FR-010) |
| Delivery reconcile | one transaction: `connect_message.delivery_status` → `first_human_outbound_at` → status → transition row | `first_human_outbound_at` written once, guarded by a conditional update |
| Link / unlink | one transaction: identity → audit row → manual-match task → projection drain | Drain is idempotent |

`conversation_count` is stored (Phase 2's FCR input needs it) and reconciled nightly by T-MET-01
against a `COUNT(*)`, which reports drift rather than silently correcting it.

## Tasks

Every task names a file path. `<M>` = `packages/connect/src/modules/connect/`.

**Slice 1a — foundation (blocked by nothing)**
- T-SET-01 `packages/connect/{package.json,tsconfig.json,build.mjs,jest.config.cjs,.eslintrc.cjs}`, mirroring `packages/content/`
- T-SET-02 `<M>/index.ts` metadata
- T-SET-03 Register both packages: `apps/mercato/src/modules.ts` `enabledModules` entry + root `package.json` workspace dep + `packages/create-app/template/src/modules.ts` mirror; then `corepack yarn generate`
- T-DATA-01 `<M>/data/entities.ts` — `connect_case`
- T-DATA-02 `<M>/data/entities.ts` — `connect_conversation`, `connect_message`, `connect_case_reopen`, `connect_pending_projection`, `connect_tenant_settings`, tags
- T-DATA-03 `<M>/data/entities.ts` + `<M>/encryption.ts` — `connect_contact_identity`, `defaultEncryptionMaps` with `hashField`, raw-SQL partial unique index on the hash; hash written even when encryption is off
- T-DATA-06 `<M>/data/entities.ts` — `connect_case_transition`
- T-DATA-07 `<M>/data/entities.ts` — `connect_identity_link_audit`, `connect_manual_match_task`
- T-DATA-08 `<M>/data/entities.ts` — `connect_metric_daily`
- T-DATA-04 `corepack yarn db:generate`; keep only `connect` SQL; commit with the updated `.snapshot-open-mercato.json`. Do **not** run `db:migrate`
- T-DATA-05 Widen `packages/core/src/__tests__/optimistic-lock-editable-entities.test.ts`'s resolver beyond `__dirname/../modules/<id>` (`:72`), **then** add every `connect` entity to the curated map. Widening first is mandatory — adding a `connect` key to the current resolver throws ENOENT at collection time and reds the whole file
- T-SEQ-01 `<M>/lib/case-number.ts` — allocator following the `sales.SalesDocumentSequence` pattern
- T-ACL-01 `<M>/acl.ts` + `<M>/setup.ts` `defaultRoleFeatures`; then `corepack yarn mercato auth sync-role-acls`
- T-DOM-01 `<M>/lib/case-state.ts` — the § Status machine table; illegal transitions rejected with a field error
- T-EVT-01 `<M>/events.ts` — the ten `connect.*` IDs via `createModuleEvents` with `as const`. No `clientBroadcast` in Phase 1
- T-API-01 `<M>/api/cases/route.ts` — `makeCrudRoute` + `indexer` + OpenAPI + per-method `metadata`; `status`/`resolved_at`/`closed_at`/`assignee_user_id` excluded from the updatable set
- T-API-02 Optimistic locking on every mutating route; `updatedAt` in list and detail responses
- T-API-11 `<M>/lib/scope.ts` — the shared 404-not-403 scope resolver every route uses (FR-021)
- T-OAS-01 `<M>/api/openapi.ts`
- T-SRCH-01 `<M>/search.ts` — index subject and customer name, declare `aclFeatures`. **Exclude `handle_value` and `contact_handle`** — both encrypted at rest. Widen `global-search-acl.test.ts` scan roots to `packages/connect`
- T-VAL-01 `<M>/data/validators.ts` — zod per payload, types via `z.infer`, no `any`; includes the `reopen_window_days <= auto_close_after_days` invariant
- T-I18N-01 `<M>/i18n/{en,pl,es,de,ko}.json` — **slice 1a, not 1d**: T-ACL-01 and T-API-01 already emit user-facing strings

**Slice 1b — ingest (blocked by 1a)**
- T-ING-01 `<M>/subscribers/ingest-inbound.ts` (`persistent: true`) — attach-or-create per § Attach rule; stores `message_thread_id`/`last_message_id` from the event payload; insert-and-catch idempotency on the conversation unique index
- T-ING-02 `<M>/lib/auto-responder.ts` — `Auto-Submitted`/`Precedence` + a `(channel_id, from_handle_hash)` window in `connect`'s own limiter (R1)
- T-ING-03 `<M>/lib/identity-resolver.ts` — per-`handle_type` thresholds, `match_method`, `lookupHashCandidates` on read, manual-match task on sub-threshold
- T-ING-04 `<M>/lib/attach-window.ts` — `case_attach_window_minutes`, floor 60
- T-ING-05 `<M>/lib/auto-acknowledge.ts` — exactly one ack per opened Case, suppressed with FR-012
- T-CH-01 `packages/channel-webform/src/modules/channel_webform/` — adapter + intake via the shared inbound route

**Slice 1c — inbox (blocked by upstream PR A + C)**
- T-UP-01…03 Upstream PR A
- T-UP-04 Upstream PR C — `communication_channels/lib/thread-reader.ts` + `di.ts` registration + unit tests asserting scope enforcement, thread-id allowlisting and batching, + a "Public Contract Surfaces" table in `communication_channels/AGENTS.md`
- T-UI-01…03 `<M>/components/inbox/{InboxShell,CaseList,ConversationThread}.tsx`
- T-UI-04 `<M>/components/inbox/Composer.tsx` — reply-channel picker, Enter/Shift+Enter, queued/failed states
- T-UI-05 `<M>/components/inbox/useConnectMutations.ts` — `useGuardedMutation` + per-pane lock headers
- T-UI-07 `<M>/components/inbox/ConflictBar.tsx` — `surfaceRecordConflict` (FR-007)
- T-UI-11 `<M>/components/inbox/useInboxRefresh.ts` — poll-on-focus + 30 s interval
- T-API-03 `<M>/api/cases/[id]/transfer/route.ts` — emits `connect.case.assigned`, notifies the receiving agent
- T-API-04 `<M>/api/cases/[id]/resolve/route.ts` — wrap-up gate
- T-API-05 `<M>/api/cases/[id]/close/route.ts`
- T-API-06 `<M>/api/cases/[id]/reopen/route.ts`
- T-API-07 `<M>/api/cases/[id]/messages/route.ts` — enqueue, return 202 (FR-010)
- T-API-08 `<M>/api/contact-identities/[id]/{link,unlink}/route.ts` — audited, row never deleted
- T-API-09 `<M>/api/interceptors.ts` — narrow by `assignee_user_id` filter, not `ids` (FR-022)
- T-API-12 `<M>/api/cases/[id]/conversations/route.ts`
- T-API-13 `<M>/api/contact-identities/route.ts`
- T-CMD-01 `<M>/commands/` — undoable resolve/transfer/close/reopen/link/unlink with `extractUndoPayload`; send carries a documented no-undo exemption
- T-WRK-01 `<M>/workers/auto-close.ts` (FR-005)
- T-WRK-02 `<M>/workers/reconcile-delivery.ts` (FR-011)
- T-WRK-03 `<M>/setup.ts` — register T-WRK-01/02/T-MET-01 with the scheduler; without this none of them ever run

**Slice 1d — surfaces (blocked by upstream PR B)**
- T-UP-05 Upstream PR B
- T-PROJ-01 `<M>/commands/project-interaction.ts` — deterministic id, handles 23505, stages on cross-org (FR-027)
- T-PROJ-02 `<M>/lib/pending-projection.ts` — stage and drain on link (FR-018)
- T-UI-06 `<M>/backend/cases/page.tsx` — DataTable + CSV
- T-UI-08 `<M>/backend/cases/[id]/page.tsx`
- T-UI-09 `<M>/backend/metrics/page.tsx` (FR-019)
- T-UI-10 `<M>/backend/manual-match/page.tsx` (FR-026)
- T-UI-12 `<M>/backend/settings/page.tsx`
- T-API-10 `<M>/api/manual-match-tasks/…` (FR-026)
- T-API-14 `<M>/api/settings/route.ts`
- T-API-15 `<M>/api/metrics/baseline/route.ts`
- T-WID-01 Customer 360 injection widgets + the orders-list "has open case" — needs **both** a response enricher (supplies the field) **and** an `InjectionColumnWidget` (renders the column)
- T-MET-01 `<M>/workers/baseline-metrics.ts` — writes `connect_metric_daily`, reconciles `conversation_count` drift (FR-019)

**Slice 1e — tests (spans all slices; each test ships with the slice it covers)**
- T-TEST-01…16 `<M>/__integration__/*.spec.ts` — one file per scenario below
- T-UITEST-01…08 `<M>/__integration__/ui/*.spec.ts` — U1…U8

## Integration test coverage

Self-contained per `.ai/qa/AGENTS.md`: fixtures created in setup via API, cleaned in teardown, no
reliance on seeded demo data. **Every scenario is a task in slice 1e with a file path** — the frozen
spec listed scenarios that no task owned.

| # | Scenario | Asserts | Covers |
|---|---|---|---|
| T-TEST-01 | Inbound e-mail → Case | Exactly one Case; `conversation_count = 1`; `connect.case.created` once | FR-001 |
| T-TEST-02 | Second inbound, same identity, inside/outside window | Attaches / opens a new Case | FR-001 |
| T-TEST-03 | Out-of-office and DSN | **No Case**, no acknowledgement, counted as suppressed | FR-012 |
| T-TEST-04 | Send enqueues; worker reports `sent` then `failed` | 202 + `queued`; on `sent` stamps and advances; on `failed` neither | FR-010, FR-011 |
| T-TEST-05 | **Cross-tenant isolation** | A Case from tenant A is invisible to tenant B on **every** route, list, search and export; each returns 404 | FR-020, FR-021 |
| T-TEST-06 | **Cross-customer isolation** | An agent-scoped list never returns another customer's Case; an unresolved identity never attaches to an existing Case | FR-022, R2 |
| T-TEST-07 | Shared-channel authorisation | Without the elevated feature → 403; with it → success; per-user behaviour unchanged | R3 |
| T-TEST-08 | Inbox list at 300 open Cases | Query count under the declared ceiling | R5 |
| T-TEST-09 | Redelivered `ExternalMessage` | No second Case; `conversation_count` unchanged | R7 |
| T-TEST-10 | Mutation guards on all seven action routes | A denying guard blocks the mutation **and** `afterSuccessCallbacks` do not run | § API |
| T-TEST-11 | Encrypted lookup | `handle_value` unreadable at rest; lookup by hash returns the identity; duplicate rejected; hash present with encryption off | FR-016 |
| T-TEST-12 | Resolve → projection | `CustomerInteraction` appears; idempotent under replay; unresolved stages; cross-org stages | FR-017, FR-018, FR-027 |
| T-TEST-13 | Command undo round-trip | resolve/transfer/close/link restore prior state; send asserts its no-undo exemption | § Commands |
| T-TEST-14 | **Auto-responder loop** | A vacation-responder ping-pong opens at most one Case; other senders on the same channel are unaffected | **R1** |
| T-TEST-15 | Status machine | Every legal transition succeeds; every illegal one returns a field error; CRUD `PUT` cannot change status | FR-003, FR-024 |
| T-TEST-16 | Reopen | Inbound on a `resolved` Case reopens in place, clears `resolved_at`, writes a transition, increments `reopen_count`; a `closed` Case opens a new Case with `previous_case_id` | FR-006 |

UI (Playwright, headless): U1 login → inbox → reply · U2 resolve gate · U3 link from the rail ·
U4 list filter + status via action route · U5 Customer 360 tabs · U6 every empty state with a
working CTA · U7 two tabs edit one Case → conflict bar · U8 all five locales with no missing-key
placeholders.

## Migration & backward compatibility

Audited against all **14** surfaces in `BACKWARD_COMPATIBILITY.md` (`### 12. AI Agent, Tool, UI Part,
and Override IDs` at `:213` exists and is FROZEN; `om-pre-implement-spec`'s table says 13 and is
stale). Phase 1 declares no AI IDs, so #12 is n/a here.

Additive: new module and package IDs (1) · ten new event IDs (5) · four new spots + one declaration
(6) · new `/api/connect/*` namespace (7) · new tables only (8) · four new DI keys (9) · six new ACL
IDs (10) · new generated registry entries (14).

Changed: `SendMessageInput` and `SendAsUserActor` gain sender identity (3, STABLE), both in PR A,
with per-user callers byte-identical and T-TEST-07 asserting it.

**No ADDITIVE-ONLY (surface 8) violation.** The frozen spec's `senderUserId` relaxation is retracted.

## Definition of done (per slice)

- [ ] `node .ai/scripts/spec-gate-check.mjs all` exits 0, no HALT marker
- [ ] The slice's integration tests pass, self-contained, fixtures via API
- [ ] T-TEST-05 and T-TEST-06 pass — hard gate
- [ ] Validation gate green; record local or Docker mode
- [ ] `corepack yarn i18n:check-hardcoded` shows no new finding; all five locales complete
- [ ] Migrations + `.snapshot-open-mercato.json` committed; `db:migrate` NOT run
- [ ] PR labels per `.ai/docs/pr-workflow.md`; screenshots for UI slices

## Open questions

| # | Question | Blocks | Status |
|---|---|---|---|
| Q-D | PR C's facade must read `messages` rows whose sender is the system user and whose recipient list is empty, bypassing that module's sender-OR-recipient participant scope. Is that acceptable with the thread-id allowlist as the compensating control, or must PR C be reclassified **(e)** with a maintainer sign-off? | slice 1c | **OPEN — needs a maintainer** |
| Q1 | Does upstream PR A land this cycle? | slice 1c only | **OPEN** |
| Q3 | Baseline contact volume and the inbound/outbound split | no phase — SC-005 is what Phase 1 *produces* | OPEN by design. Only operator data closes it |

Q2 (the `senderUserId` sign-off) is **CLOSED — not required**; see the retraction.

## Changelog

| Date | Change |
|---|---|
| 2026-08-22 | v2 written whole after the merged spec drew 19 criticals from four blind reviewers. Owner decisions: `senderUserId` relaxation dropped (its justification was refuted against source), send becomes async delivery-status, ROI claim withdrawn and replaced with five measurable SCs, Phase 1 rewritten rather than narrowed. Structural repairs: explicit status-machine table replacing an arrow chain that forbade its own happy path; `escalated` dropped as unreachable in a queue-less phase; § Attach rule resolving the "same identity"/"open" ambiguity; thread ids taken from event payloads (the frozen spec left `connect` no path to one); the peer-read facade moved from `messages` to `communication_channels`, which owns the `direction` data a `messages` facade could not return; § Consistency added with a boundary per write path; manual-match queue, transition audit, link audit and metrics storage given tables, routes, screens and tests; `organization_id` made nullable to match peer rows; five locales in slice 1a; module registration, scheduler registration and test tasks added. |

# Adversarial spec review — DDD reviewer

**Role:** domain model, invariants, cardinality, formulas, glossary.
**Target:** `.ai/specs/2026-08-21-connect-phase-1-merged.md` (Mercato Connect Phase 1).
**Read:** the target spec, `CLAIMS-LEDGER-2026-08-21-connect-phase-1-merged.md`, source packages
`2026-08-21-connect-phase-1-one-inbox.md` and `app-spec-notes/frozen-surfaces.md`, plus platform
source under `packages/`. Peer reviewers' files were not read.
**Lens note:** every platform assertion below cites a file I opened in this session. Findings about
the spec's *internal* consistency cite spec line numbers.

---

## Critical

### C1 — The status machine is stated as a total linear chain, and `escalated` has no writer

**Location:** FR-003 (`:97-98`), T-DOM-01 (`:368`), `escalation_reason` (`:245`), § API contracts
table (`:285-295`).

**Defect.** FR-003 reads *"Status MUST progress `new → in_progress → waiting_customer → escalated →
resolved → closed`"*. As a normative statement that is a **total order**: it forbids
`new → in_progress → resolved` (the overwhelmingly common path), forbids `new → resolved`, and makes
`escalated` a mandatory station on the way to `resolved`. Nothing in the document says `escalated` is
orthogonal, nothing says which transitions are optional, and **the legal transition set is never
enumerated anywhere** — yet T-DOM-01 must "reject illegal transitions with a field error". The
implementer has to invent the relation that FR-003 was supposed to fix.

Compounding it: `escalated` has no write path at all. There is no `/escalate` route in the API table
(`:285-295`); T-CMD-01 (`:395`) lists `resolve/transfer/close/reopen/link/unlink` and no escalate
command; and the frozen ten event IDs contain no `connect.case.escalated`
(`app-spec-notes/frozen-surfaces.md:46-49`). `escalation_reason` (`:245`) therefore ships as a column
with no writer, while FR-003 makes the state it explains mandatory. Every other FR "names the task
that performs its write" (`:90`); this one names a station nothing can reach.

Symmetrically, `connect.case.assigned` is a frozen event ID with no assign route.

**Fix.** Replace the arrow chain with an explicit transition table — rows = from-state, columns =
to-state, cells = the actor class (`agent` / `system` / `customer-triggered`) and the route or
worker that performs it. Declare `escalated` **orthogonal** to the working states
(`in_progress`/`waiting_customer` ↔ `escalated`) rather than on the linear path, and either add
`POST /api/connect/cases/{id}/escalate` + the eleventh event ID before the frozen list closes, or
cut `escalated` and `escalation_reason` from Phase 1 entirely (queues and SLA are already out of
scope, and escalation without a routing target is a status change with no consequence). Whichever
you pick, state which transitions the *system* performs unattended: `in_progress → waiting_customer`
on send (implied only by FR-011's negation), `waiting_customer → in_progress` on inbound (never
stated at all), `resolved → closed` by the worker (FR-005).

---

### C2 — Reopen produces a Case that is simultaneously resolved and open

**Location:** FR-006 (`:102-103`), FR-004 (`:99`), T-API-06 (`:391`), `connect_cases` columns
(`:242-245`), FR-019 (`:134`).

**Defect.** FR-006 says a resolved Case "MUST be reopenable **in place**". "In place" fixes the row
identity and nothing else. The spec never declares:

1. **the target status** of a reopen (`new`? `in_progress`? the pre-resolve status?);
2. **what happens to `resolved_at`** — a scalar column (`:243`);
3. **what happens to `wrap_up_note`** — which FR-004 makes a precondition of `resolved` (`:99`).

Leave them and you get an illegal state the spec has no vocabulary for: a Case with
`status='in_progress'` **and** `resolved_at IS NOT NULL` **and** a populated `wrap_up_note`. Every
predicate that identifies a resolved Case now disagrees with every other one. Null them and the
first resolution is destroyed — `resolved_at` is single-valued, so a Case resolved on Monday,
reopened Tuesday and resolved Thursday is indistinguishable from one resolved only on Thursday. That
directly breaks FR-019's "cases … resolved" counting (see M3) and FR-004's audit value.

**Fix.** State the reopen post-condition as an invariant: reopen MUST set `status` to a declared
value (recommend `in_progress`, assignee retained), MUST null `resolved_at`, and MUST move
`wrap_up_note`/`wrap_up_seconds`/`resolved_at` into the `connect_case_reopens` row before nulling
them — i.e. make `connect_case_reopens` a **resolution-episode history**, not just a reopen
audit stamp (`{ case_id, resolved_at, resolved_by, wrap_up_note, wrap_up_seconds, reopened_at,
reopened_by, reason }`). Then define "resolved" in FR-019 over that table, not over the column.

---

### C3 — "the same identity" (FR-001) is undefined, and under the declared unique index it defeats the module's own justification

**Location:** FR-001 (`:93-94`), `connect_contact_identities` unique index (`:258-260`), Provenance
repair 1 (`:29-41`), § UI (`:321-323`), R2 (`:346`).

**Defect.** FR-001's attach rule keys on "an open Case for the **same identity**". Two words, both
undefined:

- **"open"** is not a value of the status enum (`new|in_progress|waiting_customer|escalated|
  resolved|closed`, `frozen-surfaces.md:134-135`). Is `escalated` open? Is `resolved`? FR-005's
  auto-close ("after `auto_close_after_days` **with no inbound**") implies inbound *does* land on
  resolved Cases, so `resolved` is at least partially open — but then FR-004's wrap-up gate has
  already fired and the customer's reply sits on a Case no agent queue shows.
- **"identity"** is ambiguous between the `connect_contact_identity` **row** and the
  `customer_entity_id` it points at. Both readings break:
  - **Row reading.** The declared uniqueness is a partial index on
    `(tenant_id, channel_id, handle_type, handle_value_hash)` (`:258-259`) — **channel-scoped**. The
    same person is therefore a *different identity row* on the Gmail channel and the IMAP channel,
    and (in later phases) on WhatsApp vs phone. Attach-by-row can only ever group **within one
    channel** — which is precisely the property the merged spec spent its Provenance repair 1
    (`:29-41`) rejecting in package A, and precisely what § UI promises it fixes ("a phone→WhatsApp
    Case must not appear twice", `:322`). Moving the aggregate out of `messages` bought a table that
    *could* group cross-channel; FR-001's key then re-imposes the channel scope A was faulted for.
  - **Customer reading.** `customer_entity_id` is nullable until resolved (`:240`), and FR-014
    mandates that sub-threshold handles link **nothing** (`:121-122`). Under SQL semantics an
    unresolved handle has `customer_entity_id = NULL`; a naive "same customer" attach predicate
    either matches every unresolved sender to every other (two strangers' mail merged into one Case
    — R2's Critical exposure through a door R2 does not cover) or matches none, leaving unresolved
    traffic with no attach behaviour at all.

Note that source package B's attach rule carried the qualifier the merge dropped: attach happens
"within `case_attach_window_minutes` **on a resolved identity**"
(`2026-08-21-connect-phase-1-one-inbox.md:404`). The merged FR-001 lost it.

**Fix.** Add a glossary entry defining both terms, and split the identity key from the attach key:

- Define `open` explicitly as a named predicate (`status NOT IN ('resolved','closed')`) and use that
  literal wording in FR-001, FR-005 and the interceptor.
- Introduce the missing aggregate level: a **contact** (`connect_contacts`, or reuse
  `customer_entity_id` once resolved) that owns N `connect_contact_identity` rows across channels.
  Attach on the contact; keep the per-channel unique index for the handle rows. Without that level,
  the cross-channel Case is a claim with no key.
- State the unresolved case explicitly: an unresolved handle attaches **only** to a Case whose set of
  conversations already contains that exact identity row — never on a null-customer match.

---

### C4 — No transaction or consistency boundary is assigned to any Case↔Conversation invariant; `conversation_count` is the visible casualty

**Location:** § Aggregates (`:148-159`), R6 (`:350`), R7 (`:351`), FR-007 (`:104-105`), FR-008
(`:108-109`), T-ING-01 (`:376`), T-TEST-09 (`:421`).

**Defect.** The spec asserts `connect_case` is "the unit of work" (`:151`) but never names a
transaction anywhere in the document. The only mention of transactional scope is inside a **risk-row
mitigation** — R6's "maintained in the same transaction as attach/detach" — which is not a
requirement, has no FR, and is not testable as written. Meanwhile two write paths touch the
aggregate under **different concurrency models**:

| Path | Writer | Concurrency control |
|---|---|---|
| attach / detach, `last_inbound_at`, `conversation_count` | `subscribers/ingest-inbound.ts`, persistent (T-ING-01) | none declared |
| resolve / close / reopen / transfer / status | API commands | optimistic lock on `connect_cases.updated_at` (FR-007, `:236`) |

Four concrete consequences:

1. **Lost update on concurrent attach.** `conversation_count` is a stored scalar (`:242`). Two
   inbound messages arriving on two channels for the same Case run two subscriber instances; a
   read-modify-write increment loses one. The count is also **fully derivable** —
   `count(*) FROM connect_conversations WHERE case_id = ? AND deleted_at IS NULL` — so the spec is
   paying a drift risk (R6, severity High, declared "Phase 2's FCR input") for a value it does not
   need to store.
2. **R7's idempotency mechanism contradicts R6's transaction.** R7 mandates "attempt the insert and
   let the unique index arbitrate, catching the violation" (`:351`). In PostgreSQL a unique
   violation aborts the enclosing transaction; you cannot catch 23505 and continue the *same*
   transaction without a `SAVEPOINT`. So "increment in the same transaction as the attach" and
   "catch the 23505 and resolve to the existing row" cannot both be implemented as written, and
   T-TEST-09's "`conversation_count` unchanged" is exactly the assertion that fails.
3. **A subscriber cannot honour FR-007.** FR-007 says the later writer receives **409**. A
   background subscriber has no client-supplied version and no HTTP response. So either the
   subscriber bypasses the lock the spec calls default-ON, or agent actions 409 whenever a customer
   emails — because `updated_at` has `onUpdate: () => new Date()` and any Case-row write bumps the
   version that the Inbox pane is holding. With `conversation_count` living on `connect_cases`,
   **every inbound attach invalidates the agent's open editor.** T-API-04 even codifies this ("409
   when raced by a new Case event", `:389`) without noticing it is a self-inflicted wound created by
   denormalising a peer-driven counter onto the locked aggregate.
4. **FR-008's "exactly one parent Case" and FR-011's cross-row rule** span two tables
   (`connect_cases.status` and `connect_conversations.first_human_outbound_at`) with no stated
   atomicity, and the peer send happens outside any transaction.

**Fix.**
- Delete the stored `conversation_count`; derive it in the list projection / query index. If a stored
  counter is genuinely required for Phase 2 FCR, put it on a **separate row** that is not the
  optimistic-lock target (a `connect_case_counters` sibling), write it with `UPDATE … SET c = c + 1`
  (atomic, no read-modify-write), and keep the baseline job's reconciliation.
- Add a § Consistency subsection stating, per invariant, the transaction that enforces it and the
  writer: attach + counters (subscriber, one `withAtomicFlush({ transaction: true })`), status +
  wrap-up (command, optimistic lock), send stamping (post-provider, see C5).
- State explicitly that **system/subscriber writes are exempt from optimistic locking** and that the
  Case's lock version must not be bumped by peer-driven columns — or move those columns off
  `connect_cases`.

---

### C5 — FR-010 treats a timeout as a rejection; FR-011 then mandates the wrong state for an indeterminate send

**Location:** FR-010 (`:112-113`), FR-011 (`:114-115`), `first_human_outbound_at` (`:250-251`),
T-API-07 (`:388`), T-TEST-04 (`:416`).

**Defect.** FR-010: *"Outbound provider calls MUST carry an explicit timeout (default 15 s);
**expiry maps to the same 422 path as a provider rejection**, naming the channel and preserving the
draft."* A rejection is a *known negative*. A timeout is **indeterminate** — the SMTP/Gmail call may
have delivered the message. FR-011 then makes the indeterminate case indistinguishable from failure:
no `first_human_outbound_at`, no advance to `waiting_customer`, draft preserved, retry offered. The
predictable result is a **double reply to the customer**, with Connect's own state saying nothing was
sent. FR-019 asks Phase 1 to count "duplicate-reply candidates" (`:135`) — the spec builds the
generator of duplicate replies in FR-010 and counts them in FR-019 without ever connecting the two.

Second defect in the same pair: **`first_human_outbound_at` has no positive writer.** The data model
says "written once, never updated" (`:251`); FR-011 says when it must *not* be written; no FR, no
task and no route says **who writes it, on which event** (request accepted by the adapter? provider
ack? delivery receipt?). `human_agent_message_count` (`:250`) has no writer at all. An invariant
("written once") stated without its writer is not enforceable, and the merge made it worse by
dropping the one Phase-1 consumer this field had — package B's metrics endpoint listed
"**first-response times**" (`2026-08-21-connect-phase-1-one-inbox.md:261`), which the merged FR-019
replaced with "inbound/outbound timestamps". As merged, `first_human_outbound_at` is a protected
field with no reader and no writer.

**Fix.**
- Give the send a third outcome. Model `connect_conversations`/the outbound record with
  `send_state ∈ {pending, sent, failed, indeterminate}`. Map provider rejection → `failed` (422,
  retry offered); timeout → `indeterminate` (surface as "delivery unconfirmed", **retry disabled by
  default**, reconciled by the next inbound poll matching the provider message id). Restate FR-011 as
  a testable invariant: `first_human_outbound_at IS NOT NULL ⟺ ∃ an outbound record in state
  'sent'`, and `status = 'waiting_customer' ⟹ first_human_outbound_at IS NOT NULL`.
- Add the positive writer to an FR and a task, naming the event that stamps it, and either restore
  first-response time to FR-019 or delete the field from Phase 1.

---

## Major

### M1 — FR-013 mandates recording a "match method" that has nowhere to go

**Location:** FR-013 (`:119-120`) vs `connect_contact_identities` (`:255-257`).

FR-013: handles "MUST resolve to a `CustomerEntity` with a recorded **confidence and match
method**". The declared columns are `handle_type · handle_value · handle_value_hash ·
customer_entity_id · link_state · confidence · channel_id · unlinked_at/unlink_reason ·
first_seen_at/last_seen_at`. There is no `match_method`. This is a clean merge seam: the FR came from
package A, the table from package B (`2026-08-21-connect-phase-1-one-inbox.md:213-221`, which also
lacks it), and nobody reconciled them. T-ING-03 (`:378`) is the named writer and has no column to
write to.

**Fix.** Add `match_method text NOT NULL` with an enumerated domain (`exact_email_hash`,
`normalized_phone_e164`, `manual`, `none`) to `connect_contact_identities`, and state that
`link_state='unresolved' ⟹ match_method='none' ∧ customer_entity_id IS NULL`.

### M2 — FR-015's "audited" and "reversible" are unsatisfiable with the declared columns, and the unlink post-condition is undefined

**Location:** FR-015 (`:123`), `unlinked_at`/`unlink_reason` (`:257`), R2 (`:346`), T-API-08
(`:392`).

Two holes. (a) The spec never says **what happens to `customer_entity_id` on unlink**. Retain it and
`link_state='unlinked'` becomes a trap: any query that filters `customer_entity_id = X` without also
filtering `link_state <> 'unlinked'` re-associates a repudiated handle with a customer — R2's
Critical "wrong identity link exposes another customer's orders" through the *unlink* path R2 does
not mention. Null it and the audit is gone. (b) `unlinked_at`/`unlink_reason` are **scalar columns**;
a handle that is linked → unlinked → relinked → unlinked overwrites its own history, so "audited" is
satisfied for exactly one event. The command bus does persist an `ActionLog` with `actorUserId`
(`packages/shared/src/lib/commands/command-bus.ts:298`, `:325`), which helps — but the spec relies on
that nowhere and the domain state itself remains single-valued.

**Fix.** State the post-condition (`unlink ⟹ customer_entity_id := NULL ∧ link_state := 'unlinked'`,
with the previous value preserved in history) and add `connect_identity_link_events`
(`identity_id, from_customer_entity_id, to_customer_entity_id, action, actor_user_id, reason,
occurred_at`) — the same shape as `connect_case_reopens`. Add a test asserting that no query path
returns an `unlinked` identity as a customer association.

### M3 — FR-019's counting layer has no storage, no period, no timezone, and its "resolved" count is unreconstructible and gameable

**Location:** FR-019 (`:134-135`), `GET /api/connect/metrics/baseline` (`:295`), T-MET-01 (`:403`),
Q3 (`:452`), § Data model (`:233-263`).

- **No storage.** T-MET-01 is a **worker** (`workers/baseline-metrics.ts`) and the endpoint is a
  **GET**. § Data model declares no metrics table. Either the worker writes somewhere undeclared or
  the route computes live and the worker is redundant. Undecided.
- **No denominator, period or timezone.** "cases opened/resolved" is a count with no bucket. Buckets
  require a tenant timezone; `connect_tenant_settings` (`:262`) declares none, and the spec never
  references the platform's date-locale settings. "Cases opened today" is unimplementable as written.
- **Not reconstructible, and gameable.** Per C2, `resolved_at` is a single overwritten column while
  reopens live in a separate table. A Case resolved → reopened → resolved contributes **1** to
  "opened" and, depending on the query, either 1 or 2 to "resolved" — so resolution rate can exceed
  100%, or a genuine re-resolution can vanish. An agent who resolves early and reopens on the
  customer's reply moves the number in whichever direction the query happens to pick. This is the
  headline number of a service-desk module and it has no formula.
- **One listed item is not a metric.** "inbound/outbound timestamps" are already columns on
  `connect_conversations` (`:251-252`). Listing state as measurement leaves Q3 (`:452` — "baseline
  contact volume and the inbound/outbound split … is what Phase 1 *measures*") with **no metric in
  FR-019 that answers it**: no volume-per-period, no split ratio.

**Fix.** Write the formulas out, each as `numerator / denominator over [t0, t1) in tenant timezone`,
citing the source table:
`cases_opened = |{ c : c.created_at ∈ window }|`;
`resolutions = |{ r ∈ connect_case_reopens_history : r.resolved_at ∈ window }|` (per C2's history
table, so re-resolutions count honestly);
`reopen_rate = |reopens in window| / |resolutions in window|`;
`first_response_seconds = percentile(first_human_outbound_at − first_inbound_at)` (restores the C5
field's reader);
`inbound_outbound_split = |inbound msgs| : |outbound msgs|` (answers Q3).
Add a `tenant_timezone` column to `connect_tenant_settings`, and declare the storage: either a
`connect_metric_daily` rollup table written by T-MET-01, or drop the worker and make the route
compute live over a bounded window.

### M4 — "duplicate-reply candidates" is undefined and collides with the `possible_duplicate` case tag, which no FR or task owns

**Location:** FR-019 (`:135`), T-TEST-02 (`:414`), `connect_case_tags` (`:262`).

FR-019 requires shipping "duplicate-reply candidates". The term appears once, is never defined, and
no task computes it. Separately, T-TEST-02 asserts a behaviour — a second inbound outside the attach
window "opens a new Case tagged `possible_duplicate`" — that **no FR requires** and **no task
writes**: FR-001 (`:93-94`) says nothing about tagging, and no slice-1b task creates or applies the
tag (the tag dictionary appears only as a table name at `:262`). The spec's own contract is that
"each names the task that performs its write" (`:90`). So the document has one undefined metric and
one untraced write, with confusably similar names denoting different things (a duplicate *reply* is
an outbound artefact — per C5, the thing FR-010's timeout handling produces; a duplicate *case* is an
ingest artefact).

**Fix.** Define both: `duplicate_reply_candidate` = two outbound messages on the same conversation
within N seconds with ≥X% body similarity, or two sends sharing one draft id (state N and X). Add an
FR for the `possible_duplicate` tag with a named task, and seed the tag in `setup.ts`
`seedDefaults`. Rename one of the two so they cannot be confused in the metrics UI.

### M5 — `organization_id NOT NULL` on every `connect` table cannot be satisfied from the peer rows the aggregate binds to

**Location:** § Data model (`:235-236`), FR-008 (`:108-109`), FR-020 (`:138-139`), T-ING-01
(`:376`).

The spec mandates `organization_id uuid NOT NULL` on all `connect` tables and FR-020 requires every
row scoped to tenant **and** organisation. But **every** `organization_id` in
`packages/core/src/modules/communication_channels/data/entities.ts` is `nullable: true` — `:162`
(`CommunicationChannel`), `:209` (`ExternalConversation`), `:255` (`ExternalMessage`), `:313`,
`:355` (`ChannelThreadMapping`), `:416`, `:460`, `:518` — and the ingest command writes
`organizationId: input.scope.organizationId ?? null` when creating the conversation
(`packages/core/src/modules/communication_channels/commands/ingest-inbound-message.ts:201`, `:213`).
A tenant-scoped shared mailbox (exactly the Phase-1 target per Provenance repair 2, `:42-46`) can
therefore produce an `ExternalConversation` with a null organisation, and FR-008's 1:1 binding then
has no organisation to write into `connect_conversations`/`connect_cases`.

**Fix.** Declare the rule at the boundary: name the deterministic source of `organization_id` for an
inbound message on a tenant-scoped channel (the channel's org, else the tenant's default/primary
org, else a declared fallback), state it as an ingest invariant, and add a test for a channel with
`organization_id IS NULL`. If no such source exists, make `connect_conversations.organization_id`
nullable and say so — but then FR-020's "every row scoped to … organisation" needs the exemption
written down.

### M6 — The state machine is bypassable through the generic CRUD update route

**Location:** § API contracts (`:285`, `GET/POST/PUT/DELETE /api/connect/cases`), `:299-302`,
T-DOM-01 (`:368`), T-VAL-01 (`:373`), UI check U4 (`:428`).

`status` is a column on the CRUD entity and `PUT /api/connect/cases` is `makeCrudRoute`. T-DOM-01
puts the machine in `lib/case-state.ts` — a pure module — and no requirement pins it to the CRUD
update path. Zod validators (T-VAL-01) **cannot** express transition legality: they validate the
payload, never the prior value. The UI check U4 explicitly exercises "list filter + **inline status**"
— i.e. the bypass path is the one the product ships. Result: FR-003's invariant holds on the six
action routes and not on the route the agents use most.

**Fix.** Either remove `status` from the CRUD update schema entirely (status changes only via action
endpoints — add `POST /cases/{id}/status` if inline advance must ship), or state that the CRUD
route's `CrudHooks.beforeUpdate` MUST load the current status and call `assertTransition(from, to)`,
and add an integration test asserting a rejected illegal transition **through `PUT`**, not just
through the lib's unit tests.

### M7 — `case_value_minor` is a monetary amount with no currency

**Location:** `connect_cases` (`:242`), source note "from the linked order/return"
(`2026-08-21-connect-phase-1-one-inbox.md:192`).

Every money-bearing entity in `sales` carries a currency alongside the amount —
`packages/core/src/modules/sales/data/entities.ts:373-374`, `:625-626`, `:873-874` all declare
`currency_code`. `case_value_minor` is a bare integer. Once a tenant sells in more than one currency
the column is uninterpretable, and any Phase-2 aggregate over it (case value by queue, cost-to-serve)
silently sums PLN into EUR. The platform ships a `currencies` module precisely to prevent this.

**Fix.** Add `case_value_currency text` (snapshotted from the source order/return alongside the
amount, per the platform's FK-id + snapshot rule), or drop `case_value_minor` from Phase 1 — nothing
in Phase 1 reads it, and shipping it without a currency guarantees a data migration later, which is
the exact cost the "ship now to avoid a later migration" rationale (`:244-245`) is trying to avoid.

### M8 — Auto-close and reopen windows have no ordering invariant, and "no inbound" is measured on the wrong table

**Location:** FR-005 (`:100-101`), FR-006 (`:102-103`), T-WRK-01 (`:394`), `connect_tenant_settings`
(`:262`), `connect_conversations.last_inbound_at` (`:252`).

(a) `auto_close_after_days` and `reopen_window_days` are independent settings with no declared
relation. If `auto_close_after_days < reopen_window_days`, a Case inside its reopen window is already
`closed` — and FR-006 grants reopen only to a **resolved** Case, so the reopen route is unreachable
for exactly the Cases whose window is still open. If the reverse, a Case sits `resolved` past its
reopen window, reopenable-by-status but forbidden-by-window, with no declared error. Neither branch
is specified.

(b) FR-005 closes after N days "**with no inbound**". Inbound timestamps live on
`connect_conversations.last_inbound_at` — **per conversation** — while the worker closes **Cases**.
The predicate is therefore `max(last_inbound_at) over the Case's conversations`, which the spec never
states, and which is a join the worker must perform per candidate row.

**Fix.** Declare the invariant `reopen_window_days ≤ auto_close_after_days` and validate it in the
settings PUT (422 otherwise), or extend FR-006 to cover `closed` Cases within the reopen window.
Write FR-005's predicate explicitly:
`status='resolved' ∧ max(conv.last_inbound_at) < now() − auto_close_after_days`, and say what an
inbound on a resolved Case does to `status` (see C1/C3 — currently: nothing, silently).

### M9 — FR-017's projection can fail on a legitimately-linked cross-organisation customer

**Location:** FR-017 (`:128`), FR-018 (`:129-133`), T-PROJ-01 (`:399`), `customer_entity_id`
(`:240`).

`customers.interactions.create` resolves the parent entity and then derives **the entity's** tenant
and organisation, asserting the caller's scope against them:
`packages/core/src/modules/customers/commands/interactions.ts:385` (`requireTimelineParentEntity`)
and `:387` (`ensureOrganizationScope(ctx, entity.organizationId)`), inside a forked EM (`:382`). The
interaction row is written with `entity.organizationId`, not the Case's. Nothing in the spec requires
`connect_case.customer_entity_id` to point at a CustomerEntity in the **Case's own organisation** —
identity resolution (FR-013) keys on a channel handle, and the handle's owner may legitimately be a
customer record in a sibling organisation of the same tenant. When that happens FR-017 throws at
resolve time, on a path the spec models as always-succeeding (FR-018 stages only for *unresolved*
identities, `:129-130`).

**Fix.** State the invariant: `customer_entity_id` MUST resolve to a CustomerEntity in the Case's
`(tenant_id, organization_id)`; identity resolution MUST reject (→ `link_state='unresolved'` +
manual-match task) a candidate outside that scope. Add the cross-org case to T-TEST-12 alongside the
unresolved case.

---

## Minor

### m1 — FR-001 and FR-012 contradict as universally-quantified statements

FR-001 (`:93`): "An inbound message MUST become exactly one Case, or attach…". FR-012 (`:116`):
"Auto-responder and bounce traffic MUST NOT open a Case." No exemption clause links them; read
literally, an auto-responder message must and must not produce a Case.
**Fix:** "An inbound message **not suppressed under FR-012** MUST become exactly one Case, or attach…".

### m2 — FR-012's suppression is connect-local and does not suppress display

The `ExternalMessage` is written by the peer ingest command before `connect`'s subscriber runs, so a
bounce still exists in `communication_channels` and will render in the Case thread through the
`messagesThreadReader` facade (`:171-175`). T-TEST-03 (`:415`) asserts only "no Case created", which
will pass while the agent still sees the DSN in the thread of an unrelated Case.
**Fix:** state whether suppressed traffic is hidden, collapsed or shown as `sys`, and assert it in
T-TEST-03.

### m3 — Threshold comparison, `confidence` units, and the settings shape are underspecified on a Critical safety gate

FR-014 (`:121-122`) says "**Below** the per-`handle_type` threshold" while R2 (`:346`) calls it
"Sub-threshold" — the boundary case (`confidence == threshold`) is undefined on the gate that R2
rates Critical. `confidence` has no declared range or meaning, and no rule says what a human
`verified` link writes into it, so a later re-ingest compares a machine score against a
human-authored value. § Data model calls `connect_tenant_settings` "typed columns, not key/value"
(`:262`) while the thresholds are a **per-`handle_type` map** over a 7-value enum — the two cannot
both hold without either seven columns or a typed JSON column.
**Fix:** define `confidence ∈ [0,1]`; state `link ⟺ confidence >= threshold`; state that
`link_state='verified'` sets `confidence = 1.0` and short-circuits re-scoring; declare the settings
shape as a typed JSONB column with a zod schema keyed by the handle-type enum.

### m4 — The Phase-1 nulls have no enforcement and mis-price their own rationale

`service_queue_id` is "always null in Phase 1" (`:82-83`, `:239-240`) with no CHECK constraint, no
statement that the zod create/update schema omits it, and no test. `merged_into_case_id` /
`split_from_case_id` ship unused (`:244-245`) with no invariant: a non-null `merged_into_case_id`
semantically makes a Case a tombstone, and every Phase-1 list query, the FR-022 interceptor and the
FR-019 counts are written with no exclusion for it — so Phase 2's merge feature will have to revisit
all of them anyway. The stated rationale ("avoid a later migration on a hot table") prices the
`ALTER TABLE`, which is the cheap part.
**Fix:** omit `service_queue_id` from the validators and assert `IS NULL` in T-TEST-01; either drop
the merge/split columns or write the tombstone invariant now (`merged_into_case_id IS NOT NULL ⟹
excluded from every list, count and interceptor result`) so Phase-1 queries are forward-compatible.

### m5 — Derived counters with no writer and no reconciliation

`human_agent_message_count` (`:250`) and `wrap_up_seconds` (`:242`) appear only in the column list:
no FR, no task, no definition (is `wrap_up_seconds` agent-measured, or clock time from first touch to
resolve?). R6's drift mitigation (`:350`) covers `conversation_count` only, so the second denormalised
counter has no reconciliation at all.
**Fix:** name the writer and the formula for each, or cut them from Phase 1 (both are derivable —
message count from the thread reader, wrap-up duration from `first_agent_touch_at`/`resolved_at`).

### m6 — `/metrics/baseline` guarded by `connect.cases.view.all` conflates a row-scope grant with an analytics grant

The drift resolution (`:310-314`) guards the metrics endpoint with `connect.cases.view.all` "until
`connect_analytics` ships". That feature's declared job is row-scope narrowing (FR-022, `:142-143`) —
a team lead granted it to see the team's Cases silently also gets tenant-wide analytics, and when
`connect_analytics.view` ships the grant **narrows**, which is a behaviour change on the FROZEN ACL
surface (`frozen-surfaces.md:63-70`).
**Fix:** guard it with `connect.settings.manage` (already admin-level, no later narrowing), or accept
a seventh Phase-1 ACL ID and amend `frozen-surfaces.md` before the list freezes.

### m7 — `external_conversation_id` is an overloaded column name and the merge dropped the types that disambiguated it

In the platform the identical column name means two different things:
`ExternalConversation.external_conversation_id` is the **provider's text thread ref**
(`packages/core/src/modules/communication_channels/data/entities.ts:191-192`), while
`ChannelThreadMapping.external_conversation_id` is a **uuid FK to `ExternalConversation.id`**
(`:332-333`). Source package B declared `connect_conversations.external_conversation_id uuid NOT NULL`
(`2026-08-21-connect-phase-1-one-inbox.md:207`); the merged spec dropped the types (`:249-253`),
leaving the unique key `(tenant_id, external_conversation_id)` ambiguous. Under the text reading the
key is **wrong**: `ExternalConversation` is unique on `(channel_id, external_conversation_id)`
(`:177-181`), so the same provider thread ref legitimately exists on two channels and the connect
unique would reject the second.
**Fix:** restore the type and say which id it is — `external_conversation_id uuid NOT NULL
(→ ExternalConversation.id)` — and add the glossary entry distinguishing "external conversation id
(uuid, platform row)" from "provider thread ref (text)".

---

## Note on the aggregate question, stated directly

The spec asserts the Case is "the unit of work" (`:151`) and defends the choice well against package
A's `messages`-keyed alternative. But an aggregate root is defined by the invariants it enforces
transactionally, and after C1–C5 the honest position is: **`connect_case` is currently a grouping
table, not a consistency boundary.** It has no declared transaction, its counters are written by a
peer-driven subscriber outside its own lock, its status machine is enumerable only by inference and
bypassable through CRUD, and two of its three cross-row invariants (`first_human_outbound_at` ⟷
`status`, `conversation_count` ⟷ conversation rows) name no enforcer. Repairing that is a § Consistency
subsection and a transition table — roughly a page of spec — not a redesign. It should be written
before Gate 1 closes, because every one of these choices lands in a migration.

FINDINGS: 5C/9M/7m

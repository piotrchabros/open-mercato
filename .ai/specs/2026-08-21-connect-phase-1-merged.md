# Mercato Connect — Phase 1: One Inbox (merged spec)

| Field | Value |
|---|---|
| **Date** | 2026-08-21 |
| **Status** | **Proposed — Gate 1 UNGATED. Do not start coding until the claims ledger is verified by a non-author.** See § Readiness |
| **Scope** | OSS |
| **Supersedes** | the Phase-1 slices of both source packages (below) for implementation purposes |
| **Module(s)** | new `packages/connect`; new `packages/channel-webform`; additive upstream changes to `communication_channels`, `customers`, `sales` |
| **Method** | [`.ai/docs/spec-pipeline-runbook.md`](../docs/spec-pipeline-runbook.md) |
| **Evidence** | [`ANALYSIS-054`](analysis/ANALYSIS-054-2026-08-21-spec-approach-comparison.md) |

## Provenance

Two independently-produced packages specified this product from the same design prototype. Both
scored ~37/50 with inverted failure modes. This document carries forward the parts that survived
verification, and repairs the two defects that would have broken implementation.

| Layer | From | Why |
|---|---|---|
| Slice definition, aggregate model, upstream PR sequencing, encryption | **B** — [`connect-phase-1-one-inbox`](2026-08-21-connect-phase-1-one-inbox.md) | Ships on adapters that already exist; its acceptance scenarios are satisfiable inside the slice |
| Numbered requirements, peer-read facade contract, task discipline, tenancy gate | **A** — [`mercato-connect-omnichannel`](2026-08-21-mercato-connect-omnichannel.md) | 100 traceable FRs and a file-pathed task graph; the facade contract is the best boundary artifact in either package |
| Frozen surfaces | **B** — [`frozen-surfaces.md`](app-spec-notes/frozen-surfaces.md) | Authoritative; covers all 14 BC surfaces |
| Test matrix | union | B's negative paths, A's tenancy and never-auto-send gates |

**Two repairs this document makes.** Both are verified against source, not inherited from either
package's self-assessment.

1. **The cross-channel aggregate moves out of `messages`.** A keyed `ServiceConversation` on
   `messages.Message.thread_id`, on the premise that *"the cross-channel primitive already exists
   and is unused at the product level… the unified thread is an aggregation problem, not a storage
   one."* The schema permits N external conversations per thread id — `channel_thread_mappings` is
   unique on `(external_conversation_id, tenant_id)`, and `messageThreadId` carries only an index —
   but **nothing in the platform ever produces that state**. Every strategy in
   `communication_channels/lib/thread-matcher.ts` filters by `channelId` (`:110`, `:128`, `:150`,
   `:174`), and `commands/ingest-inbound-message.ts:402` writes
   `messageThreadId: message.threadId ?? message.id` seeded from that channel-scoped match. To
   unify two channels, `conversations` would have to **write** a peer module's table — which A's own
   read-only facade contract forbids (`peer-read-facades.md` P-06). A's P1 therefore had no
   mechanism for its own headline feature. **This spec uses B's model instead**: `connect_case` owns
   the grouping in `connect`'s own table, and no peer write is required.
2. **The reply path is a blocking upstream dependency, not a one-liner.**
   `communication_channels/lib/send-as-user.ts:101-103` returns **403 "You can only send through
   channels you own"** when `channel.userId !== actor.userId`. A contact centre works shared
   mailboxes. A's task called `ChannelAdapter.sendMessage` directly, bypassing both that gate and
   `guardOutboundCreate`. **Upstream PR A below is blocking** and must merge first.

## Readiness

| Gate | State |
|---|---|
| Gate 1 — claims ledger | ⚠️ **UNGATED.** The platform claims in this document were verified against source, but by the same agent that wrote them. A different agent must re-run `om-verify-spec-claims` before coding. |
| Gate 2 — core-edit ledger | ✅ present, § Core-edit ledger |
| Gate 3 — frozen surfaces | ✅ deferred to [`frozen-surfaces.md`](app-spec-notes/frozen-surfaces.md), with the two drifts below reconciled |
| Write-path test | ✅ every FR below names the task that performs its write |
| Adversarial review | ⬜ not run on this merged document |

Run `node .ai/scripts/spec-gate-check.mjs all` against
`.ai/analysis/spec-pipeline/gate-state.json` for the machine-checkable position.

## TLDR

Replace a shared support mailbox with a real service desk. Every inbound e-mail and web-form
submission becomes a **Case** with one owner, one status and one thread; the agent replies from a
three-pane Inbox with the customer's orders on screen; resolving writes a note and projects an
interaction onto the Customer 360 timeline.

No SLA clock, no queues, no routing, no AI, no bots, no portal. Phase 1 proves the Case aggregate,
the hub binding and the `customers` projection contract on **channel adapters that already ship**
(`channel-gmail`, `channel-imap`), so nothing waits on a new provider integration.

## Scope

**In.** Case + Conversation + contact-identity aggregates · inbound ingest with auto-responder and
bounce suppression · identity resolution with per-`handle_type` thresholds · attach-window rule ·
three-pane Inbox · cross-channel-capable reply on connected channels · resolve with wrap-up ·
close and reopen · transfer · Cases list and detail · Customer 360 · projection to
`CustomerInteraction` · `channel-webform` · baseline counting layer.

**Out, deliberately.** SLA clocks · service queues, presence, routing offers · AI suggestions,
summaries, wrap-up drafts · bots and intents · the customer portal · campaigns · quality review.
`connect_case.service_queue_id` is nullable and **always null in Phase 1**; queues are absent
entirely, not stubbed — a stub would imply routing that does not exist.

**Partially satisfied by design.** The product names nine channel types. Phase 1 supports e-mail
(Gmail/IMAP) and web form. Say so in the release note rather than implying omnichannel coverage.

## Requirements

Numbered for traceability; each names the task that performs its write.

### Case lifecycle
- **FR-001** An inbound message MUST become exactly one Case, or attach to an open Case for the
  same identity within `case_attach_window_minutes`. → T-ING-01, T-ING-04
- **FR-002** A Case MUST carry number, subject, customer, originating channel, owner (or an
  explicit unassigned state), priority and status. → T-DATA-01
- **FR-003** Status MUST progress `new → in_progress → waiting_customer → escalated → resolved →
  closed`, and every transition MUST record actor and time. → T-DOM-01
- **FR-004** A Case MUST NOT reach `resolved` with an empty wrap-up note. → T-API-04
- **FR-005** `resolved → closed` MUST happen by explicit action or by the auto-close job after
  `auto_close_after_days` with no inbound. → T-API-05, T-WRK-01
- **FR-006** A resolved Case MUST be reopenable in place within `reopen_window_days`, writing a
  `connect_case_reopen` row. → T-API-06
- **FR-007** Concurrent edits MUST NOT silently overwrite; the later writer receives **409** with
  the standard conflict body. → T-API-02, T-UI-07

### Conversations and delivery
- **FR-008** A Conversation MUST bind 1:1 to one `ExternalConversation` and have exactly one parent
  Case. → T-DATA-02
- **FR-009** The agent MUST be able to reply on any **connected** channel, and the chosen channel
  MUST be visible before sending. → T-UI-04, T-API-07
- **FR-010** Outbound provider calls MUST carry an explicit timeout (default 15 s); expiry maps to
  the same 422 path as a provider rejection, naming the channel and preserving the draft. → T-API-07
- **FR-011** A failed send MUST surface on the message with a retry, MUST NOT stamp
  `first_human_outbound_at`, and MUST NOT advance the Case to `waiting_customer`. → T-API-07
- **FR-012** Auto-responder and bounce traffic MUST NOT open a Case. → T-ING-02

### Identity
- **FR-013** Channel handles MUST resolve to a `CustomerEntity` with a recorded confidence and
  match method. → T-ING-03
- **FR-014** Below the per-`handle_type` threshold the system MUST link **nothing**, set
  `link_state='unresolved'` and raise a manual-match task. → T-ING-03
- **FR-015** A link MUST be reversible, audited, and MUST NOT delete the identity row. → T-API-08
- **FR-016** Handle values MUST be encrypted at rest with equality lookup via a hash column.
  → T-DATA-03

### Projection and measurement
- **FR-017** Resolving a Case MUST project a `CustomerInteraction` onto the Customer 360 timeline.
  → T-API-04, T-PROJ-01
- **FR-018** When the identity is unresolved the projection MUST be **staged** and drained when the
  handle is later linked — `CustomerInteraction.entity` is a non-nullable `@ManyToOne` and
  `requireTimelineParentEntity` rejects any kind outside `{person, company}`, so an unidentified
  Case cannot project. → T-PROJ-02
- **FR-019** Phase 1 MUST ship the counting layer: cases opened/resolved, inbound/outbound
  timestamps, duplicate-reply candidates. → T-MET-01

### Tenancy, access, i18n
- **FR-020** Every row and every route MUST be scoped to tenant and organisation, and MUST never be
  readable across that boundary. → T-TEST-05
- **FR-021** A cross-tenant or cross-org reference MUST return **404**, never 403 — existence is not
  disclosed. → T-API-01
- **FR-022** Every capability MUST be feature-gated; listing MUST narrow to the caller's own Cases
  without `connect.cases.view.all`. → T-API-09
- **FR-023** No user-facing string may be hard-coded; `pl` and `en` ship complete. → T-I18N-01

## Architecture

### Aggregates

```
connect_case            the unit of work — owns cross-channel grouping, status, owner, wrap-up
  └─ connect_conversation   1:1 with communication_channels.ExternalConversation
       └─ (messages stay in `messages` / `communication_channels` — connect stores no bodies)
connect_contact_identity   channel handle → CustomerEntity, with confidence
```

**Why the Case owns the grouping.** See Provenance repair 1. The alternative — keying on
`messages.Message.thread_id` — needs a write into a peer module's table that no sanctioned
mechanism provides.

### Reading peer data

`connect` MUST NOT query `messages` or `communication_channels` tables, import their entity
classes, write raw SQL against them, or resolve their entity-class DI registrations in order to
query them. `communication_channels/di.ts` registers those classes under a comment that says what
they are for — *"Entity class registrations (for EntityManager lookups by string)"* — which is an
EntityManager convenience, not a read API. The sanctioned precedent in the same file is
`communicationChannelsSendAsUser`, an in-process facade.

Phase 1 therefore adds **one source-owned read facade**, carried forward from A with its nine
requirements intact ([`peer-read-facades.md`](2026-08-21-mercato-connect-omnichannel/contracts/peer-read-facades.md)):
`messages` has no `di.ts` at all, so it gains one exposing `messagesThreadReader`. Scope parameters
are mandatory, reads are batched, projections are plain (never ORM entities), empty is
distinguishable from missing, and the consumer logs via `createLogger` when `tryResolve` yields
nothing. → T-UP-04

### Commands and undo

`resolve`, `transfer`, `close`, `reopen`, identity `link`/`unlink` are undoable commands exposing
`extractUndoPayload()`. **Send is not undoable** — an outbound message has left the building — and
that exemption is stated in the command header so nobody adds a false undo affordance.

### Cache

Phase 1 introduces **no caching**. A decision, not an omission: the Inbox is agent-scoped and
low-volume, and a cache before the SLA clock exists only adds invalidation paths to unpick later.
When caching arrives it resolves through DI with `tenant:<id>` / `org:<id>` tags and an invalidation
entry for **every write path, not every command** — subscriber-driven writes are the highest-volume
ones. No module may construct a Redis or SQLite client directly.

## Blocking upstream PRs

Merged in order, each against a module `connect` does not own, before the `connect` PR.

| PR | Module | Change | Class |
|---|---|---|---|
| **A** | `communication_channels`, `messages` | Shared-channel workstream: shared-channel creation command, tenant-scoped credential provisioning (`user_id IS NULL`), sender identity threaded through `SendMessageInput` and both adapters, shared-channel listing endpoint, authorisation delegated to `assertCanManageChannel`. **Requires relaxing `messages.Message.senderUserId` NOT NULL** for system-authored sends. | **(e) + (d) — needs sign-off** |
| **B** | `customers`, `sales` | Stability commitment on the existing `customers.interactions.create` command (already called cross-module from `apps/mercato/src/modules/example_customers_sync/lib/sync.ts:854`, so a new per-consumer handler would invert the platform's direction rule); four new detail injection spots plus one declaration. | (b) + (c) |
| **C** | `messages` | New `messages/di.ts` registering `messagesThreadReader`, backed by `lib/thread-reader.ts`. | (a) + (b) |

A caller-supplied `allowSharedChannel` boolean was rejected: it lets any in-process DI caller opt
out of the only ownership check. `assertCanManageChannel`'s shared branch already requires an
elevated feature.

## Core-edit ledger — Gate 2

**The rule, quoted.** `packages/core/AGENTS.md` § Extensions: *"When extending another module's
data, add a separate extension entity — never mutate core entities. Pattern mirrors Medusa's module
links."* Scoped to entities/data. Root `AGENTS.md`'s `Never` list has no general core-edit item;
editing core sits under `Ask First` ("changing public contracts… or touching multiple modules in a
way not covered by an existing spec").

| File | Class | Sanctioned alternative considered | Ships as |
|---|---|---|---|
| `messages/di.ts` + `lib/thread-reader.ts` | (a)+(b) | None exists — the platform has extension mechanisms for core *data* and *UI*, but **none for reading a peer module's data**. Adding a source-owned facade is what `.ai/lessons.md` → *"Cross-module query precedent is not permission to copy storage coupling"* requires. | PR C |
| `communication_channels/lib/send-as-user.ts` + `SendMessageInput` | **(e)** | No extension point governs outbound authorisation. Delegating to the existing `assertCanManageChannel` keeps the check in the owning module rather than adding a bypass. | PR A |
| `messages` — `senderUserId` NOT NULL relaxed | **(d)** | An extension entity cannot relax a NOT NULL on the base table. `communication_channels/lib/system-user.ts` returns a sentinel UUID with **no `auth.users` row**, so the column cannot be satisfied for system-authored sends. | PR A — **sign-off required** |
| `customers`/`sales` `extension-points.ts` | (c) | n/a — declaring a new spot *is* the sanctioned mechanism | PR B |
| `optimistic-lock-editable-entities.test.ts` curated map | (a) | n/a — see below | `connect` PR |

**Why the last row exists.** Of the four optimistic-lock gates, `optimistic-lock-ui-coverage-workspace.test.ts`
and `optimistic-lock-command-coverage.test.ts` scan every workspace package, but the **entity-level
`updated_at` gate resolves paths as `__dirname/../modules/<id>` — `packages/core` only**. Root
`AGENTS.md` names that test as the enforcement for the default-ON rule, so `packages/connect`
entities are outside it unless added explicitly.

**No `auth.User` column.** B's App Spec proposed `principal_kind` on `auth.User`; Phase 1 does not
need it (no SLA clock, no containment metric) and it is a (d) change with a sanctioned alternative —
`communication_channels/data/extensions.ts` already declares `{ base: 'auth:user', extension:
'communication_channels:communication_channel', join: { baseKey: 'id', extensionKey: 'user_id' } }`.
Deferred to the phase that needs it, with the extension route priced first.

## Data model

All tables carry `id uuid PK`, `organization_id uuid NOT NULL`, `tenant_id uuid NOT NULL`,
`created_at`, `updated_at`, `deleted_at`. `updated_at` drives optimistic locking (default ON).

**`connect_cases`** — `case_number` (`ZG-<seq>`, unique per tenant, via the
`sales.SalesDocumentSequence` pattern) · `subject` · `status` · `priority` · `service_queue_id`
(nullable, always null in Phase 1) · `assignee_user_id` · `customer_entity_id` (nullable until
resolved) · `origin_channel_id` · `source_order_id`/`source_return_id`/`source_shipment_id` ·
`case_value_minor` · `wrap_up_note` · `wrap_up_seconds` · `conversation_count` ·
`first_agent_touch_at`/`last_agent_touch_at` · `resolved_at`/`closed_at` ·
`merged_into_case_id`/`split_from_case_id` (unused in Phase 1; ship now to avoid a later migration
on a hot table) · `escalation_reason`.
Indexes: `(tenant_id, organization_id, status)` · `(tenant_id, customer_entity_id)` ·
`(tenant_id, assignee_user_id, status)` · unique `(tenant_id, case_number)`.

**`connect_conversations`** — `case_id` · `external_conversation_id` · `channel_id` ·
`contact_handle` (**encrypted**) · `owner` · `human_agent_message_count` ·
`first_human_outbound_at` (written once, never updated) · `started_at`, `ended_at`,
`last_inbound_at`, `last_outbound_at`.
Unique `(tenant_id, external_conversation_id)`. Index `(tenant_id, case_id)`.

**`connect_contact_identities`** — `handle_type` · `handle_value` (**encrypted**) ·
`handle_value_hash` · `customer_entity_id` (nullable) · `link_state` · `confidence` · `channel_id` ·
`unlinked_at`/`unlink_reason` · `first_seen_at`/`last_seen_at`.
Unique: a **raw-SQL partial index** on `(tenant_id, channel_id, handle_type, handle_value_hash)
where deleted_at is null and handle_value_hash is not null` — a plain `@Unique` on ciphertext is
meaningless, since every row has a distinct IV. Phone handles normalise to E.164 before encryption.

**`connect_case_reopens`** · **`connect_pending_projections`** · **`connect_tenant_settings`**
(typed columns, not key/value) · **`connect_case_tags`** + assignments.

**Encryption.** `encryption.ts` exports `defaultEncryptionMaps` covering
`connect_conversations.contact_handle` and `connect_contact_identities.handle_value`, the latter as
`{ field: 'handle_value', hashField: 'handle_value_hash' }`. The unique index is on the **hash**
column. This is the platform's existing mechanism — `auth/encryption.ts`,
`customer_accounts/encryption.ts` and `messages` all use `hashField` for e-mail lookups. All reads
go through `findWithDecryption` / `findOneWithDecryption`.

**No denormalised customer PII.** Neither `connect_cases` nor any other table carries a
`customer_snapshot`. Name and e-mail resolve live through `customers`. This avoids the Critical
finding A raised against itself (`ANALYSIS-053` A1) rather than mitigating it.

## API contracts

Tenant- and organization-scoped, `requireFeatures`-guarded, documented in `api/openapi.ts`.
**Every route file exports per-method `metadata`** (`requireAuth` / `requireFeatures`) — a top-level
`export const requireAuth` is a violation. Mutating routes honour optimistic locking and return
**409** with the standard conflict body.

| Method | Route | Feature | Guard op |
|---|---|---|---|
| GET/POST/PUT/DELETE | `/api/connect/cases` | `connect.inbox.view` / `.handle` / `.cases.manage` | factory |
| POST | `/api/connect/cases/{id}/resolve` | `connect.inbox.handle` | `update` |
| POST | `/api/connect/cases/{id}/close` | `connect.cases.manage` | `update` |
| POST | `/api/connect/cases/{id}/reopen` | `connect.inbox.handle` | `update` |
| POST | `/api/connect/cases/{id}/transfer` | `connect.inbox.handle` | `update` |
| POST | `/api/connect/cases/{id}/messages` | `connect.inbox.handle` | `create` |
| GET | `/api/connect/cases/{id}/conversations` | `connect.inbox.view` | — |
| GET | `/api/connect/contact-identities` | `connect.inbox.view` | — |
| POST | `/api/connect/contact-identities/{id}/link` \| `/unlink` | `connect.inbox.handle` \| `connect.identities.manage` | `update` |
| GET/PUT | `/api/connect/settings` | `connect.settings.manage` | `update` |
| GET | `/api/connect/metrics/baseline` | `connect_analytics.view` **← see drift** | — |

CRUD uses `makeCrudRoute({ …, indexer: { entityType: E.connect.connect_case } })`. The six mutating
action endpoints are **not** CRUD and MUST NOT bypass the guard registry: collect registered guards,
append `bridgeLegacyGuard(container)`, call `runMutationGuards(...)` with `{ userFeatures }` before
mutating, merge `modifiedPayload`, then run `afterSuccessCallbacks`, catching and logging callback
failures. `api/interceptors.ts` narrows `GET /api/connect/cases` to the caller's own Cases without
`connect.cases.view.all`.

### Frozen-surface drift to reconcile before commit 1

[`frozen-surfaces.md`](app-spec-notes/frozen-surfaces.md) is authoritative, and two disagreements
with B's phase spec must be settled first — both are FROZEN, DB-stored, and cost a data migration
to change later:

1. **The six Phase-1 `connect` ACL IDs.** `frozen-surfaces.md` lists
   `connect.identities.manage`; the phase spec lists `connect_analytics.view` instead. Phase 1 has
   no `connect_analytics` module, and `/metrics/baseline` is guarded by it. **Resolve:** use
   `connect.identities.manage` (it has a consumer in Phase 1 — the `/unlink` route) and guard
   `/metrics/baseline` with `connect.cases.view.all` until `connect_analytics` ships.
2. **Event ID count.** The phase spec's BC table says "Seven new `connect.*` IDs"; its own events
   section and `frozen-surfaces.md` both say **ten**. Ten is correct — Phase 1 ships the status
   machine, `/close` and `/reopen`, so every ID has a writer.

## UI

`/backend/connect/inbox` — three-pane composite. Left: channel filter chips, **Case rows** (not
conversation rows — a phone→WhatsApp Case must not appear twice) with a channel-badge cluster.
Centre: header, thread rendering `in`/`out`/`sys` distinctly, composer with reply-channel picker;
Enter sends, Shift+Enter newlines. Right: customer card, order context, contact-identity panel with
confidence and link/verify.

Also `/backend/connect/cases` (DataTable + CSV), `/cases/[id]`, `/customers/[id]` (Customer 360),
`/settings`.

**Canonical mechanisms.** HTTP via `apiCall`/`apiCallOrThrow`/`readApiResultOrThrow`; JSON via
`readJsonSafe`; raw `fetch` is a violation. The Inbox is a custom composite, so **every** write in
it is wrapped in `useGuardedMutation(...).runMutation(...)` with `retryLastMutation` in the
injection context, and each pane holds its own `updatedAt` and sends
`withScopedApiRequestHeaders(buildOptimisticLockHeader(...))` **per mutation target** — a write to
one entity never carries another's version. `LoadingMessage`/`ErrorMessage` per pane.
`Cmd/Ctrl+Enter` submits dialogs, `Escape` cancels. Icons are lucide-react; the prototype's inline
`<svg>` must not be ported. Pane widths use the DS spacing scale — never `w-[336px]`.

Run `om-ds-guardian` over the Inbox before implementation locks the patterns in.

## Risks

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| R1 | **Auto-responder loop** — Connect acknowledges, a vacation responder replies, a Case opens, repeat | **Critical** | `Auto-Submitted`/`Precedence` header checks **plus** a real `(channel_id, from_handle_hash)` window. `inbox_ops/lib/rateLimiter.ts` cannot be reused as-is: its two call sites key on a global bucket and a tenant bucket, and its cache keys are hardcoded to the `inbox_ops:` namespace. Must never fall back to a tenant-wide bucket — that drops every other customer's mail during a loop. → T-ING-02 |
| R2 | **Wrong identity link exposes another customer's orders** | **Critical** | Sub-threshold links nothing (FR-014); ambiguous handles raise a manual-match task; T-TEST-06 asserts cross-customer isolation |
| R3 | Shared-channel outbound widens a security boundary | **Critical** | Authorisation delegates to `assertCanManageChannel`; no caller-supplied opt-out flag; T-TEST-07 asserts per-user behaviour is unchanged |
| R4 | Upstream PR A rejected or delayed | High | Phase 1 slices 1a–1b do not depend on it; only 1c (send) does. Sequence accordingly |
| R5 | **N+1 on the Inbox list** — 300 open Cases × customer + order + identity | High | Batch-resolve per page through the query engine; T-TEST-08 asserts a query-count ceiling |
| R6 | `conversation_count` drifts — it is Phase 2's FCR input | High | Maintained in the same transaction as attach/detach; the baseline job reconciles and reports drift |
| R7 | **Redelivered inbound opens a duplicate Case** | High | Idempotency is a **mechanism, not an assertion**: do not read-then-create. Attempt the insert and let the unique index arbitrate, catching the violation and resolving to the existing row. → T-TEST-09 |
| R8 | Demo seed leaks across tenants | Medium | Seed through the same scoped commands as production writes; T-TEST-05 runs against seeded data too |
| R9 | Prototype is Polish-only and hard-codes every string | Low | `pl` + `en` from day one; `yarn i18n:check-hardcoded` in the DoD |

## Tasks

Every task names a file path. `<M>` = `packages/connect/src/modules/connect/`.

**Slice 1a — foundation (blocked by nothing)**
- T-SET-01 `packages/connect/package.json` + `tsconfig.json`, mirroring `packages/content/`
- T-SET-02 `<M>/index.ts` metadata; run `corepack yarn generate`
- T-DATA-01 `<M>/data/entities.ts` — `connect_case`, per § Data model
- T-DATA-02 `<M>/data/entities.ts` — `connect_conversation`, `connect_case_reopen`, `connect_pending_projection`, tags
- T-DATA-03 `<M>/data/entities.ts` + `<M>/encryption.ts` — `connect_contact_identity`, `defaultEncryptionMaps` with `hashField`, raw-SQL partial unique index on the hash
- T-DATA-04 `corepack yarn db:generate`; keep only `connect` SQL; commit with the updated `.snapshot-open-mercato.json`. Do **not** run `db:migrate`
- T-DATA-05 Add every `connect` entity to the curated map in `packages/core/src/__tests__/optimistic-lock-editable-entities.test.ts`
- T-ACL-01 `<M>/acl.ts` + `<M>/setup.ts` `defaultRoleFeatures`; then `corepack yarn mercato auth sync-role-acls`
- T-DOM-01 `<M>/lib/case-state.ts` — status machine, illegal transitions rejected with a field error
- T-EVT-01 `<M>/events.ts` — the ten `connect.*` IDs via `createModuleEvents` with `as const`. No `clientBroadcast` in Phase 1
- T-API-01 `<M>/api/cases/route.ts` — `makeCrudRoute` + `indexer` + OpenAPI + per-method `metadata`; cross-tenant refs return 404
- T-API-02 Optimistic locking on every mutating route; `updatedAt` in list and detail responses
- T-SRCH-01 `<M>/search.ts` — index subject and customer name. **Exclude `handle_value`** — it is encrypted at rest and indexing it would put decrypted handles in the search document
- T-VAL-01 `<M>/data/validators.ts` — zod per payload, types via `z.infer`, no `any`

**Slice 1b — ingest (blocked by 1a)**
- T-ING-01 `<M>/subscribers/ingest-inbound.ts` (`persistent: true`) — attach-or-create
- T-ING-02 `<M>/lib/auto-responder.ts` — `Auto-Submitted`/`Precedence` + per-sender window (R1)
- T-ING-03 `<M>/lib/identity-resolver.ts` — per-`handle_type` thresholds, `lookupHashCandidates` on read
- T-ING-04 `<M>/lib/attach-window.ts` — `case_attach_window_minutes`, floor 60
- T-CH-01 `packages/channel-webform/src/modules/channel_webform/` — adapter + intake via the shared inbound route

**Slice 1c — inbox (blocked by upstream PR A)**
- T-UP-01…03 Upstream PR A (see § Blocking upstream PRs)
- T-UP-04 Upstream PR C — `messages/di.ts` + `lib/thread-reader.ts` + unit tests asserting scope enforcement and batching, + a "Public Contract Surfaces" table in `messages/AGENTS.md`
- T-UI-01…03 `<M>/components/inbox/{InboxShell,CaseList,ConversationThread}.tsx`
- T-UI-04 `<M>/components/inbox/Composer.tsx` — reply-channel picker, Enter/Shift+Enter
- T-UI-05 `<M>/components/inbox/useConnectMutations.ts` — `useGuardedMutation` + per-pane lock headers
- T-API-07 `<M>/api/cases/[id]/messages/route.ts` — send under an explicit 15 s timeout; 422 names the channel and reason (FR-010, FR-011)
- T-API-04 `<M>/api/cases/[id]/resolve/route.ts` — wrap-up gate, 409 when raced by a new Case event
- T-API-05 `<M>/api/cases/[id]/close/route.ts` — sets `closed_at`, emits `connect.case.closed`
- T-API-06 `<M>/api/cases/[id]/reopen/route.ts` — in-place within `reopen_window_days`, writes a `connect_case_reopen` row
- T-API-08 `<M>/api/contact-identities/[id]/{link,unlink}/route.ts` — `unlink` gated on `connect.identities.manage`, audited, row never deleted
- T-API-09 `<M>/api/interceptors.ts` — narrow `GET /api/connect/cases` to the caller's own Cases unless they hold `connect.cases.view.all` (FR-022)
- T-WRK-01 `<M>/workers/auto-close.ts` — closes `resolved` Cases after `auto_close_after_days` with no inbound (FR-005)
- T-CMD-01 `<M>/commands/` — undoable resolve/transfer/close/reopen/link/unlink with `extractUndoPayload`; send carries a documented no-undo exemption

**Slice 1d — surfaces (blocked by upstream PR B)**
- T-UP-05 Upstream PR B — projection stability commitment + injection spots
- T-PROJ-01 `<M>/commands/project-interaction.ts` — calls `customers.interactions.create` with a deterministic id, handling 23505 (the command creates and flushes unconditionally and forks its own EM, so resolve + projection cannot be atomic)
- T-PROJ-02 `<M>/lib/pending-projection.ts` — stage and drain on link (FR-018)
- T-UI-06…09 Cases list · Case detail · Customer 360 · settings
- T-WID-01 Injection widgets + the orders-list "has open case" — needs **both** a response enricher (supplies the field) **and** an `InjectionColumnWidget` (renders the column)
- T-MET-01 `<M>/workers/baseline-metrics.ts` (FR-019)
- T-I18N-01 `<M>/i18n/{pl,en}.json`; `corepack yarn i18n:check-hardcoded`

## Integration test coverage

Self-contained per `.ai/qa/AGENTS.md`: fixtures created in setup via API, cleaned in teardown, no
reliance on seeded demo data.

| # | Scenario | Asserts |
|---|---|---|
| T-TEST-01 | Inbound e-mail → Case | Exactly one Case; `conversation_count = 1`; `connect.case.created` once |
| T-TEST-02 | Second inbound, same identity, inside/outside the window | Attaches / opens a new Case tagged `possible_duplicate` |
| T-TEST-03 | Out-of-office and DSN | **No Case created**, no acknowledgement sent |
| T-TEST-04 | Reply sends, then fails | `Message` + `MessageChannelLink`; on failure `first_human_outbound_at` NOT stamped and status not advanced |
| T-TEST-05 | **Cross-tenant isolation** | A Case from tenant A is invisible to tenant B on every route, list, search and export |
| T-TEST-06 | **Cross-customer isolation** | Agent-scoped listing never returns another customer's Case via `ids=` |
| T-TEST-07 | Shared-channel authorisation | Without the elevated feature → 403; with it → success; per-user behaviour unchanged |
| T-TEST-08 | Inbox list at 300 open Cases | Query count under the declared ceiling |
| T-TEST-09 | Redelivered `ExternalMessage` | No second Case; `conversation_count` unchanged |
| T-TEST-10 | Mutation guards on all six action routes | A denying guard blocks the mutation **and** `afterSuccessCallbacks` do not run |
| T-TEST-11 | Encrypted lookup | `handle_value` unreadable at rest; lookup by hash returns the identity; duplicate rejected |
| T-TEST-12 | Resolve → projection | `CustomerInteraction` appears; idempotent under replay; unresolved identity stages instead |
| T-TEST-13 | Command undo round-trip | resolve/transfer/close/link restore prior state; send asserts its no-undo exemption |

UI (Playwright, headless): U1 login → inbox → reply · U2 resolve gate · U3 link from the rail ·
U4 list filter + inline status · U5 Customer 360 tabs · U6 every empty state with a working CTA ·
U7 two tabs edit one Case → conflict bar · U8 `pl` and `en` with no missing-key placeholders.

## Migration & backward compatibility

Audited against all **14** surfaces in `BACKWARD_COMPATIBILITY.md` — note that
`om-pre-implement-spec`'s own table says 13 and is stale; surface **#12 (AI Agent, Tool, UI Part and
Override IDs)** exists and is FROZEN. Phase 1 declares no AI IDs, so #12 is n/a here — but the count
matters for later phases.

Additive: new module and package IDs (1) · ten new event IDs (5) · four new spots + one declaration
(6) · new `/api/connect/*` namespace (7) · new tables only (8) · four new DI keys (9) · six new ACL
IDs (10) · new generated registry entries (14).

Changed: **`messages.Message.senderUserId` NOT NULL relaxed** (8, ADDITIVE-ONLY surface — needs
sign-off) and `SendMessageInput` gaining sender identity (3, STABLE) — both in PR A, with per-user
callers byte-identical and T-TEST-07 asserting it.

## Open questions

| # | Question | Blocks | Status |
|---|---|---|---|
| Q1 | Does upstream PR A land this cycle? | slice 1c only | **OPEN — confirm before 1c** |
| Q2 | Sign-off on relaxing `senderUserId` NOT NULL | PR A | **OPEN — needs a maintainer** |
| Q3 | Baseline contact volume and the inbound/outbound split | no phase — it is what Phase 1 *measures* | OPEN by design. Not resolvable from the prototype; the fixture never separates inbound from outbound. Only operator data closes it |

## Changelog

| Date | Change |
|---|---|
| 2026-08-21 | Merged Phase 1 spec created from packages A and B per ANALYSIS-054. Two repairs verified against source: the cross-channel aggregate moved out of `messages` (A's premise had no write path), and the reply path made a blocking upstream PR (`send-as-user.ts:101-103` ownership gate). Adopted B's encryption `hashField`, staged projection, and frozen-surface list; A's numbered FRs, peer-read facade contract, file-pathed tasks and tenancy gate. Reconciled two frozen-surface drifts. Dropped `auth.User.principal_kind` from Phase 1 as unneeded and (d)-class. Gate 1 remains UNGATED. |

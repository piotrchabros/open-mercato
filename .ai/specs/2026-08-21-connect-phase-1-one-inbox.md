# Mercato Connect — Phase 1: One Inbox (e-mail and forms)

| Field | Value |
|---|---|
| **Date** | 2026-08-21 |
| **Status** | Proposed |
| **Scope** | OSS |
| **Parent** | [`2026-08-21-app-spec-mercato-connect.md`](2026-08-21-app-spec-mercato-connect.md) §7 Phase 1 — the App Spec wins on any conflict |
| **Module(s)** | new `packages/connect`; new `packages/channel-webform`; host-side additive changes to `packages/core/src/modules/customers`, `packages/core/src/modules/sales`, `packages/core/src/modules/communication_channels` |
| **Commits** | 40 (WF1-1…24, WF3-1…7, WF4-21, WF6-1, CH-1…2, SD-1…3, IX-1…2) — plan in `app-spec-notes/commits-by-workflow.md` |
| **Related** | `SPEC-046b` (interactions unification), `2026-05-21-email-integration-foundation.md`, `2026-03-23-inbound-webhook-handlers.md`, `BACKWARD_COMPATIBILITY.md` |

---

> ## Body swept to v3 on 2026-08-21 (round-3 remediation)
>
> Round 3 found the delta table had been prepended without sweeping the body. D4, D5, D7, R3,
> T6, T7, T17, M1, the upstream ordering, the compliance report and P1-3 are now rewritten to
> match App Spec v3. **Still open before slice 1a:** the App Spec's own §1.2 base unit and its
> §4.6 adoption credit are unresolved (`app-spec-notes/independent-review-register-v3.md`), and
> the estimate below is understated. Treat this phase as *safe to start*, not as a correct
> schedule.

> ## Aligned to App Spec **v3** (2026-08-21). 40 commits.
>
> Review round 2 found four blockers on FROZEN surfaces in the v2-aligned draft. All four are
> resolved below; the deltas from that draft are:
>
> | # | Was | Now |
> |---|---|---|
> | 1 | `first_responded_at` shipped on `connect_cases` | **Removed.** Phase 1 has no `connect_sla`, so it stamps no first response. WF6-1 records raw inbound/outbound timestamps and Phase 2 derives `responded_at` on enable. Avoids migrating a hot column |
> | 2 | `connect.analytics.view` (wrong namespace) | **`connect_analytics.view`** — `<module>.<resource>.<verb>`, no exceptions |
> | 3 | `principal_kind` assumed to exist | **Upstream PR D** on `auth`, fail-closed: an unresolvable author is never `human` |
> | 4 | `closed` in the enum, no transition | **`POST /cases/{id}/close`** + an auto-close job after `auto_close_after_days` (App Spec inv 7b) |
> | 5 | Resolve → projection, unconditional | **Stage and backfill** — `connect_pending_projection`, drained when the identity links. `CustomerInteraction.entity` is non-nullable, so an unidentified Case cannot project |
> | 6 | New `customers` projection command | **Use the existing `customers.interactions.create`** with a stability commitment; it already has cross-module callers |
> | 7 | Reply-after-resolve opened a new unlinked Case | **Reopen ships in Phase 1** — `reopen_window_days` now has a reader |
> | 8 | `possible_duplicate` undecided (P1-3) | **A tag.** The status enum stays frozen |
> | 9 | `handle_value_hash` missing from the column list | Declared, with a **raw-SQL partial unique index** on the hash, and reads via `lookupHashCandidates` |
> | 10 | `sendAsUser` widening as 1 commit | **8–12 commit workstream** (upstream PR A) — credentials, sender identity and shared-channel creation, not a flag |
> | 11 | R1 auto-responder suppression built fresh | **Extends `inbox_ops`'s parser only.** Round 3 refuted the rest: `lib/rateLimiter.ts` has **no sender dimension** (its two call sites key on a global bucket and on `tenantId`), and its cache keys are hardcoded to the `inbox_ops:` namespace. A real `(channel_id, from_handle_hash)` window is new work in WF1-6 — and must never fall back to a tenant-wide bucket, which would drop every other customer's mail during a loop |

## TLDR

Ship the smallest slice that replaces a shared support mailbox with a real service desk: every
inbound e-mail and web-form submission becomes a **Case** with one owner, one status and one
thread; the agent replies from a three-pane Inbox with the customer's orders on screen; closing
a Case writes a note and projects an interaction onto the Customer 360 timeline.

No SLA clock, no queues, no routing, no AI, no bots, no portal — those are Phases 2–6. Phase 1
proves the Case aggregate, the hub binding and the `customers` projection contract using
**channel adapters that already ship** (`channel-gmail`, `channel-imap`), so nothing waits on a
new provider integration.

---

## Problem Statement

The operator's service team works a shared mailbox. That produces four concrete failures:

1. **No ownership.** Two agents answer the same e-mail because a mailbox has no assignment
   model. Estimated at ~4% of e-mail volume — a figure this phase must *measure*, not assume
   (App Spec OQ-3).
2. **No context.** The agent alt-tabs to the ERP to find the order, the shipment and the return.
3. **No history.** The customer's previous contacts are in another folder, another inbox, or
   another person's memory.
4. **No measurement.** Nobody can state first-response time, resolution rate or cost per contact,
   so no later phase can prove it improved anything.

Phase 1 addresses (1)–(3) and ships the counting layer for (4).

---

## Proposed Solution

A new `connect` module owning three aggregates — **Case**, **Conversation**, **contact
identity** — layered on top of the existing `communication_channels` hub, plus a three-pane
Inbox in the backend.

**Flow.** An inbound message lands in the hub as an `ExternalMessage` (existing). A `connect`
subscriber resolves the sender's handle to a `CustomerEntity`, then either attaches the message
to an open Case for that identity or opens a new one. The agent works the Case in the Inbox,
replies through the existing `messages` + `MessageChannelLink` + adapter send path, and resolves
it with a note. On resolve, `connect` invokes the existing `customers.interactions.create`
command to write a `CustomerInteraction` — or, when the identity is unresolved, stages a
`connect_pending_projection` row that is drained when the handle is later linked
(`CustomerInteraction.entity` is non-nullable, so an unidentified Case cannot project).

**Deliberately excluded from Phase 1:** SLA clocks and `connect_sla_case_clock`; service queues,
presence and routing offers; AI suggestions, summaries and wrap-up drafts; bots and intents; the
portal; campaigns; quality. Case carries `status` and `priority` but nothing computes a due
date, and `priority` is agent-set rather than derived.

---

## Architecture

### Module boundaries

```
packages/connect/src/modules/connect/          ← new, this phase
   ├─ index.ts  acl.ts  di.ts  setup.ts  events.ts  extension-points.ts
   ├─ data/entities.ts  data/validators.ts      ← zod; types via z.infer, no `any`
   ├─ encryption.ts                             ← defaultEncryptionMaps (PII at rest)
   ├─ search.ts                                 ← Case indexing for global search
   ├─ api/  backend/  components/  subscribers/  commands/  i18n/  migrations/
   ├─ owns: connect_case, connect_conversation,
   │        connect_contact_identity, connect_tenant_settings
   ├─ reads: sales (orders/returns/shipments/invoices) via public APIs
   ├─ reads: customers (entities, tags, consents) via public APIs
   ├─ writes to customers ONLY via the existing `customers.interactions.create`
   └─ binds to communication_channels via subscriber + adapter send

packages/channel-webform/src/modules/channel_webform/   ← new, this phase
   └─ registerChannelAdapter, webhook intake via the shared inbound route
```

Package names are kebab-case; module ids are snake_case — matching `channel-gmail` /
`channel_gmail`. Both are FROZEN auto-discovery surfaces once shipped.

**Encryption.** `encryption.ts` exports `defaultEncryptionMaps` (`ModuleEncryptionMap` from
`@open-mercato/shared/modules/encryption`) covering `connect_conversations.contact_handle` and
`connect_contact_identities.handle_value`. The latter declares
`{ field: 'handle_value', hashField: 'handle_value_hash' }`, and **the unique index is built on
the hash column, not the encrypted column** — the same mechanism `auth`, `customer_accounts` and
`messages` already use for e-mail lookups. All reads go through `findWithDecryption` /
`findOneWithDecryption`.

**Commands and undo.** `resolve` and `transfer` are implemented as undoable commands exposing
`extractUndoPayload()` (previous status, assignee, wrap-up note). Send is **not** undoable — an
outbound message has left the building — and this is stated explicitly so nobody adds a false
undo affordance. Identity `link` / `unlink` are undoable.

**Cache.** Phase 1 introduces **no caching**. This is a decision, not an omission: the Inbox is
agent-scoped and low-volume, and a cache before the SLA clock exists would only add
invalidation paths to unpick in Phase 2. When caching arrives it resolves through DI with
`tenant:<id>` / `org:<id>` tags. No module may construct a Redis or SQLite client directly.

### Design decisions

| # | Decision | Alternative rejected |
|---|---|---|
| D1 | Case is a **new aggregate in `connect`**, not a `workflows.WorkflowInstance` | `UserTask` is a generic human task; it has no channel awareness, no conversation cardinality, and its `workflowInstanceId`/`stepInstanceId` are non-nullable, forcing a workflow instance per Case |
| D2 | Conversations and messages stay in `communication_channels` / `messages`; `connect` stores **no message bodies** | Duplicating a message store would drift from the hub and break threading |
| D3 | Cross-module references are plain `uuid` columns, never `@ManyToOne` | Project rule: no direct ORM relationships between modules |
| D4 | The projection uses the **existing `customers.interactions.create`** command, with a stability commitment negotiated upstream (PR B) | A new per-consumer handler would invert the platform's direction rule — the depended-on module would carry its consumer's vocabulary. The "no external callers" premise is false: `apps/mercato/src/modules/example_customers_sync/lib/sync.ts:854` already calls it cross-module via the bus. **Note:** the command is not idempotent (it creates and flushes unconditionally) and forks its own EM, so resolve + projection cannot be atomic — the caller supplies a deterministic `id` and handles 23505 |
| D5 | Shared-channel outbound is a **scoped workstream** (upstream PR A, 8–12 commits): a shared-channel creation command, tenant-scoped credential provisioning, sender identity threaded through `SendMessageInput` and both adapters, a shared-channel listing endpoint, and authorisation delegated to `assertCanManageChannel` | A caller-supplied `allowSharedChannel` boolean was rejected: it lets any in-process DI caller opt out of the only ownership check. `assertCanManageChannel`'s shared branch already requires an elevated feature. The ownership gate (`send-as-user.ts:101-103`) is only one of four blockers — credentials are per-user, from-address derives from the credential blob, no path creates a shared channel, and `senderUserId` is NOT NULL |
| D6 | Injection spots are **added host-side** in `customers` and `sales` | The needed spots do not exist; `customers` declares person/company/deal only, `sales` declares no return spots at all |
| D7 | Identity resolution below the **per-`handle_type` threshold** links **nothing** and raises a manual-match task | Guessing risks showing customer A's orders to customer B — the worst failure this product can produce |
| D8 | Phase 1 queues are absent entirely, not stubbed | A stubbed queue would imply routing that does not exist; `service_queue_id` is nullable by design (App Spec §1.4.2) |

### Sequence — inbound to resolved

```
provider → communication_channels ingest → ExternalMessage + ExternalConversation
   → connect subscriber
        ├─ auto-responder / bounce check ── suppressed → stop (no Case)
        ├─ resolve handle → connect_contact_identity
        │     ├─ confidence ≥ threshold → link customer_entity_id
        │     └─ below              → link_state='unresolved', manual-match task
        └─ open Case for identity within attach window?
              ├─ yes → attach Conversation to that Case
              └─ no  → create Case (status='new')
   → agent opens Inbox → replies
        → messages.Message + MessageChannelLink → adapter.sendMessage
   → agent resolves with a note
        → connect.case.resolved
        → customers projection command → CustomerInteraction on the 360 timeline
```

---

## Data Models

All tables carry `id uuid PK`, `organization_id uuid NOT NULL`, `tenant_id uuid NOT NULL`,
`created_at`, `updated_at`, `deleted_at`. `updated_at` drives optimistic locking (default ON).

### `connect_cases`

| Column | Type | Null | Notes |
|---|---|---|---|
| `case_number` | text | no | `ZG-<seq>`, unique per tenant, via the `sales.SalesDocumentSequence` pattern |
| `subject` | text | no | Phase 1: the mail `Subject:` header, or the form's topic field |
| `status` | text | no | `new`\|`in_progress`\|`waiting_customer`\|`escalated`\|`resolved`\|`closed` |
| `priority` | text | no | `low`\|`medium`\|`high`\|`urgent`; default `medium`, agent-set in Phase 1 |
| `service_queue_id` | uuid | **yes** | always null in Phase 1 |
| `assignee_user_id` | uuid | yes | |
| `customer_entity_id` | uuid | yes | null until identity resolves |
| `primary_contact_person_id` | uuid | yes | |
| `origin_channel_id` | uuid | no | |
| `source_order_id` / `source_return_id` / `source_shipment_id` | uuid | yes | FK-ids |
| `case_value_minor` | integer | yes | from the linked order/return |
| `wrap_up_note` | text | yes | required to reach `resolved` (invariant 7) |
| `wrap_up_seconds` | integer | yes | |
| `conversation_count` | integer | no | default 1, maintained on attach/detach |
| `first_agent_touch_at` / `last_agent_touch_at` | timestamptz | yes | |
| `resolved_at` / `closed_at` | timestamptz | yes | |
| `merged_into_case_id` / `split_from_case_id` | uuid | yes | unused in Phase 1; columns ship now to avoid a later ADDITIVE migration on a hot table |
| `escalation_reason` | text | yes | |

Indexes: `(tenant_id, organization_id, status)`, `(tenant_id, customer_entity_id)`,
`(tenant_id, assignee_user_id, status)`, unique `(tenant_id, case_number)`.

### `connect_conversations`

`case_id` uuid NOT NULL · `external_conversation_id` uuid NOT NULL · `channel_id` uuid NOT NULL
· `contact_handle` text NOT NULL (encrypted) · `owner` text NOT NULL default `'agent'` (Phase 1
has no bot) · `handed_off_at` timestamptz · `handoff_reason` text · `handoff_rule_id` uuid ·
`human_agent_message_count` integer NOT NULL default 0 · **`first_human_outbound_at` timestamptz NULL — written once, never updated** · **`first_human_outbound_principal_kind` text NULL — snapshotted at send, so a later user deletion cannot retro-score the Case** · `started_at`, `ended_at`, `last_inbound_at`, `last_outbound_at` timestamptz.
Unique: `(tenant_id, external_conversation_id)`. Index: `(tenant_id, case_id)`.

### `connect_contact_identities`

`handle_type` text NOT NULL (`phone`|`email`|`whatsapp`|`messenger_psid`|`instagram_id`|
`portal_user`|`chat_visitor`) · `handle_value` text NOT NULL (encrypted) · **`handle_value_hash` text NULL** · `customer_entity_id`
uuid **NULL** · `link_state` text NOT NULL (`unresolved`|`auto_linked`|`verified`|`unlinked`) ·
`confidence` real NOT NULL default 0 · `channel_id` uuid NOT NULL · `merged_from_identity_id`
uuid · `unlinked_at` timestamptz · `unlink_reason` text · `first_seen_at`, `last_seen_at`.
Unique: a **raw-SQL partial index** on `(tenant_id, channel_id, handle_type, handle_value_hash) where deleted_at is null and handle_value_hash is not null` — a plain `@Unique` on the ciphertext is meaningless, since every row has a distinct IV. Reads use `lookupHashCandidates` (the column may hold a keyed `v2:` HMAC or a legacy unkeyed hash). Phone handles are normalised to E.164 before encryption.

### `connect_tenant_settings`

One row per tenant, modelled as typed columns. Phase 1 uses `auto_wrap_enabled`, the per-`handle_type` identity-threshold map,
`case_attach_window_minutes`, `reopen_window_days`, `vip_tag_key`,
`agent_loaded_rate_minor_per_hour`. The remaining keys from App Spec §1.4.2 ship as columns with
defaults so later phases add behaviour, not migrations.

### `connect_case_tags` / `connect_case_tag_assignments`

Standard dictionary + junction, following the `customers` tag pattern.

**Encryption:** `contact_handle` and `handle_value` are PII and use the platform encryption
helpers; all reads go through `findWithDecryption` / `findOneWithDecryption`.

---

## API Contracts

All routes are tenant- and organization-scoped, guarded with `requireFeatures`, and documented
in `api/openapi.ts`. Mutating routes honour optimistic locking and return `409` with the
standard conflict body.

| Method | Route | Feature | Notes |
|---|---|---|---|
| GET | `/api/connect/cases` | `connect.inbox.view` (own) / `connect.cases.view.all` | Filter by status, channel, assignee, customer, `ids=`; `pageSize` ≤ 100 |
| POST | `/api/connect/cases` | `connect.inbox.handle` | Manual case creation |
| GET | `/api/connect/cases/{id}` | as above | Returns `updatedAt` for the lock header |
| PUT | `/api/connect/cases/{id}` | `connect.inbox.handle` | Subject, priority, tags, assignee |
| DELETE | `/api/connect/cases/{id}` | `connect.cases.manage` | Soft delete |
| POST | `/api/connect/cases/{id}/resolve` | `connect.inbox.handle` | Body `{ wrapUpNote }`; 422 when empty; aborts with 409 if a new Case event arrived |
| POST | `/api/connect/cases/{id}/close` | `connect.cases.manage` | Sets `closed_at`; emits `connect.case.closed`. Also driven by the auto-close job after `auto_close_after_days` |
| POST | `/api/connect/cases/{id}/reopen` | `connect.inbox.handle` | In-place within `reopen_window_days`; writes a `connect_case_reopen` row |
| POST | `/api/connect/cases/{id}/transfer` | `connect.inbox.handle` | Body `{ assigneeUserId, reason }` |
| POST | `/api/connect/cases/{id}/messages` | `connect.inbox.handle` | Body `{ channelId, body, attachments[] }`; capability-checked before send |
| GET | `/api/connect/cases/{id}/conversations` | `connect.inbox.view` | |
| GET | `/api/connect/contact-identities` | `connect.inbox.view` | Filter by `linkState`, `customerEntityId` |
| POST | `/api/connect/contact-identities/{id}/link` | `connect.inbox.handle` | Body `{ customerEntityId, reason? }` |
| POST | `/api/connect/contact-identities/{id}/unlink` | `connect.cases.manage` | Body `{ reason }`; audited |
| GET | `/api/connect/settings` | `connect.settings.manage` | |
| PUT | `/api/connect/settings` | `connect.settings.manage` | |
| GET | `/api/connect/metrics/baseline` | `connect_analytics.view` | Counts only: cases opened/resolved, first-response times, duplicate-reply candidates |

**Every route file exports per-method `metadata`** (`requireAuth` / `requireFeatures`) — never a
top-level `export const requireAuth`. Every request body and query is validated by a zod schema
from `data/validators.ts`, with types derived via `z.infer`.

**CRUD routes** use `makeCrudRoute({ entity, entityId, operations, schema, indexer: { entityType:
'connect_case' } })`, so Cases enter the query index and the global search surface specced in
App Spec §3.5.

**Action routes are not CRUD, and must not bypass the guard registry.** The six mutating action
endpoints — `/resolve`, `/transfer`, `/messages`, identity `/link`, identity `/unlink` and
`PUT /settings` — each map to a mutation action (all `update` except `/messages`, which is
`create`), and each must: collect registered guards, append `bridgeLegacyGuard(container)` when
present, call `runMutationGuards(...)` with `{ userFeatures }` **before** mutating, merge any
`modifiedPayload`, then run the returned `afterSuccessCallbacks` afterwards, catching and
logging callback failures. Mechanism: `packages/shared/src/lib/crud/mutation-guard.ts` and
`route-mutation-guard.ts`. Root `AGENTS.md` lists bypassing mutation guards under **Never**.

**Interceptor:** `api/interceptors.ts` narrows `GET /api/connect/cases` to the caller's own
Cases unless they hold `connect.cases.view.all`.

### Error contract

| Condition | Status | Body |
|---|---|---|
| Validation failure | 422 | zod field errors |
| Optimistic-lock conflict | 409 | standard conflict body, surfaced via `surfaceRecordConflict` |
| Resolve raced by a new Case event | 409 | conflict body naming the event |
| Missing feature | 403 | minimal message, no entity disclosure |
| Cross-tenant / cross-org reference | 404 | never 403 — existence is not disclosed |

### Events (`connect.*`)

Declared with `createModuleEvents()` in `events.ts`, using `as const`.

`connect.case.created` · `connect.case.assigned` · `connect.case.status_changed` ·
`connect.case.transferred` · `connect.case.resolved` · `connect.case.closed` ·
`connect.case.reopened` · `connect.conversation.attached` · `connect.identity.linked` ·
`connect.identity.unlinked`.

**Ten IDs, frozen together before commit 1** — see `app-spec-notes/frozen-surfaces.md`. Phase 1
ships the status machine (commit 8), `/close` (21) and `/reopen` (22), so every ID has a writer
in this phase; adding them later would be additive but leaves Phase 1's own close path emitting
an undeclared event.

Payloads carry `caseId`, `tenantId`, `organizationId` and the fields named by the action.
**No `clientBroadcast` in Phase 1** — the Inbox refreshes on interaction; live push arrives with
the wallboard in Phase 3.

### DI keys

`connectCaseService` · `connectIdentityResolver` · `connectProjectionService` ·
`connectSettingsService`.

### ACL feature IDs (FROZEN once shipped — App Spec §1.4.5)

`connect.inbox.view` · `connect.inbox.handle` · `connect.cases.view.all` ·
`connect.cases.manage` · `connect.settings.manage` · `connect_analytics.view`.

Seeded onto roles in `setup.ts` via `defaultRoleFeatures`, then `yarn mercato auth
sync-role-acls`.

---

## UI / UX

All screens use `packages/ui` primitives and `packages/ui/src/backend` building blocks. Strings
are locale keys (`en` + `pl`); `pl` is the prototype's copy. Every mutation confirms through the
flash/toast surface. `Cmd/Ctrl+Enter` submits dialogs, `Escape` cancels.

**Canonical mechanisms — no DIY substitutes.** HTTP goes through `apiCall` / `apiCallOrThrow` /
`readApiResultOrThrow` from `@open-mercato/ui/backend/utils/apiCall`; JSON is read with
`readJsonSafe`. Raw `fetch` is a violation. The Cases list uses `<DataTable>` with a stable
`entityId` and `extensionTableId`; the Settings page uses `<CrudForm>` with
`createCrud`/`updateCrud` and `createCrudFormError`.

**The Inbox is a custom composite, so every write in it — send, resolve, transfer, link — is
wrapped in `useGuardedMutation(...).runMutation(...)`, with `retryLastMutation` supplied in the
injection context.** Each pane holds its own `updatedAt` in state and sends
`withScopedApiRequestHeaders(buildOptimisticLockHeader(...))` per mutation target, so a write to
one entity never carries another's version.

Every pane renders `LoadingMessage` and `ErrorMessage` (from `@open-mercato/ui/backend/detail`)
alongside its empty state; a failed context fetch leaves the thread and composer usable. Icons
are lucide-react in the page body — the prototype's inline `<svg>` must not be ported
literally — and icon-only buttons carry `aria-label`. Pane widths use the DS spacing scale or a
documented layout token, never arbitrary values like `w-[336px]`.

### `/backend/connect/inbox` — three-pane composite (new)

- **Left (336px):** channel filter chips, conversation rows — customer, relative time, 2-line
  snippet, channel label, VIP badge. Active row marked by a left border, not colour alone.
- **Centre (min 660px):** header (customer, channel badge, VIP, actions Przekaż / Karta klienta
  / Zamknij sprawę), message thread rendering `in` / `out` / `sys` kinds distinctly, composer
  with reply-channel picker. Enter sends, Shift+Enter newlines.
- **Right (344px):** customer card (LTV, orders, NPS, churn), order context with quick links,
  contact-identity panel with confidence and a link/verify action.

The **routing provenance line** and the AI rail are Phase 3 and Phase 4; Phase 1 renders neither.

### Other pages

`/backend/connect/cases` — `DataTable`: number, subject, customer, channel, owner, priority,
status, updated; inline status advance; CSV export.
`/backend/connect/cases/[id]` — detail with conversations, timeline and audit.
`/backend/connect/customers/[id]` — Customer 360 with header KPIs and four tabs.
`/backend/connect/settings` — tenant settings form.

### Empty states

| Surface | Message | Action |
|---|---|---|
| Inbox, filtered | "Brak rozmów w tym kanale." | [Pokaż wszystkie] |
| Inbox, nothing | "Kolejka pusta. Dobra robota." | — |
| Cases list, filtered | "Żadne zgłoszenie nie pasuje do filtrów." | [Wyczyść filtry] |
| Cases list, never used | "Brak zgłoszeń. Podłącz kanał, aby zacząć je odbierać." | [Poproś administratora] |
| Customer 360, no history | "Brak historii kontaktu. To pierwsza sprawa tego klienta." | [Utwórz zgłoszenie] |
| Identity panel, unresolved | "Nieznany kontakt." | [Powiąż z klientem] |

Each CTA is reachable with the viewing persona's features.

### Widget injections (host spots added this phase)

| Widget | Spot (new) |
|---|---|
| Open service cases | `detail:customers.person:sidebar`, `detail:customers.company:sidebar` |
| Contact identities | `detail:customers.person:tabs` |
| Related cases | `detail:sales.order:sidebar` |
| Service context | `detail:sales.return:sidebar` |
| "Has open case" column | `sales.orders` **response enricher**, not a column widget |

---

## Risks & Impact Review

| # | Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | **Auto-responder loop** — Connect acknowledges, the sender's vacation responder replies, a Case opens, the reply triggers it again | **Critical** | High without mitigation | `Auto-Submitted` / `Precedence` header checks + a per-sender rate cap (WF1-6), gating Phase 1's own acceptance criterion |
| R2 | **Wrong identity link exposes another customer's orders** | **Critical** | Low | Sub-threshold resolutions link nothing (D7); ambiguous handles raise a manual-match task; an integration test asserts cross-customer isolation |
| R3 | Shared-channel outbound widens a security boundary | **Critical** | Low | Authorisation delegates to `assertCanManageChannel`, whose shared branch requires an elevated feature (D5). No caller-supplied opt-out flag exists. Existing per-user callers are unaffected; T17 asserts it |
| R4 | The `customers` projection contract is rejected upstream, stranding WF1-15/16 | High | Medium | Contract designed to mirror the pattern the `call_transcripts` spec already proposes; fallback is the existing subscriber inversion at the cost of `customers` carrying Connect-specific code |
| R5 | Adding injection spots to `customers`/`sales` conflicts with in-flight work there | Medium | Medium | Spots are purely additive; coordinate before Phase 1 starts |
| R6 | Case↔Conversation attach rule misfires, splitting or merging threads wrongly | High | Medium | Phase 1 attaches only within `case_attach_window_minutes` on a resolved identity; anything else opens a new Case flagged `possible_duplicate` |
| R7 | Optimistic-lock coverage gate fails because the Inbox is not a `CrudForm` | Medium | High | Per-pane `updatedAt` in state, `withScopedApiRequestHeaders(buildOptimisticLockHeader(...))` on every non-CrudForm mutation, `surfaceRecordConflict` in the UI |
| R8 | Baseline measurement is too crude to close OQ-3 | Medium | Medium | Phase 1 counts Cases, first responses and duplicate-reply candidates only; full KPIs in Phase 2 |
| R9 | `case_number` sequence contention under concurrent inbound | Low | Medium | Reuse the `sales.SalesDocumentSequence` pattern, which already handles this |
| R10 | Encrypted `handle_value` prevents efficient lookup | Medium | High | **Resolved:** `hashField: 'handle_value_hash'` in `encryption.ts`, with the unique index on the hash column — the platform's existing mechanism (`auth`, `customer_accounts`, `messages`) |
| R11 | **N+1 on the Inbox list** — each row needs customer, order context and identity; 300 open Cases becomes 900+ queries | High | High | Batch-resolve per page through the query engine; T20 asserts a query-count ceiling |
| R12 | **`conversation_count` drifts** — it is the FCR input from Phase 2, and a failed attach or merge corrupts a headline KPI | High | Medium | Maintained in the same transaction as attach/detach; the baseline-metrics job reconciles and reports drift |
| R13 | **Redelivered inbound opens a duplicate Case** — providers redeliver on timeout, violating this phase's own "exactly one Case" criterion | High | Medium | The subscriber is idempotent on `external_message_id`; T21 asserts redelivery is a no-op |
| R14 | **Search index backfill** — Cases created before `search.ts` lands are invisible to global search | Medium | Medium | `search.ts` ships in slice 1a, before ingest |
| R15 | **Demo seed leaks across tenants** — SD-1…3 create users, queues and Cases; an unscoped seed is a tenant-isolation defect in a shipped artefact | Medium | Medium | Seed through the same scoped commands as production writes; T14 runs against seeded data as well as fixtures |

**No workflow stops midway.** If Phase 1 ships partially, the fallback is the existing shared
mailbox; no Case can exist in a state the UI cannot resolve.

---

## Phasing

This document is one phase of the App Spec's eight. Internally it delivers in four slices, each
independently mergeable:

| Slice | Commits | Delivers |
|---|---:|---|
| 1a Foundation | 8 | Module scaffold, entities, migrations, CRUD, settings, ACL, events |
| 1b Ingest | 7 | Inbound subscriber, auto-responder suppression, identity resolution, attach rule, webform adapter |
| 1c Inbox | 12 | Three-pane Inbox, composer, send path, `sendAsUser` widening, resolve + wrap-up, transfer |
| 1d Surfaces | 12 | Cases list, Case detail, Customer 360, host spots, injection widgets, enricher, projection contract, toast, baseline metrics, seed, i18n |

---

## Implementation Plan

Ordered; each step is one commit from `app-spec-notes/commits-by-workflow.md`.

**1a Foundation** — WF1-1 scaffold (`index.ts`, `acl.ts`, `di.ts`, `setup.ts`, `events.ts`,
`extension-points.ts`, `i18n/`, `migrations/`) → WF1-2 entities + `yarn db:generate` + review
the SQL and `.snapshot-open-mercato.json` → WF1-3 `makeCrudRoute` + OpenAPI + lock + ACL →
WF1-4 tenant settings → WF3-1 identity entity + encryption → WF1-7 status machine + events →
WF1-23 toast surface → `yarn generate`.

**1b Ingest** — WF1-5 inbound subscriber → WF1-6 auto-responder suppression → WF3-2 confidence
resolver → WF4-21 attach-window rule *(pulled forward from Phase 2 because ingest needs it)* →
WF3-4 manual-match task → CH-1/CH-2 `channel-webform` package.

**1c Inbox** — WF1-8 shell → WF1-9 list → WF1-10 thread → WF1-11 composer → WF1-12 send path →
WF1-13 `sendAsUser` widening → WF1-14 resolve + wrap-up gate → WF1-17 transfer → WF3-3 link /
unlink from the rail.

**1d Surfaces** — WF1-18 detail → WF1-19 list → WF3-5/6 Customer 360 → WF3-7 consents →
WF1-20/21 host spots → WF1-22 widgets + enricher → WF1-15 projection contract → WF1-16
projection call → WF6-1 baseline metrics → SD-1…3 seed → IX-1…2 i18n → WF1-24 integration tests.

**Validation gate** (Docker mode when a compose `app` container is up, otherwise local; the
runner is recorded in the PR):

```
yarn generate && yarn build:packages && yarn i18n:check-sync && yarn i18n:check-usage
yarn typecheck && yarn lint && yarn test && yarn build:app
```

---

## Integration Test Coverage

Per `.ai/qa/AGENTS.md`: self-contained, fixtures created in setup via API, cleaned up in
teardown, no reliance on seeded demo data.

### API paths

| # | Scenario | Asserts |
|---|---|---|
| T1 | Inbound e-mail → Case | Exactly one Case; `conversation_count = 1`; `connect.case.created` emitted once |
| T2 | Second inbound, same identity, inside the window | Attaches to the same Case; `conversation_count = 2`; no second Case |
| T3 | Second inbound, same identity, outside the window | New Case flagged `possible_duplicate` |
| T4 | Out-of-office reply | **No Case created**, no acknowledge sent (R1) |
| T5 | Bounce / DSN | No Case created |
| T6 | Reply sends | `messages.Message` + `MessageChannelLink` created; adapter invoked; `first_human_outbound_at` stamped once and never updated, with the author's `principal_kind` snapshotted |
| T7 | Reply fails at the provider | Message `failed`; **`first_human_outbound_at` NOT stamped**; the Case does not advance to `waiting_customer` |
| T8 | Resolve with an empty note | 422; Case unchanged |
| T9 | Resolve with a note | `resolved`; `CustomerInteraction` appears within 60 s; projection idempotent under replay |
| T10 | Resolve races a new inbound | 409; Case not resolved |
| T11 | Concurrent PUT on one Case | Second returns 409 with the conflict body |
| T12 | Sub-threshold identity | `customer_entity_id` null; `link_state = 'unresolved'`; manual-match task raised |
| T13 | Link, then unlink | Audit rows written; `link_state = 'unlinked'`; row not deleted |
| T14 | **Cross-tenant isolation** | A Case from tenant A is invisible to tenant B on every route |
| T15 | **Cross-customer isolation** | Agent-scoped listing never returns another customer's Case via `ids=` |
| T16 | Feature gating | Without `connect.cases.view.all`, listing returns only own Cases |
| T17 | Shared-channel authorisation | A caller without the elevated feature gets 403 on a shared channel; a caller with it succeeds; per-user channel behaviour is unchanged (R3) |
| T18 | Web-form submission → Case | Adapter maps fields; Case opens with the form topic as subject |
| T19 | Baseline metrics | Counts match the Cases created in the fixture window |
| T20 | Inbox list at 300 open Cases | Query count stays under the declared ceiling (R11) |
| T21 | Redelivered `ExternalMessage` | No second Case; `conversation_count` unchanged (R13) |
| T22 | Mutation guards on action routes | A registered guard is invoked before `/resolve`, `/transfer`, `/messages`, `/link`, `/unlink` and `PUT /settings`; a denying guard blocks the mutation and `afterSuccessCallbacks` do not run |
| T23 | Encrypted lookup | `handle_value` is unreadable at rest; lookup by `handle_value_hash` returns the identity; the unique constraint rejects a duplicate handle |

### UI paths (Playwright, headless)

| # | Scenario |
|---|---|
| U1 | Login → Inbox → select conversation → reply → message appears in the thread |
| U2 | Resolve → wrap-up required → note → Case leaves the open list |
| U3 | Unknown contact → link from the rail → 360 populates without reload |
| U4 | Cases list → filter → inline status advance → toast confirms |
| U5 | Customer 360 → all four tabs render |
| U6 | Every empty state renders with a working CTA |
| U7 | Conflict: two tabs edit one Case → the second shows the conflict bar |
| U8 | `pl` and `en` both render with no missing-key placeholders |

---

## Migration & Backward Compatibility

Audited against all 14 surfaces in `BACKWARD_COMPATIBILITY.md`.

### Additive — no deprecation needed

| Surface | Change |
|---|---|
| 1 Auto-discovery (FROZEN) | New module `connect`, new package `channel-webform`. New IDs; nothing renamed |
| 5 Event IDs (FROZEN) | Seven new `connect.*` IDs. **Frozen from first ship** — names reviewed against the App Spec glossary before merge |
| 6 Widget spot IDs (FROZEN) | Five **new** spots added to `customers`/`sales`. Adding is additive; none renamed or removed |
| 7 API routes (STABLE) | New `/api/connect/*` namespace only |
| 8 Database schema (ADDITIVE-ONLY) | New tables only. No existing column renamed or dropped |
| 9 DI names (STABLE) | Four new keys under a `connect` prefix |
| 10 ACL feature IDs (FROZEN) | Six new IDs, stored in the DB. **Renaming later requires a data migration** — reviewed before merge |
| 14 Generated contracts (STABLE) | New entries appear via `yarn generate`; no generated export renamed |

### Changes to existing contracts — mitigated

| # | Change | Surface | Classification | Migration |
|---|---|---|---|---|
| M1 | `sendAsUser` authorisation delegates to `assertCanManageChannel`; shared-channel creation, credential provisioning and sender identity are added | 3 Function signatures (STABLE) · 8 DB schema (ADDITIVE-ONLY) | **Behaviour-changing, additive shape** | Per-user callers keep identical behaviour (T17). **`messages.Message.senderUserId` NOT NULL must be relaxed** for system-authored sends — a DB contract-surface change requiring sign-off, shipped in PR A |
| M2 | `customers` exports a public interaction-projection command | 2 Types / 3 Signatures | **Additive** | New export; the module-private handler is untouched and keeps working |
| M3 | Five new injection spots in `customers`/`sales` | 6 Spot IDs (FROZEN) | **Additive** | Declared through `defineModuleExtensionPoints`; existing spots unchanged |

**No breaking change is introduced, so no deprecation bridge is required.** M1–M3 are
contributions to modules `connect` does not own and ship as **separate upstream PRs**, merged
before the `connect` PR that depends on them.

### Ordering

1. Upstream PR A — `communication_channels`: the shared-channel workstream (M1)
2. Upstream PR B — `customers` + `sales`: projection command and injection spots (M2, M3)
3. `connect` + `channel-webform` (this spec), depending on A and B

### Frozen-surface pre-merge review

Because surfaces 1, 5, 6 and 10 are FROZEN from first ship, the following are reviewed **before
the first merge**, not after: module IDs (`connect`, `channel-webform`), the six ACL feature
IDs, the seven event IDs, and the five widget spot IDs. Renaming any of them later requires the
full deprecation protocol, and the ACL IDs additionally require a data migration.

---

## Open Questions

| # | Question | Impact | Status |
|---|---|---|---|
| P1-1 | ~~Deterministic encryption vs a hashed lookup column?~~ | — | **CLOSED by the pre-implementation audit.** The platform already provides `hashField` on the encryption map, used by `auth`, `customer_accounts` and `messages`. `handle_value_hash` carries the unique index. The question was answerable from the codebase and should not have been opened |
| P1-2 | Does the `customers` projection command land upstream this cycle? | Blocks WF1-15/16; fallback is subscriber inversion (R4) | **OPEN — confirm before 1d** |
| P1-3 | ~~Is `possible_duplicate` a status, a tag, or a boolean?~~ | — | **DECIDED: a tag.** The status enum stays frozen as the App Spec declares it. Seeded in commit 6; needs a `pl` label per OQ-4 |
| P1-4 | Inherited: OQ-3 (re-baseline) | This phase ships the measurement that closes it | Carried |

---

## Final Compliance Report

Pre-implementation analysis: `.ai/specs/analysis/ANALYSIS-2026-08-21-connect-phase-1.md`.

| Check | Result |
|---|---|
| **Backward compatibility** — all 14 surfaces | **PASS with one flagged change.** PR A relaxes `messages.Message.senderUserId` NOT NULL (surface 8, needs sign-off); PR B is a stability commitment on an existing command plus additive injection spots; PR D adds `auth.User.principal_kind` (additive, default `human`). Order A→B→D→this |
| Required sections | **PASS** — all present |
| Module structure and auto-discovery | **PASS** after correction to `packages/<pkg>/src/modules/<module>/` |
| `setup.ts` declares `defaultRoleFeatures` | PASS |
| zod validation in `data/validators.ts`, types via `z.infer`, no `any` | PASS after remediation |
| Encryption maps + `findWithDecryption` + `hashField` | PASS after remediation |
| Tenant/organization scoping on every table and route | PASS |
| `makeCrudRoute` with `indexer`; per-method route `metadata` | PASS after remediation |
| **Mutation guards on all six action routes** | PASS after remediation — was the single critical finding |
| `CrudForm` / `DataTable` / `useGuardedMutation` / `apiCall` | PASS after remediation |
| Events via `createModuleEvents()` with `as const`; idempotent subscribers | PASS after remediation |
| Commands undoable with `extractUndoPayload()`; send explicitly not undoable | PASS after remediation |
| Cache via DI | PASS — Phase 1 declares no caching as a deliberate decision |
| Design system: no arbitrary values, no hardcoded status colours, lucide icons, `aria-label` | PASS after remediation |
| i18n keys, no hardcoded user-facing strings | PASS |
| Keyboard shortcuts on dialogs | PASS |
| Optimistic locking incl. non-`CrudForm` paths | PASS |
| Integration coverage for all API and key UI paths | PASS — 23 API + 8 UI scenarios, including both isolation tests |
| Risks with severity and mitigation | PASS — 15 risks after the audit added five |

**Verdict: ready to implement.** Four critical and six major findings from the audit are
applied; one open question (P1-1) was closed by it. The two remaining open questions (P1-2
upstream timing) does not block slice 1a.

---

## Changelog

### 2026-08-21
- Initial Phase 1 feature spec, derived from App Spec §7 Phase 1 (40 commits).
- Round-3 remediation: body swept to v3 — D4 (existing projection command), D5/R3/T17/M1 (shared-channel workstream, no opt-out flag), D7 (per-`handle_type` thresholds), T6/T7 (`first_human_outbound_at`), the upstream ordering (A→B→D), the compliance report, and P1-3 decided as a tag. Declared `first_human_outbound_at` + its principal snapshot so Phase 2's backfill is derivable. Corrected the `inbox_ops` rate-limiter claim. Froze ten event IDs.
- Applied the pre-implementation analysis: mutation-guard wiring on six action routes;
  `encryption.ts` with `defaultEncryptionMaps` and `hashField`; zod validators; corrected module
  paths to the package convention; `useGuardedMutation`, `apiCall`, `createModuleEvents`,
  per-method route `metadata`, subscriber idempotency, command/undo declarations, cache
  decision, loading/error states, DS and icon rules; five added risks (R11–R15) with four new
  tests (T20–T23); closed P1-1; added this compliance report.

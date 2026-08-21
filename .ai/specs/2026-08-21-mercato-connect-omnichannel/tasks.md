# Tasks: Mercato Connect — P1 Slice

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Data model**: [data-model.md](./data-model.md) | **Contracts**: [contracts/](./contracts/)
**Branch**: `cez/a5fd2e52` | **Generated**: 2026-08-21 | **Revised**: 2026-08-21 (F1 fix; ANALYSIS-051 C1–C7 closed; ANALYSIS-052 D1–D5 closed)

## Scope

**P1 only — User Story 1 (cross-channel unified thread) and User Story 2 (AI assistance).** P2/P3 stories are deliberately out of scope and generate no tasks here.

This means exactly one new module: `conversations`, in a new workspace package. Everything below lives under:

- `packages/contact-center/` — the new workspace package
- `packages/contact-center/src/modules/conversations/` — abbreviated **`<M>/`** in task paths below

Explicitly **not** in this slice: `service_tickets`, `contact_queues`, `telephony`, `contact_campaigns`, `bot_intents`, `contact_quality`, `contact_analytics`, `packages/channel-meta/`, `packages/telephony-<vendor>/`, the Customer 360 screen (US4), the settings switchboard (US6), and the customer portal pages (US11).

### Scope boundaries worth stating

Four places where P1 touches a P2/P3 concern, and where the line falls:

1. **Identity.** P1 needs identifier→customer resolution to bind channels into one thread, so `CustomerIdentity` and `IdentityMergeAudit` ship here and every automatic merge is recorded from day one. **Merge reversal ships with them (T032, T039, T059)** — P1 must never create a merge it cannot undo, because a wrong merge is the Critical-severity risk R1 and reversibility is its stated mitigation. The *manual* merge-initiation and re-check UI remain US4 (P2).
2. **SLA.** `ServiceConversation.sla_deadline_at` mirrors a ticket's deadline, and tickets are P2. P1 therefore renders SLA only when `service_tickets` is present and hides it otherwise — the degradation path required by FR-091 (T050).
3. **Routing.** FR-012 take-next routes "per the active routing mode", and queues are P2. P1 orders by priority and last activity within the conversation list, degrading cleanly when `contact_queues` is absent (T027).
4. **Channels.** FR-008 names nine channels. P1 supports only those with an existing adapter — e-mail (incl. Gmail/IMAP), web chat, SMS, WhatsApp. Messenger and Instagram need `packages/channel-meta` (P2); web-form and portal channels need adapters not yet written; phone needs `telephony` (P2). FR-008 is therefore **partially** satisfied in this slice, by design.

### Tests are required, not optional

The skill treats tests as opt-in. This repo does not: root `AGENTS.md` and `.ai/qa/AGENTS.md` require integration coverage for all affected API paths and key UI paths **in the same change**. Test tasks below are therefore mandatory deliverables, not a TDD preference.

### Runner

Local mode — `corepack yarn <script>`. Bare `yarn` is not on PATH, and the running `open-mercato-app-1` container is a prod image with no source bind mount, so `scripts/docker-exec.mjs` would validate the image rather than this worktree.

---

## Phase 1: Setup

- [ ] T001 Create workspace package manifest at `packages/contact-center/package.json` (name `@open-mercato/contact-center`, deps on `@open-mercato/core`, `@open-mercato/shared`, `@open-mercato/ui`, `@open-mercato/events`, `@open-mercato/queue`, `@open-mercato/cache`, `@open-mercato/ai-assistant`), mirroring `packages/content/package.json`
- [ ] T002 [P] Create `packages/contact-center/tsconfig.json` mirroring `packages/content/tsconfig.json`
- [ ] T003 [P] Confirm the root `package.json` workspaces glob covers `packages/contact-center` and that `corepack yarn build:packages` picks it up in the correct order; add it explicitly in `package.json` if the glob does not
- [ ] T004 Create module entry at `<M>/index.ts` exporting `metadata` with `id: 'conversations'`, title and description
- [ ] T005 Run `corepack yarn generate` and confirm `conversations` appears in `apps/mercato/.mercato/generated/modules.generated.ts`

**Checkpoint**: the module is discovered by the generator and the monorepo still builds.

---

## Phase 2: Foundational (blocking — all user stories depend on this)

- [ ] T006 [P] Declare ACL features in `<M>/acl.ts` per [contracts/acl.md](./contracts/acl.md): `conversations.view`, `.reply`, `.assign`, `.transfer`, `.close`, `.identity.view`, `.identity.manage`
- [ ] T007 [P] Declare events in `<M>/events.ts` via `createModuleEvents` with `as const` per [contracts/events.md](./contracts/events.md), setting `clientBroadcast: true` on `conversation.created/assigned/replied/channel_bound/closed/reopened` and `delivery.failed`
- [ ] T008 [P] Create locale files `<M>/i18n/pl.json` and `<M>/i18n/en.json` with the `conversations.*` key namespace (Polish is the reference copy for tone per spec Assumption 2)
- [ ] T009 Define MikroORM entities in `<M>/data/entities.ts` — `ServiceConversation`, `ConversationChannelBinding`, `CustomerIdentity`, `IdentityMergeAudit`, `AiSuggestionOutcome` — per [data-model.md](./data-model.md), using decorators from `@mikro-orm/decorators/legacy` and types from `@mikro-orm/core`; `ServiceConversation` and `CustomerIdentity` MUST carry `updated_at`, the three append-only entities MUST NOT
- [ ] T010 Define Zod schemas and inferred types in `<M>/data/validators.ts` for every create/update/action payload, including the conversation state machine's legal transitions; no `any`
- [ ] T011 [P] Declare encrypted columns in `<M>/encryption.ts` `defaultEncryptionMaps` — `CustomerIdentity.identifier`, `ServiceConversation.closing_summary` — and add the deterministic `identifier_hash` derivation helper in `<M>/lib/identity-hash.ts`
- [ ] T012 Generate the migration with `corepack yarn db:generate`, keep only `conversations` SQL, and commit it with the updated `<M>/migrations/.snapshot-open-mercato.json` — do NOT run `db:migrate`
- [ ] T013 Create `<M>/setup.ts` with `defaultRoleFeatures` for admin/employee per [contracts/acl.md](./contracts/acl.md), and declare the module as core/non-disableable (FR-072)
- [ ] T014 [P] Create `<M>/di.ts` registrations and the module-local optional-peer helper `<M>/lib/tryResolve.ts` returning `undefined` when a peer is absent (FR-091)
- [ ] T015 [P] Define the cache strategy in `<M>/lib/cache-keys.ts` — resolve the cache via DI (`container.resolve('cache') as CacheStrategy` from `@open-mercato/cache`), never `new Redis(...)` or raw SQLite; every cached entry carries `tenant:<id>` and `org:<id>` tags plus a `conversations:list` / `conversations:thread:<threadId>` resource tag; document which write path invalidates which tag. The map MUST cover **every write path, not every command** — subscriber- and worker-driven writes (T041) count, and they are the highest-volume ones (ANALYSIS-051 C2, ANALYSIS-052 D1, `packages/cache/AGENTS.md`)
- [ ] T016 [P] Create the OpenAPI factory at `<M>/api/openapi.ts` using `createCrudOpenApiFactory({ defaultTag: 'Conversations' })`
- [ ] T017 [P] Declare custom-entity ids in `<M>/ce.ts` so `E.conversations.*` generated ids exist
- [ ] T018 Run `corepack yarn generate` then `corepack yarn mercato auth sync-role-acls` so existing tenants receive the new ACL grants

**Checkpoint**: schema, permissions, events and DI exist. No behaviour yet. `corepack yarn typecheck` passes.

---

## Phase 2A: Peer read facades (blocking — closes ANALYSIS-051 C1)

`.ai/lessons.md` → *"Cross-module query precedent is not permission to copy storage coupling"*: peer-module table access MUST sit behind a DI service **owned by the source module**. The entity-class registrations in `communication_channels/di.ts` are explicitly commented "for EntityManager lookups by string" — they are not a read API. The sanctioned precedent in that same file is `communicationChannelsSendAsUser`, an in-process facade cross-module callers resolve instead of self-calling.

Both facades below are **new DI keys** — BC surface #9, additive, no deprecation bridge required. They are additive changes to platform modules and must not alter any existing behaviour.

- [ ] T019 Add a source-owned read facade to `packages/core/src/modules/communication_channels/lib/thread-reader.ts` and register it in that module's `di.ts` as `communicationChannelsThreadReader` — exposes `getThreadBindings({ threadId, tenantId, organizationId })` and `getBindingsForCustomer({ customerId, tenantId, organizationId })`, returning channel bindings and their external-conversation refs. Batched (no N+1 across bindings), scope-mandatory, returns typed results with no ORM entities leaking across the boundary. Log via `createLogger` when the facade is unreachable so a degraded thread is distinguishable from an empty one (ANALYSIS-052 D5)
- [ ] T020 Create `packages/core/src/modules/messages/di.ts` (the module currently has none) registering `messagesThreadReader`, backed by a new `packages/core/src/modules/messages/lib/thread-reader.ts` — exposes `getThreadMessages({ threadId, tenantId, organizationId, limit, before })` returning a scope-filtered, chronologically ordered, batched projection of `Message` rows (author, direction, channel, timestamp, body, delivery state). Never returns rows outside the requested scope. Log via `createLogger` when unreachable so a degraded thread is distinguishable from an empty one (ANALYSIS-052 D5)
- [ ] T021 [P] Add unit tests at `packages/core/src/modules/messages/__tests__/thread-reader.test.ts` and `packages/core/src/modules/communication_channels/__tests__/thread-reader.test.ts` asserting scope enforcement, batching (no per-row query), and empty-result vs missing-thread distinction
- [ ] T022 [P] Document both facades in `packages/core/src/modules/messages/AGENTS.md` and `packages/core/src/modules/communication_channels/AGENTS.md` under a "Public Contract Surfaces" table, matching the `staff` module's AGENTS.md precedent, so the new DI keys are discoverable and BC-tracked

**Checkpoint**: `conversations` has a sanctioned, batched, scope-safe read path to both peer modules. No task in Phase 3 reads a peer table directly.

---

## Phase 3: User Story 1 — Cross-channel unified thread (P1)

**Goal**: an agent sees one chronological thread per customer spanning several channels, with commerce context beside it, and can reply on any connected channel and close the case.

**Independent test**: seed one customer with identifiers on two channels and one delayed order; open the inbox; confirm a single thread shows both channels in order, order context renders without navigating away, a reply sent on a different channel than the inbound one lands in the same thread, and closing advances to the next case.

### Domain logic

- [ ] T023 [US1] Implement identifier→customer resolution with confidence scoring in `<M>/lib/identity-resolver.ts`, delegating per-channel lookup to `communication_channels`' existing contact resolver via `tryResolve` and writing `CustomerIdentity` + `IdentityMergeAudit` rows (FR-026)
- [ ] T024 [US1] Implement thread aggregation in `<M>/lib/thread-aggregator.ts` — consume the peer read facades from T019/T020 through `tryResolve` (never `em.find` against peer tables, never import peer entities) and assemble the unified message list including bot and system entries; degrade with a named explanation when either facade is absent (FR-009, FR-091, research R-01, ANALYSIS-051 C1)
- [ ] T025 [P] [US1] Implement the conversation state machine guard in `<M>/lib/conversation-state.ts` (open → assigned → closed, reopen), rejecting illegal transitions
- [ ] T026 [P] [US1] Implement commerce-context assembly in `<M>/lib/order-context.ts` — order id, status, items, carrier, last tracking event — resolved through `tryResolve` so the panel degrades when `sales` is absent (FR-032)
- [ ] T027 [US1] Implement take-next ordering in `<M>/lib/routing.ts` — priority then last activity, degrading cleanly when `contact_queues` is absent (FR-012)

### Commands

- [ ] T028 [US1] Implement create/update commands in `<M>/commands/conversation.ts` using `runCrudCommandWrite`, passing `indexer: { entityType, cacheAliases }` to **both** `emitCrudSideEffects` and `emitCrudUndoSideEffects`, and capturing a typed undo payload readable by `extractUndoPayload` (precedent: `packages/core/src/modules/planner/commands/availability.ts`) (ANALYSIS-051 C3)
- [ ] T029 [US1] Implement assign / take-next / transfer commands in `<M>/commands/assignment.ts`, each with a typed undo payload and `cacheAliases` on both side-effect paths so reassignment is reversible (FR-012, FR-015, ANALYSIS-051 C3)
- [ ] T030 [US1] Implement the close command in `<M>/commands/close.ts` — writes `closing_summary`, sets `closed_at`, emits `conversation.closed`, and captures an undo payload restoring the prior state so a mistaken close is reversible (FR-016, ANALYSIS-051 C3)
- [ ] T031 [US1] Implement the cross-channel reply command in `<M>/commands/reply.ts` — resolve the target `CommunicationChannel`, call the existing `ChannelAdapter.sendMessage` **under an explicit timeout** (configurable, default 15 s) — expiry maps to the same 422 path as a provider rejection, naming the channel and preserving the draft, never a hung request (ANALYSIS-052 D2). Write a `Message` on the same `threadId` plus a `MessageChannelLink`. **No undo payload** — a delivered outbound message cannot be recalled; record the deliberate exemption in the command's header comment rather than leaving it to inference (FR-013, research R-05, ANALYSIS-051 C3)
- [ ] T032 [US1] Implement the merge-reversal command in `<M>/commands/identity-merge.ts` — read `IdentityMergeAudit.prior_state`, restore the pre-merge identity assignment, detach any `ConversationChannelBinding` the merge created by setting `detached_at`, and write a `split` audit row. Invalidate the `conversations:list` cache tag for both affected customers (FR-027, mitigates risk R1)

### API

- [ ] T033 [US1] Implement the conversations CRUD route at `<M>/api/conversations/route.ts`, caching the list read under the T015 tags and invalidating after commit (never inside `withAtomicFlush`), with `makeCrudRoute`, `indexer: { entityType: 'conversations:service_conversation' }`, filters for `state`/`channelType`/`assignedUserId`/`q`, and `updatedAt` in list and detail responses
- [ ] T034 [US1] Implement `POST /api/conversations/conversations/take-next` at `<M>/api/conversations/take-next/route.ts`, returning 204 when nothing is takeable (FR-012 + empty-queue edge case); wire `runMutationGuards` with operation `update`
- [ ] T035 [US1] Implement `POST /api/conversations/conversations/[id]/reply` at `<M>/api/conversations/[id]/reply/route.ts`, returning 422 naming the channel and reason on provider rejection so the client can preserve the draft (FR-013 + reply-channel-unavailable edge case); guard operation `update`
- [ ] T036 [P] [US1] Implement `POST .../[id]/transfer` at `<M>/api/conversations/[id]/transfer/route.ts`; guard operation `update`
- [ ] T037 [P] [US1] Implement `POST .../[id]/close` at `<M>/api/conversations/[id]/close/route.ts`; guard operation `update`
- [ ] T038 [P] [US1] Implement read-only `GET /api/conversations/identities` at `<M>/api/identities/route.ts` returning merged identifiers with confidence and match method (FR-026)
- [ ] T039 [P] [US1] Implement `POST /api/conversations/identities/split` at `<M>/api/identities/split/route.ts`, gated on `conversations.identity.manage`; guard operation `update` (FR-027)
- [ ] T040 [P] [US1] Export per-method `metadata` (`requireAuth` + `requireFeatures`) from every route file created in T033–T039 — read authorisation lives here, not only in the mutation-guard layer which covers writes; never a top-level `export const requireAuth` (ANALYSIS-051 C4)
- [ ] T041 [P] [US1] Export `openApi` from each route file in `<M>/api/conversations/route.ts`, `<M>/api/conversations/take-next/route.ts`, `<M>/api/conversations/[id]/{reply,transfer,close}/route.ts`, `<M>/api/identities/route.ts` and `<M>/api/identities/split/route.ts`

### Subscribers and indexing

- [ ] T042 [US1] Create the inbound-binding subscriber at `<M>/subscribers/bind-inbound-channel.ts` (`persistent: true`) folding a new external conversation into a `ServiceConversation` via the T019 facade — no direct peer-table reads (ANALYSIS-051 C1). Idempotency is a **mechanism, not an assertion**: do not read-then-create. Attempt the insert and let the `unique (tenant_id, organization_id, thread_id)` index arbitrate, catching the unique violation and resolving to the existing conversation, so two inbound messages racing on different channels for one thread cannot produce two conversations or a retry storm (ANALYSIS-052 D3). Invalidate the `conversations:list` and `conversations:thread:<threadId>` tags after commit — this is the highest-frequency write in the product (ANALYSIS-052 D1)
- [ ] T043 [P] [US1] Create the query-index subscriber at `<M>/subscribers/index-conversation.ts` (`persistent: false` so read-your-writes stays inline)
- [ ] T044 [P] [US1] Declare search configuration in `<M>/search.ts` for conversation subject, customer name and message body. **Exclude `CustomerIdentity.identifier`** — it is encrypted at rest, and indexing it would place decrypted phone numbers, e-mail addresses and social handles in the search document; assert the exclusion in the tenancy spec (ANALYSIS-051 C6)

### UI

- [ ] T045 [US1] Create the inbox page at `<M>/backend/inbox/page.tsx` with `<M>/backend/inbox/page.meta.ts` declaring `requireAuth` + `requireFeatures: ['conversations.view']` and a `nav` block in the service group
- [ ] T046 [P] [US1] Build the conversation list at `<M>/components/inbox/ConversationList.tsx` using `DataTable` with table id `conversations:inbox`, including the empty state naming the missing thing and its resolving action
- [ ] T047 [P] [US1] Build channel filters at `<M>/components/inbox/ChannelFilterBar.tsx` using `SegmentedControl`/`Tag`, with an all-channels option and a filtered-empty state that names the active filter and offers to clear it (FR-011)
- [ ] T048 [US1] Build the thread view at `<M>/components/inbox/ConversationThread.tsx` using `ActivityFeed`, rendering inbound/outbound/bot/system entries with channel and timestamp, and surfacing per-message delivery failure with retry (FR-009 + send-fails edge case)
- [ ] T049 [P] [US1] Build the identity-match panel at `<M>/components/inbox/IdentityMatchPanel.tsx` showing merged identifiers with confidence and a reversal action for `conversations.identity.manage` holders (FR-026, FR-027)
- [ ] T050 [P] [US1] Build the SLA indicator at `<M>/components/inbox/SlaIndicator.tsx` using `{property}-status-{status}-{role}` tokens, hidden when `service_tickets` is absent (FR-017, FR-091)
- [ ] T051 [US1] Build the composer at `<M>/components/inbox/Composer.tsx` — `Textarea`, Enter sends, Shift+Enter newlines, reply-channel selector visible before sending, template and attach actions (FR-013, FR-014)
- [ ] T052 [P] [US1] Build the customer context panel at `<M>/components/inbox/CustomerContextPanel.tsx` showing value metrics, tags, VIP flag and order context with its case actions (FR-032)
- [ ] T053 [P] [US1] Add the shared data-call helpers in `<M>/components/inbox/useConversationMutations.ts` wrapping every write in `useGuardedMutation(...).runMutation(...)` with `retryLastMutation` in the injection context and every read in `apiCall` — no raw `fetch`
- [ ] T054 [P] [US1] Add the sidebar menu widget at `<M>/widgets/injection/inbox-menu.ts` and map it in `<M>/widgets/injection-table.ts` to `menu:sidebar:main` with stable id `conversations-inbox-open` and `labelKey` only
- [ ] T055 [P] [US1] Add all US1 user-facing strings to `<M>/i18n/pl.json` and `<M>/i18n/en.json`

### Tests

- [ ] T056 [US1] Write the V1 integration spec at `<M>/__integration__/cross-channel-thread.spec.ts` covering all six US1 acceptance scenarios, creating fixtures in setup and removing them in teardown
- [ ] T057 [P] [US1] Write the SC-018 assertion in `<M>/__integration__/single-record.spec.ts` — the same conversation read through a pre-existing platform surface returns identical message history
- [ ] T058 [P] [US1] Write the tenancy isolation spec at `<M>/__integration__/tenancy.spec.ts` — each of the five new entities unreachable across tenants by id, list, search and export (FR-082, SC-016)
- [ ] T059 [P] [US1] Write the merge-reversal integration spec at `<M>/__integration__/identity-reversal.spec.ts` — an automatic merge is undone, the two customers' threads separate again, and no message from either is readable from the other afterwards (FR-027, SC-006, risk R1)
- [ ] T060 [P] [US1] Write unit tests at `<M>/__tests__/thread-aggregator.test.ts` and `<M>/__tests__/identity-resolver.test.ts` covering multi-channel folding, unrecognised caller, and confidence scoring
- [ ] T061 [P] [US1] Write cache-invalidation tests at `<M>/__tests__/cache-invalidation.test.ts` — every write path invalidates its declared tags and no stale list is served after a reply, assignment or close (T028–T032) **or after an inbound message arrives via T041**; include a concurrency case asserting two racing inbound messages for one thread yield exactly one `ServiceConversation` (ANALYSIS-051 C2, ANALYSIS-052 D1/D3/D4)
- [ ] T062 [P] [US1] Write undo tests at `<M>/__tests__/command-undo.test.ts` — assign, close and identity-merge each round-trip through `extractUndoPayload` and restore prior state; reply asserts its documented no-undo exemption (ANALYSIS-051 C3)

**Checkpoint**: US1 is independently demonstrable. V1 passes. This is the MVP.

---

## Phase 4: User Story 2 — AI assistance the agent stays in control of (P1)

**Goal**: the agent gets a case summary, a grounded reply suggestion with cited sources and concrete next actions — and nothing is ever sent without them seeing it.

**Independent test**: open a seeded conversation with assistance enabled; confirm summary, suggestion, next actions and sources render; insert the suggestion, edit it, send; confirm rejection is recorded; disable assistance and confirm the inbox still works fully.

### AI wiring

- [ ] T063 [US2] Define the case-summary and reply-suggestion agents in `<M>/ai-agents.ts` with `defineAiAgent`, taking provider/model from the installation's existing AI configuration (FR-018, research R-08)
- [ ] T064 [US2] Define next-action tools in `<M>/ai-tools.ts` with `defineAiTool`, routing every writing tool through `prepareMutation` so the agent approves before it mutates (FR-022)
- [ ] T065 [US2] Implement structured citation assembly in `<M>/lib/suggestion-sources.ts` — knowledge article, policy, order/stock data or prior contact; an empty source list is a contract violation, not a valid suggestion (FR-021)
- [ ] T066 [US2] Implement outcome recording in `<M>/commands/suggestion-outcome.ts` writing `AiSuggestionOutcome` for `inserted`/`inserted_edited`/`rejected`/`rewrite_requested`/`ignored`, including `edit_distance` on edited inserts (FR-020, SC-004)
- [ ] T067 [P] [US2] Implement `POST /api/conversations/ai/suggestion-outcome` at `<M>/api/ai/suggestion-outcome/route.ts` with `openApi` export; guard operation `update`
- [ ] T068 [US2] Write `ignored` outcomes on conversation close when a suggestion was shown but never acted on, in `<M>/commands/close.ts` — otherwise acceptance rate is computed only over engaged suggestions and flatters SC-004

### UI

- [ ] T069 [US2] Build the assist panel at `<M>/components/inbox/AiAssistPanel.tsx` rendering summary, suggestion, next actions and sources; absent entirely when assistance is disabled (FR-018, FR-023)
- [ ] T070 [P] [US2] Build the suggestion card at `<M>/components/inbox/SuggestionCard.tsx` with insert / rewrite / reject actions, where insert places **editable** text into the composer and sends nothing (FR-019)
- [ ] T071 [P] [US2] Build the next-action list at `<M>/components/inbox/NextActionList.tsx` showing each action with its one-line rationale and reporting explicit success or failure on run (FR-022 + AI-action-fails edge case)
- [ ] T072 [P] [US2] Build the source list at `<M>/components/inbox/SuggestionSources.tsx` (FR-021)
- [ ] T073 [US2] Implement the editable after-contact summary in the close flow at `<M>/components/inbox/CloseConversationDialog.tsx`, with `Cmd/Ctrl+Enter` submit and `Escape` cancel (FR-024)
- [ ] T074 [P] [US2] Render the unavailable state in `<M>/components/inbox/AiAssistPanel.tsx` when AI is unreachable or below confidence, stating why, while leaving the inbox fully usable (AI-unavailable edge case)
- [ ] T075 [P] [US2] Add all US2 user-facing strings to `<M>/i18n/pl.json` and `<M>/i18n/en.json`

### Tests

- [ ] T076 [US2] Write the V2 integration spec at `<M>/__integration__/ai-assist.spec.ts` covering all six US2 acceptance scenarios
- [ ] T077 [US2] Write the SC-005 negative assertion at `<M>/__integration__/never-auto-send.spec.ts` — no message reaches a customer without an explicit agent send; this MUST run on every build
- [ ] T078 [P] [US2] Write unit tests at `<M>/__tests__/suggestion-outcome.test.ts` covering acceptance-rate computation including `ignored` and `inserted_edited`

**Checkpoint**: US2 complete. V1 and V2 both pass — the P1 slice is shippable.

---

## Phase 5: Polish & Cross-Cutting

- [ ] T079 [P] Add the module to `packages/core/src/__tests__/module-decoupling.test.ts` and assert every capability degrades with a named explanation when `sales`, `service_tickets` or `contact_queues` is absent (FR-091)
- [ ] T080 [P] Assert in `packages/core/src/__tests__/module-decoupling.test.ts` that no platform module imports or hard-requires `conversations` — the upstream isomorphism guarantee
- [ ] T081 [P] Add a render-budget assertion to `<M>/__integration__/cross-channel-thread.spec.ts` measuring conversation-view time to interactive against the SC-003 two-second budget
- [ ] T082 [P] Declare translatable fields in `<M>/translations.ts` if any conversation field needs per-locale content
- [ ] T083 [P] Run `corepack yarn i18n:check-hardcoded` and `corepack yarn i18n:check-values` against `<M>/`; resolve every new finding — the source prototype is Polish-only and hard-codes every string, so this is the highest-yield check in this feature
- [ ] T084 [P] Run the `om-ds-guardian` review over all new `.tsx` under `<M>/components/`; confirm no hardcoded status colours, no arbitrary values, no `dark:` overrides on semantic tokens, no raw `<button>`/`<input type="checkbox">`
- [ ] T085 Run the full validation gate in local mode from the repo root: `corepack yarn build:packages && corepack yarn generate && corepack yarn build:packages && corepack yarn i18n:check-sync && corepack yarn i18n:check-usage && corepack yarn typecheck && corepack yarn test && corepack yarn build:app`
- [ ] T086 Capture inbox screenshots for the PR per the `screenshots` label convention, and walk the manual checks in [quickstart.md](./quickstart.md) § Manual verification (SC-002, SC-017)
- [ ] T087 Update the Final Compliance Report and Changelog in `.ai/specs/2026-08-21-mercato-connect-omnichannel.md` with actual gate results

---

## Dependencies

```
Phase 1 (Setup)
    ↓
Phase 2 (Foundational) ── blocks everything
    ↓
Phase 2A (Peer read facades) ── blocks Phase 3; lands in packages/core
    ↓
Phase 3 (US1) ──────────→ Phase 4 (US2)
    ↓                          ↓
    └──────────→ Phase 5 (Polish) ←┘
```

- **Phase 2A blocks Phase 3.** T024 (thread aggregation) and T041 (inbound binding) consume the facades; without them the only way to implement either is a direct peer-table read, which is the coupling ANALYSIS-051 C1 exists to prevent.
- **US2 depends on US1** — the assist panel renders inside the inbox and the outcome rows reference `ServiceConversation`. This is the one genuine inter-story dependency in the slice.
- Within Phase 2: T009 blocks T010, T011, T012. T006 blocks T013. T018 requires T006 and T013.
- Within Phase 3: T023–T027 (lib) block T028–T032 (commands), which block T033–T041 (API), which block T045–T055 (UI). Tests T056–T062 come last.
- **T032 depends on T023, and MUST ship in the same increment.** Reversal reads the audit rows the resolver writes; shipping T023 without T032 recreates analyze finding F1 — automatic merges with no way to undo them.
- Within Phase 4: T063–T066 block T067–T068, which block T069–T075.

## Parallel execution examples

**Phase 2** — after T009 lands:
```
T006 acl.ts    T007 events.ts    T008 i18n scaffolding
T011 encryption.ts    T014 di.ts    T015 cache-keys.ts    T016 openapi.ts    T017 ce.ts
```

**Phase 2A** — the two facades are independent modules:
```
T019 communication_channels facade    T020 messages facade
then T021 facade unit tests    T022 AGENTS.md contract docs
```

**Phase 3 API** — after commands land:
```
T036 transfer    T037 close    T038 identities read    T039 identities split    T040 openApi exports
```

**Phase 3 UI** — after the API layer lands:
```
T046 ConversationList    T047 ChannelFilterBar    T049 IdentityMatchPanel
T050 SlaIndicator    T052 CustomerContextPanel    T053 mutation helpers
T054 menu widget    T055 i18n keys
```

**Phase 3 tests** — six specs in parallel:
```
T057 single-record    T058 tenancy    T059 identity-reversal
T060 unit tests    T061 cache-invalidation    T062 command-undo
```

**Phase 4 UI** — after T069:
```
T070 SuggestionCard    T071 NextActionList    T072 SuggestionSources    T074 unavailable state    T075 i18n keys
```

**Phase 5** — everything except T085/T086/T087:
```
T079 T080 decoupling    T081 perf budget    T082 translations    T083 i18n checks    T084 DS review
```

## Implementation strategy

**MVP = Phase 1 + Phase 2 + Phase 3 (US1).** A working omnichannel inbox: one thread per customer across channels, cross-channel reply, close with summary, and reversible identity merging. Demonstrable to a stakeholder and independently valuable without any AI.

**Ship increment 2 = Phase 4 (US2).** AI assist turns the inbox from *workable* into *fast*, and it is the half most likely to need iteration on prompt quality — which is exactly why it should not block the thread work landing.

**Then stop and re-plan.** Do not generate P2 tasks until P1 is merged. The thread aggregate is the load-bearing assumption of this whole feature (research R-01), and building it will teach you things about `ChannelThreadMapping` fan-out and identity confidence that should feed back into the P2 design.

**Two decisions stay open** and do not block this slice: R-10 (telephony vendor) and R-12 (reporting aggregation). Both are P2/P3 concerns.

---

## Task summary

| Phase | Tasks | Count |
|---|---|---|
| Phase 1 — Setup | T001–T005 | 5 |
| Phase 2 — Foundational | T006–T018 | 13 |
| Phase 2A — Peer read facades | T019–T022 | 4 |
| Phase 3 — US1 | T023–T062 | 40 |
| Phase 4 — US2 | T063–T078 | 16 |
| Phase 5 — Polish | T079–T087 | 9 |
| **Total** | | **87** |

Four of the 87 (Phase 2A) land in `packages/core`, not the new package — they are additive facades on `messages` and `communication_channels`. Everything else is inside `packages/contact-center/`.

## Revision log

| Date | Change |
|---|---|
| 2026-08-21 | **ANALYSIS-051 C4 and C6 closed.** C4 — new T040: every route file exports per-method `metadata` (`requireAuth` + `requireFeatures`), because the mutation-guard layer covers writes only and read authorisation had no stated home. C6 — T043 now excludes the encrypted `CustomerIdentity.identifier` from the search document, so decrypted phone numbers, e-mail addresses and social handles cannot reach the index. Task count 86 → 87. |
| 2026-08-21 | **ANALYSIS-052 D1–D5 closed** (pass-2 audit, code-review checklist dimension). D1 — T041 now invalidates the list and thread cache tags, and T015's map is restated as *every write path, not every command*; the inbound path is the highest-volume write and had no invalidation at all. D2 — T031 calls `ChannelAdapter.sendMessage` under an explicit timeout (default 15 s) mapping to the existing 422 path; "timeout" previously appeared zero times in the artifact set. D3 — T041's idempotency is now a mechanism: insert-and-catch on the `unique (tenant, org, thread_id)` index instead of read-then-create. D4 — T061 widened to cover the inbound path plus a two-racing-messages concurrency case. D5 — both Phase 2A facades log the degraded path via `createLogger`. No new tasks; count stays 86. |
| 2026-08-21 | **ANALYSIS-051 C1/C2/C3 closed.** C1 — new **Phase 2A** (T019–T022): source-owned read facades `communicationChannelsThreadReader` and a brand-new `messages/di.ts` + `messagesThreadReader`, so no task reads a peer table directly; T024/T041 rewritten to consume them via `tryResolve`. C2 — T015 cache-key strategy (DI-resolved cache, `tenant:`/`org:` + resource tags, per-write-path invalidation), invalidation folded into T033, tested by T061. C3 — undo payloads on T028–T032 with `cacheAliases` on both side-effect paths, tested by T062; T031 (reply) carries a documented no-undo exemption. Task count 79 → 86. |
| 2026-08-21 | **F1 fix** (from `/speckit-analyze`): merge reversal pulled from US4/P2 into P1 — added T032 (reversal command), T039 (split endpoint), T049 (identity-match panel with reversal action), T059 (reversal integration spec). P1 no longer creates identity merges it cannot undo. Also folded in: F4 — scope boundary 4 stating which channels P1 actually supports; F5 — T081 for the SC-003 render budget; F11 — `CloseCaseDialog` → `CloseConversationDialog`; F12 — bare `yarn` → `corepack yarn` in T003. |

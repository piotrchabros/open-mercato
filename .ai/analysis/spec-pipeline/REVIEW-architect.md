# Adversarial review — **Architect** lens

**Target:** `.ai/specs/2026-08-21-connect-phase-1-merged.md`
**Role:** Architect reviewer (platform claims vs. source behaviour). Gate 1's ledger checked whether cited
paths exist and do what is claimed; this pass checks claims that survive the ledger but fail on
**behaviour, reachability, or integration**.
**Method:** every finding below cites code opened in this worktree at `c0e50a8fa`. No claim is asserted
from a filename, a type, or a doc comment. Other reviewers' files were not read.

---

## Critical

### C1 — PR C cannot produce its own declared projection: `messages` owns neither direction, channel type, delivery status, nor attachments

**Spec location:** § Blocking upstream PRs, PR **C**; § Reading peer data; T-UP-04; § UI ("thread rendering
`in`/`out`/`sys` distinctly").

**Defect.** The carried-forward facade contract
(`.ai/specs/2026-08-21-mercato-connect-omnichannel/contracts/peer-read-facades.md:58-69`) declares
`ThreadMessage` with `direction`, `channelType`, `deliveryStatus` and `attachments`. The merged spec assigns
that facade to **`messages`** and classifies PR C as `(a)+(b)` — additive files only. `messages` owns none of
those four fields:

- `direction` occurs **zero times** in the entire `messages` module (`rg direction packages/core/src/modules/messages/` → no matches). It lives on `MessageChannelLink.direction`
  (`packages/core/src/modules/communication_channels/data/entities.ts:292-293`) and `ExternalMessage.direction`
  (`…/communication_channels/data/entities.ts:240-241`) — both **`communication_channels`** tables.
- `channelType` and `deliveryStatus` are likewise `MessageChannelLink` columns
  (`…/communication_channels/data/entities.ts:289-296`).
- The whole `messages.Message` entity (`packages/core/src/modules/messages/data/entities.ts:38-142`) has no
  direction, no channel, no attachment column. Attachments are resolved out of the **`attachments`** module
  one message at a time by `getMessageAttachments`
  (`packages/core/src/modules/messages/lib/attachments.ts:41-60`) — a per-message query, which also violates
  the facade's own **P-02 (batched)**.

For `messages/lib/thread-reader.ts` to satisfy this shape it must query `message_channel_links` — i.e. the
lower-level module reaching **up** into `communication_channels`, inverting the dependency direction that
`packages/core/AGENTS.md` § Cross-Module Coupling mandates ("The upstream/depended-on module MUST NOT import,
resolve, or hard-require the consumer").

**Compounding:** § Reading peer data states *"Phase 1 therefore adds **one** source-owned read facade, carried
forward from A with its nine requirements intact."* Source A specifies **two** facades — the merged document
silently dropped `communicationChannelsThreadReader`
(`contracts/peer-read-facades.md:24-51`), which is the one that actually owns the channel-side data. The "nine
requirements intact" claim is true; the "one facade" claim is a merge error presented as a design decision.

**Fix.** Restore the second facade. PR C becomes two facades:
`messagesThreadReader` (id, threadId, body, bodyFormat, subject, sentAt, senderUserId, externalEmail/Name) in
`messages`, and `communicationChannelsThreadReader` in `communication_channels` supplying
`direction`/`channelType`/`deliveryStatus`/binding, batched by `messageId $in [...]` exactly as the shipped
enricher already does (`packages/core/src/modules/communication_channels/data/enrichers.ts:164-174`). Add a
batched attachment accessor to `messages/lib/attachments.ts` (`recordId $in [...]`) or drop attachments from
Phase 1 scope. State explicitly that `connect` composes the two.

---

### C2 — `connect` has no reachable path to a thread id, so the Inbox thread cannot be read at all

**Spec location:** § Data model (`connect_conversations`); § Reading peer data; T-UI-03; T-API-07.

**Defect.** `messagesThreadReader.getThreadMessages` is keyed on `threadId`
(`contracts/peer-read-facades.md:72-78`). The merged spec's `connect_conversations` stores
`case_id · external_conversation_id · channel_id · contact_handle · owner · …` — **no message id and no thread
id**. The only mapping from an `ExternalConversation` to a `messages.Message.thread_id` is
`channel_thread_mappings` (`…/communication_channels/data/entities.ts:322-363`), which § Reading peer data
explicitly forbids `connect` from querying, and no facade in the merged PR list exposes it (that was
`communicationChannelsThreadReader.getThreadBindings`, dropped — see C1).

The reply path has the same hole: `sendAsUser` threads a reply only when given `parentMessageId`, a
`messages.message.id` (`…/communication_channels/lib/send-as-user.ts:36-43,142`). `connect` stores no message
ids, so every "reply" would start a new thread.

**The data is available and the spec doesn't take it.** `communication_channels.message.received` already
carries `messageId`, `conversationId`, `channelId` and `direction` in its payload
(`…/communication_channels/commands/ingest-inbound-message.ts:515-529`), and `SendAsUserResult` returns
`{ messageId, threadId, channelId, providerKey }` (`…/lib/send-as-user.ts:53-60,277-283`).

**Fix.** Add `anchor_message_id uuid` (and optionally `message_thread_id uuid`) to `connect_conversations` in
T-DATA-02, populated in T-ING-01 from the `message.received` payload and in T-API-07 from `SendAsUserResult`.
Note in § Data model that the inbound event does **not** carry `threadId`, so either the reader accepts a
message id and resolves the thread inside `messages`, or `communicationChannelsThreadReader` is restored to do
the mapping. Add the field to the facade signature in the contract file.

---

### C3 — FR-010's 15 s timeout → 422 is unreachable: outbound send is asynchronous, and the adapter contract has no timeout

**Spec location:** FR-010, FR-011, T-API-07, T-TEST-04.

**Defect.** `sendAsUser` never calls a provider. It composes the `Message`, persists a `MessageChannelLink`
with `deliveryStatus: 'pending'`, **enqueues** an `OutboundDeliveryPayload` and returns
(`…/communication_channels/lib/send-as-user.ts:238-283`, enqueue at `:269-275`). The adapter's `sendMessage`
runs later in `workers/outbound-delivery.ts` (`metadata = { queue: outbound, concurrency: 10 }` at `:33-37`),
dispatching `deliver_outbound_message` with up to 3 attempts and exponential backoff (`:47-58`,
`OUTBOUND_DELIVERY_MAX_ATTEMPTS = 3` at `:31`).

Consequences, all of which the spec asserts otherwise:
- **`POST /api/connect/cases/{id}/messages` cannot observe a provider rejection or a timeout.** The only 422 it
  can return is the *pre-flight channel-state* guard (`guardOutboundCreate` → `ChannelMutationBlockedError` →
  422 at `send-as-user.ts:108-115`; guard body at `…/lib/mutation-guards.ts:127-160`), which fires on
  `channel_not_found` / `requires_reauth` / `disconnected` — **not** on a provider failure. FR-010's "expiry
  maps to the same 422 path as a provider rejection" describes a path that does not exist.
- **FR-011 is self-contradictory under async delivery.** "A failed send MUST NOT stamp
  `first_human_outbound_at`" is unimplementable when the stamp is written at enqueue time and the failure
  arrives seconds later in a worker.
- **The timeout itself is a frozen-contract change the spec does not list.** `ChannelAdapter.sendMessage(input:
  SendMessageInput)` (`…/communication_channels/lib/adapter.ts:501`) takes no timeout and no `AbortSignal`, and
  `commands/deliver-outbound-message.ts` contains no timeout/`AbortController`/`race` code at all. Adding one
  changes a public type consumed by `channel-gmail`, `channel-imap` and every third-party adapter — BC surface
  #3 (STABLE). § Migration lists only `SendMessageInput` gaining sender identity.

**Fix.** Restate FR-010/FR-011 against the shipped architecture: the route returns `202`/the optimistic message
row after `guardOutboundCreate` passes; delivery outcome surfaces asynchronously via the already-declared
`communication_channels.message.delivery_failed` event (`…/communication_channels/events.ts:20-25`), which
`connect` subscribes to in order to mark the message failed, offer retry, and *only then* decide about
`first_human_outbound_at` and `waiting_customer`. If a real per-provider timeout is genuinely wanted, move it
into PR A as an explicit `ChannelAdapter` contract change with a deprecation bridge, and add it to
§ Migration & backward compatibility. Rewrite T-TEST-04 to assert the async failure path, not a synchronous 422.

---

### C4 — the peer-read facade must bypass `messages`' participant-scope security boundary; the spec classifies that as `(a)+(b)` additive

**Spec location:** § Core-edit ledger row 1 (`messages/di.ts` + `lib/thread-reader.ts`, class `(a)+(b)`); PR C;
§ Reading peer data ("Scope parameters are mandatory" — tenant/org only).

**Defect.** Every shipped read of a `messages.Message` is **sender-OR-recipient** scoped, not tenant scoped:
- `applyMessageParticipantScope` (`packages/core/src/modules/messages/lib/participantScope.ts:47-64`) — "A
  message is visible to `userId` when they are the sender OR a non-deleted recipient."
- Enforced on the list route (`…/messages/api/route.ts:206`), on the detail route
  (`…/messages/api/[id]/route.ts:74-79` returns 403 when neither, and filters the thread itself at `:120-125`),
  and — the point — **even on the cross-module read**: `communication_channels`' own enricher runs the same
  predicate before touching a single link (`…/communication_channels/data/enrichers.ts:143-155`). Its header
  comment calls this "the enricher's security boundary" (`participantScope.ts:4-11`).

For channel-ingested traffic no Connect agent satisfies it. Inbound compose sets the sender to the system user
and gives **at most one** recipient — the thread mapping's assignee, else none:
`recipients: mapping?.assignedUserId ? [{ userId: mapping.assignedUserId, type: 'to' }] : []`
(`…/communication_channels/commands/ingest-inbound-message.ts:356-358`), `userId:
resolveCommunicationChannelsSystemUserId(...)` at `:377-381`. An agent's own reply has that agent as sender
(`send-as-user.ts:146`) and no recipients — so in a shared mailbox, **agent B cannot read agent A's replies**.

A tenant/org-scoped `messagesThreadReader` therefore *has to* return messages the caller is not a participant
of. That is a security-boundary relaxation of exactly the class the spec assigns `(e)` to PR A's
`send-as-user.ts` ownership gate — yet PR C is booked as `(a)+(b)` and carries no sign-off, while Q2 (which the
Gate-1 ledger already **REFUTED**) is the only open sign-off item.

**Fix.** Reclassify PR C as **(e)** in the Core-edit ledger with the same maintainer sign-off as PR A, and add
an open question mirroring Q2. Amend the facade contract: `getThreadMessages` takes `{ tenantId,
organizationId, userId, userFeatures }` and the *owning* module documents the substituted authorisation rule
(`connect.inbox.view` plus Case ownership), so the bypass is a stated, testable contract rather than an
emergent side effect. Add a test asserting a caller without `connect.inbox.view` gets nothing, and extend
T-TEST-05/06 to cover an agent who is neither sender nor recipient.

---

## Major

### M1 — R5's mitigation names a query-engine capability that does not exist

**Spec location:** Risk **R5**, T-TEST-08.

**Defect.** "Batch-resolve per page through the query engine" cannot return another module's columns. Joins are
declared as `QueryJoinEdge` (`packages/shared/src/lib/query/types.ts:66-78`) but `applyJoinFilters` builds a
**correlated `WHERE EXISTS (...)` subquery** (`packages/shared/src/lib/query/join-utils.ts:300-373`, subquery at
`:323`, attached at `:364-370`) — the joined table never enters the outer `FROM`, so there is no alias to
select from. `fields` accepts only base columns and `cf:` keys: the hybrid engine (the one DI registers, at
`packages/core/src/modules/query_index/di.ts:58`) silently **drops** anything else
(`…/query_index/lib/engine.ts:964-969`); the basic engine mis-qualifies it as `base_table."cust.display_name"`
(`packages/shared/src/lib/query/engine.ts:663`). `includeExtensions` emits a `leftJoin` with **no select** and
is ignored entirely by the hybrid engine (`…/query/engine.ts:957-982`; the template documents this itself at
`packages/create-app/template/src/modules/example/data/extensions.ts:19-25`).

**Fix.** Change R5's mitigation to the mechanism the platform actually uses: a `connect`-owned
`data/enrichers.ts` on `connect.connect_case` implementing `enrichMany` — the runner **throws** if a list-path
enricher lacks it (`packages/shared/src/lib/crud/enricher-runner.ts:247-255`), so N+1 is structurally
prevented. Two batched `$in` lookups (customer ids → names, channel ids → display names) per page, mirroring
`…/communication_channels/data/enrichers.ts:164-220` (4 queries/page regardless of row count) and
`…/customers/data/enrichers.ts:192-196`. Add `enrichers: { entityId: E.connect.connect_case }` to T-API-01, and
give T-TEST-08 a concrete ceiling derived from that count.

### M2 — FR-022's `ids`-based narrowing silently truncates at 200

**Spec location:** FR-022, T-API-09, T-TEST-06.

**Defect.** `packages/core/AGENTS.md` § API Interceptors recommends `query.ids` for list narrowing, and the
spec follows it. `parseIdsParam` caps at `MAX_IDS_PER_REQUEST = 200`
(`packages/shared/src/lib/crud/ids.ts:3`) and truncates **silently** — `parsed.slice(0, safeMax)` at `:45-50`,
no error, no warning. An agent owning >200 Cases would see an arbitrary 200 and a wrong total, and T-TEST-06
(which asserts *isolation*, not completeness) would not catch it. Computing the id list also requires the
interceptor to run its own full scan of the caller's Cases on every list request.

**Fix.** The `before` hook returns `query` freely (`packages/shared/src/lib/crud/api-interceptor.ts:32-35`), so
have T-API-09 write a **filter** (`query.assigneeUserId = ctx.userId`) that the T-API-01 list schema and
`buildFilters` accept, instead of an id enumeration. Add a test with >200 owned Cases asserting nothing is
dropped.

### M3 — `handle_value_hash` is not written when encryption is disabled, so FR-016's unique index silently stops enforcing

**Spec location:** § Data model (`connect_contact_identities`, "raw-SQL partial index … where … `handle_value_hash`
is not null"); § Encryption; FR-016; T-DATA-03; T-TEST-11.

**Defect.** The spec sources the hash from the encryption map's `hashField`. `hashField` is populated **only**
inside `encryptFields` (`packages/shared/src/lib/encryption/tenantDataEncryptionService.ts:417-420`), which
runs only after `encryptEntityPayload` clears three gates — `this.isEnabled()` (= `TENANT_DATA_ENCRYPTION` **and**
`kms.isHealthy()`, `:178-180`), a map being present, and a DEK resolving — each of which returns the payload
**unchanged** (`:463-478`). With encryption off, KMS unhealthy, or no DEK, `handle_value_hash` is `NULL`, the
`where handle_value_hash is not null` partial index never applies, and identity dedupe (FR-016, R7-style
insert-and-arbitrate in T-ING-03) silently degrades to unbounded duplicates. `handle_value` also sits in
plaintext, so T-TEST-11 ("unreadable at rest") passes or fails purely by environment.

**The one precedent in the repo does it differently.** `customer_users_tenant_email_hash_uniq`
(`packages/core/src/modules/customer_accounts/data/entities.ts:16`) works because `customer_accounts` computes
the hash **explicitly in application code**, unconditionally — `hashForLookup(email)` at
`…/customer_accounts/services/customerUserService.ts:21`, `…/services/customerInvitationService.ts:49`,
`…/setup.ts:266` — not via the encryption map.

**Fix.** T-DATA-03 must write `handle_value_hash` explicitly in `connect`'s identity command, following the
`customer_accounts` precedent; keep the `hashField` map entry only as belt-and-braces. State in § Encryption
that the unique index's correctness does not depend on the encryption toggle, and make T-TEST-11 assert the
hash/uniqueness behaviour with encryption **off** as well as on.

### M4 — the lookup hash has two on-disk formats, so a UNIQUE constraint on it does not dedupe across a pepper rollout

**Spec location:** § Data model (unique on the hash column); T-ING-03 (`lookupHashCandidates` on read);
T-TEST-11 ("duplicate rejected").

**Defect.** `hashForLookup` returns a **keyed HMAC prefixed `v2:`** when `TENANT_DATA_ENCRYPTION_LOOKUP_PEPPER`
is configured and a **legacy unkeyed digest** otherwise
(`packages/shared/src/lib/encryption/aes.ts:141-149`). `lookupHashCandidates` exists precisely because both
formats coexist and must be matched with `$in` during the migration window (`aes.ts:160-165`). A UNIQUE index
on `handle_value_hash` therefore admits **two rows for the same handle** across a pepper enable/disable —
exactly the state FR-016 and R7 rely on it to prevent.

Second, smaller trap: the write side calls `hashForLookup(serialized)` with **no `context`**
(`tenantDataEncryptionService.ts:419`), while `aes.ts:136-138` warns the context "MUST be supplied identically
on both the write and the read side". T-ING-03 says only "`lookupHashCandidates` on read" — if an implementer
passes a context there, every read misses.

**Fix.** State in § Encryption that `connect` calls `hashForLookup(value)` / `lookupHashCandidates(value)`
**with no `context` argument**, matching the write side. Note that the unique index is a best-effort dedupe,
not a correctness guarantee across a pepper change, and either (a) require the pepper as a deployment
precondition for `connect`, or (b) add a reconciliation step to the T-MET-01 baseline job. Add a T-TEST-11 case
for the legacy/v2 mixed state.

### M5 — the Inbox has neither push nor cache and no stated refresh strategy, contradicting the shipped precedent

**Spec location:** § Cache ("Phase 1 introduces **no caching**"); T-EVT-01 ("No `clientBroadcast` in Phase 1");
§ UI.

**Defect.** The cache decision itself is defensible, but it is argued from "the Inbox is agent-scoped and
low-volume" without saying how the Inbox learns about a new inbound message. The platform's own Inbox for the
same archetype does the opposite: `MessagesInboxPageClient.tsx:88-90` invalidates its queries on
`useAppEvent('messages.message.*')` **and** on `om:bridge:reconnected`. The upstream event `connect` would
subscribe to is already broadcast-enabled — `communication_channels.message.received` carries
`clientBroadcast: true` (`…/communication_channels/events.ts:6-11`). Declining `clientBroadcast` on
`connect.*` while introducing no cache and naming no polling interval leaves a three-pane agent console with no
defined refresh behaviour, and pushes every agent onto uncoordinated polling of an uncached list endpoint —
which is also what R5's query ceiling is measured against.

**Fix.** Keep "no cache" but state the refresh mechanism explicitly: either `connect` subscribes client-side to
the existing `communication_channels.message.received` broadcast, or `connect.case.created` /
`connect.conversation.attached` take `clientBroadcast: true` in T-EVT-01 (both are already frozen ids, so this
is a flag on a declared event, not a new surface). Add `om:bridge:reconnected` handling to T-UI-01, and state
the fallback poll interval.

### M6 — T-SRCH-01 contradicts § Data model, goes stale by construction, and names the wrong exclusion mechanism

**Spec location:** T-SRCH-01; § Data model ("No denormalised customer PII").

**Defect, three parts.**

1. **Contradiction.** § Data model states *"Neither `connect_cases` nor any other table carries a
   `customer_snapshot`. Name and e-mail resolve live through `customers`."* Indexing the customer name puts
   exactly that denormalised PII into a second store — and by default a **plaintext external** one: the
   Meilisearch driver receives the decrypted query-engine record and `SEARCH_EXCLUDE_ENCRYPTED_FIELDS` is
   **off** by default (`packages/search/src/di.ts:174,189-198`; driver `…/fulltext/drivers/meilisearch/index.ts:144-189`).
2. **Staleness.** `buildSource` hydrates peer records via `ctx.queryEngine`
   (`packages/shared/src/modules/search.ts:231-232`; real usage `…/customers/search.ts:175-215`) — a query
   **per record** at index time, and there is **no cascade reindex**: `search.index_record` is emitted only for
   the record that was written (`…/query_index/subscribers/upsert_one.ts:103,181`). Renaming a customer leaves
   every one of their Cases indexed under the old name until that Case row is itself touched.
3. **Wrong mechanism.** "Exclude `handle_value`" by omitting it from `buildSource` is not exclusion. The
   indexer sets `fields: params.record` verbatim — the whole query-engine record plus every custom field
   (`packages/search/src/indexer/search-indexer.ts:266-277`, `:318-323`). The token strategy ignores
   `fieldPolicy` entirely and tokenizes every string key (`…/strategies/token.strategy.ts:133-139` →
   `…/query_index/lib/search-tokens.ts:96-103`), and Meilisearch indexes everything when no `searchable`
   whitelist is declared (`packages/search/src/lib/field-policy.ts:63-64`). (As written the specific
   `handle_value` risk is moot — it lives on `connect_contact_identity`, which T-SRCH-01 does not index — so
   the stated safeguard protects nothing while the real exposure, the subject line and the hydrated customer
   name, is unaddressed.)

**Fix.** Drop "customer name" from T-SRCH-01, or accept the snapshot and reconcile § Data model (and then also
own the reindex-on-rename subscriber). Declare an explicit `fieldPolicy` with a `searchable` whitelist on
`connect:connect_case`, note that the token strategy does not honour it, and state whether
`SEARCH_EXCLUDE_ENCRYPTED_FIELDS` is a deployment precondition for `connect`.

### M7 — R7's "let the unique index arbitrate" names no index that exists, and the risk is already handled upstream

**Spec location:** Risk **R7**; T-TEST-09; FR-001.

**Defect.** § Data model gives `connect_cases` one unique key — `(tenant_id, case_number)` — and
`connect_conversations` one — `(tenant_id, external_conversation_id)`. Neither is keyed on the inbound
message, so "attempt the insert and let the unique index arbitrate, catching the violation" has nothing to
catch. R7 is written as a mechanism but ships as an assertion, which is the exact failure mode it warns about.

Separately, the premise is largely moot: `ingest-inbound-message` dedupes on `(channel_id,
external_message_id)` and **early-returns `status: 'duplicate'` at `:96-102`, before** any event emission
(`message.received` is emitted at `:515-529`). `messages.compose` carries a second gate, the partial-unique
`messages_idempotency_key_uq` on `(tenant_id, idempotency_key)`
(`…/messages/data/entities.ts:33-37`, key set at `ingest-inbound-message.ts:373-375`). A redelivered
`ExternalMessage` therefore never reaches `connect`'s subscriber at all.

**Fix.** Restate R7: upstream `ExternalMessage` dedupe is the primary gate (cite `:96-102`), and the
connect-side mechanism is the `connect_conversations` unique key on `(tenant_id, external_conversation_id)`
plus — if a per-message anchor is genuinely wanted — an explicit unique on the new `anchor_message_id` column
from C2. Rewrite T-TEST-09 to assert the reachable behaviour (replay the *subscriber*, not the provider
message).

### M8 — no task registers the scheduler entries, so the auto-close job (FR-005) and the baseline job (FR-019) never run

**Spec location:** T-WRK-01, T-MET-01, FR-005, FR-019, T-ACL-01.

**Defect.** A `workers/*.ts` file only declares a **queue consumer** (`metadata = { queue, id, concurrency }`).
Recurring execution requires a cron/interval entry registered against `@open-mercato/scheduler` from the
module's `setup.ts`: `…/communication_channels/workers/poll-tick.ts:12-13` says so verbatim ("Fired by the
`@open-mercato/scheduler` cron entry registered in the hub's `setup.ts`"), and the registration is
`schedulerService.register({ … scheduleType: 'interval', scheduleValue: … })` inside `onTenantCreated`,
guarded by `hasRegistration('schedulerService')` (`…/communication_channels/setup.ts:103-132`, with a stable
per-org uuid at `:38-49`). The spec's only `setup.ts` task, T-ACL-01, covers `defaultRoleFeatures` only. As
written, `auto-close.ts` and `baseline-metrics.ts` are dead code and FR-005/FR-019 are unsatisfied.

**Fix.** Extend T-ACL-01 (or add T-SET-03) to register both schedules in `<M>/setup.ts` `onTenantCreated`,
idempotently, via a stable per-org uuid and the `hasRegistration` guard so a scheduler-less deploy still boots.
Declare the resulting `@open-mercato/scheduler` dependency in T-SET-01 (root `AGENTS.md` § Ask First — adding a
production dependency).

### M9 — a new workspace package is **not** auto-discovered; `apps/mercato/src/modules.ts` must be edited

**Spec location:** T-SET-01, T-SET-02 ("`<M>/index.ts` metadata; run `corepack yarn generate`"); § Migration
("new module and package IDs (1) … new generated registry entries (14)").

**Defect.** `yarn generate`, `yarn db:generate` and `yarn db:migrate` all enumerate modules from the **app's
`src/modules.ts`**, parsed by AST — `loadEnabledModulesFromConfig`
(`packages/cli/src/lib/resolver.ts:342-364`); the `from` string is mapped by name convention at `:52-72`. There
is no `packages/*` glob on the generate path. Every existing package is registered explicitly — e.g.
`{ id: 'content', from: '@open-mercato/content' }` at `apps/mercato/src/modules.ts:87` — and every module
package is an explicit `workspace:*` entry in `apps/mercato/package.json:34-53`. `yarn build:packages` and
migration *path* discovery are glob-driven and need no edit, but nothing is discovered until the module is in
`modules.ts`.

`modules.ts` is a committed, non-generated file under `apps/mercato/src/`, which root `AGENTS.md` § Where to Put
Code otherwise forbids ("MUST NOT add code in `apps/mercato/src/`", narrow exception for `*.generated.ts`
only). The spec claims a pure-additive footprint and never names this edit or the exception.

**Fix.** Make T-SET-01/T-SET-02 enumerate the out-of-package edits and note the `modules.ts` exception
explicitly:
1. `apps/mercato/src/modules.ts` — `{ id: 'connect', from: '@open-mercato/connect' }` and
   `{ id: 'channel_webform', from: '@open-mercato/channel-webform' }` (**required**);
2. `apps/mercato/package.json` dependencies — `workspace:*` for both (required for the production focus install
   and `scripts/check-dep-versions.ts`);
3. `packages/create-app/template/src/modules.ts` + `scripts/template-sync.ts` `SYNC_INTERNAL_PACKAGE_KEYS`
   (`:137-141`) — per the Task Router's create-app **Template Sync Checklist**, if the packages ship in
   scaffolds;
4. `jest.config.cjs` moduleNameMapper (root and `apps/mercato/`) — only if tests import from source rather than
   `dist`.

---

## Minor

### m1 — `connect`'s identity resolver duplicates a shipped capability with no precedence rule
T-ING-03 builds `<M>/lib/identity-resolver.ts` as if nothing exists. `communication_channels` already resolves
an inbound sender to `customers:customer_entity` through the query engine
(`…/communication_channels/lib/contact-resolver.ts:5-18,32-42`), writes the result to
`ExternalConversation.contactPersonId`, and emits `communication_channels.contact.resolved` with
`contactPersonId` (`…/commands/ingest-inbound-message.ts:503-513`). Two resolvers running on the same message
can disagree, and nothing says which wins.
**Fix.** State the precedence in T-ING-03 (e.g. seed `connect_contact_identity` from `contact.resolved` when
present, run the threshold resolver only when it is absent or below threshold), and say what happens when they
diverge.

### m2 — T-UP-04 writes into a file that does not exist
`packages/core/src/modules/messages/AGENTS.md` does not exist (nor does
`communication_channels/AGENTS.md`), so "a 'Public Contract Surfaces' table **in** `messages/AGENTS.md`" is a
file creation, not an edit — and a new module `AGENTS.md` is inside the shared instruction budget checked by
`yarn agents:check-budget` (root `AGENTS.md` § Instruction budget).
**Fix.** Reword T-UP-04 to "create `messages/AGENTS.md`", add the budget check to the DoD, and add the same
table to `communication_channels/AGENTS.md` if C1's second facade lands there.

### m3 — the spec names the wrong optimistic-lock helper for the six command routes
`optimistic-lock-command-coverage.test.ts:5-22` fails any **new** direct `enforceCommandOptimisticLock(` call
site that is neither migrated to the async DI-aware seam `enforceCommandOptimisticLockWithGuards`
(`packages/shared/src/lib/crud/optimistic-lock-command.ts:347`) nor added to `COMMAND_GUARD_ALLOWLIST` with a
concrete decision. § API contracts and T-CMD-01 name neither helper.
**Fix.** Have T-API-02/T-CMD-01 specify `enforceCommandOptimisticLockWithGuards` for all six action commands.

### m4 — nothing allocates `case_number`
FR-002/§ Data model require `case_number` (`ZG-<seq>`, unique per tenant) "via the `sales.SalesDocumentSequence`
pattern", but that pattern is a **sales-owned service**
(`packages/core/src/modules/sales/services/salesDocumentNumberGenerator.ts`), not a shared helper, and no task
in slices 1a–1d allocates the number or handles concurrent allocation. T-DATA-01 declares the entity only.
**Fix.** Add a task for `<M>/services/caseNumberGenerator.ts` (+ a `connect_case_sequence` row seeded in
`onTenantCreated`) and name the concurrency strategy.

### m5 — PR A must also widen `SendAsUserActor`, a STABLE public type the spec does not list
`assertCanManageChannel(channel, currentUserId, userFeatures, elevatedFeature)`
(`…/communication_channels/lib/access-control.ts:75-79`) needs a granted-features array to evaluate its shared
branch (`:96-99`). `SendAsUserActor` carries only `{ userId, tenantId, organizationId, auth? }`
(`…/lib/send-as-user.ts:19-25`). Delegating authorisation to `assertCanManageChannel` therefore changes
`SendAsUserActor` too — BC surface #3 (STABLE). § Migration lists only `SendMessageInput`.
**Fix.** Add `SendAsUserActor` (and `SendAsUserResult` if it grows) to the § Migration "Changed:" line and to
PR A's description, with the additive-optional-field shape that keeps existing callers byte-identical.

### m6 — an unreconciled third frozen-surface drift, plus one overloaded ACL id
`frozen-surfaces.md:66-70` states the ACL format is `<module>.<resource>.<verb>` **"with no exceptions"** and
then lists the four-segment `connect.cases.view.all`. § Frozen-surface drift reconciles two drifts and misses
this one. Separately, the resolution guards `/metrics/baseline` with `connect.cases.view.all` — the same id
T-API-09 uses to mean "see other agents' Cases" — so granting cross-agent visibility silently grants baseline
metrics.
**Fix.** Either accept the four-segment id and soften the "no exceptions" rule in `frozen-surfaces.md`, or
rename to `connect.cases.view_all` **before** commit 1 (§ Frozen-surface drift's own reason applies: ACL ids are
DB-stored). Guard `/metrics/baseline` with `connect.settings.manage` or defer the route to `connect_analytics`.

### m7 — `connect.case.assigned` has no declared writer, contradicting the drift resolution's own argument
§ Frozen-surface drift settles the count at ten "because … every ID has a writer". Of the ten
(`frozen-surfaces.md:42-49`), `connect.case.assigned` is not traced to any FR or task: there is no assign
endpoint in the § API contracts table, and T-DOM-01/T-API-04…06/T-API-08 cover the other nine.
**Fix.** Either name the writer (the CRUD `PUT /api/connect/cases` in T-API-01, when `assignee_user_id`
changes) or drop the id from Phase 1's frozen set and defer it.

---

FINDINGS: 4C/9M/7m

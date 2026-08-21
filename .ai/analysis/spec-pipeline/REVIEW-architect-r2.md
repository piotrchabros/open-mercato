# Adversarial review round 2 — **Architect** lens

**Target:** `.ai/specs/2026-08-22-connect-phase-1-v2.md`
**Round-1 file:** `.ai/analysis/spec-pipeline/REVIEW-architect.md` (4C/9M/7m)
**Lens (unchanged):** platform claims vs. source behaviour. Every assertion below was checked by
opening the code in this worktree; nothing is asserted from a filename, a type or a doc comment.
Other reviewers' files (round 1 or round 2) were not read.

---

## 1. Regression check — round-1 findings against v2

| # | Round-1 finding | Status | Reason (pointing at v2's text) |
|---|---|---|---|
| **C1** | `messages` facade cannot produce direction/channel/delivery/attachments | **PARTIAL** | § Reading peer data moves the facade to `communication_channels` and correctly argues `messages` has no `direction`. But it inverts rather than removes the problem: the new owner has never read a `messages` **body** (see **F-C2**), and v2 never restates the `ThreadMessage` projection, the attachments field, or the per-message `getMessageAttachments` P-02 violation. |
| **C2** | `connect` has no reachable path to a thread id | **UNRESOLVED** | § Reading peer data asserts `message_thread_id` is *"taken from the `message.received` event payload"*. It is not in that payload (`ingest-inbound-message.ts:515-529`). FR-008 and T-ING-01 now mandate a column with no writer — see **F-C1**. |
| **C3** | FR-010's 15 s timeout → 422 unreachable under async delivery | **RESOLVED** | FR-010/FR-011 rewritten to 202 + hub reconciliation; no `ChannelAdapter` timeout; § Migration no longer implies one. The mechanism is genuinely available (`deliver-outbound-message.ts:470-485, 546-562` both carry `messageId`). Residual mechanism defect filed fresh as **F-M1**. |
| **C4** | Facade bypasses `messages`' participant scope; PR C booked `(a)+(b)` | **PARTIAL** | § Containment and **Q-D** now name the bypass explicitly — a real improvement. But PR C is still classified `(a)+(b)` "pending Q-D", the facade signature is not amended with `userId`/`userFeatures`, and no substituted authorisation rule is documented. `participantScope.ts:4-11` states the boundary must not desync between call sites; a third, unscoped call site is exactly that desync. |
| **M1** | R5 names a query-engine join capability that does not exist | **PARTIAL** | R5 now says *"batching is done with a response enricher … not with a join"* — correct, and the mechanism exists (`factory.ts:1336-1345`, `enricher-runner.ts:247-255`). But no task wires it: T-API-01 declares `indexer` only, not `enrichers: { entityId }`. See **F-M2**. |
| **M2** | `ids` narrowing truncates silently at 200 | **RESOLVED** | FR-022 and T-API-09 both mandate an `assignee_user_id` filter and name the truncation explicitly as the reason. |
| **M3** | `handle_value_hash` unwritten when encryption is off | **RESOLVED** | FR-016 makes the unconditional hash write a requirement; T-DATA-03 carries it; T-TEST-11 asserts "hash present with encryption off". |
| **M4** | Two on-disk hash formats defeat the unique index | **PARTIAL** | § Data model's "Known limitation" and R10 state the pepper-rollout gap honestly, and reads use `lookupHashCandidates`. The second half is still missing: `hashForLookup` is called write-side with **no `context`** (`tenantDataEncryptionService.ts:419`, warning at `aes.ts:136-138`), and v2 never says `connect` must omit it on read. |
| **M5** | Inbox has no stated refresh strategy | **RESOLVED** | § Inbox freshness names poll-on-focus + 30 s and states the `clientBroadcast`/cache deferral as a decision. Consequences filed fresh as **F-M5**. |
| **M6** | T-SRCH-01 contradicts § Data model, goes stale, wrong exclusion mechanism | **UNRESOLVED** | T-SRCH-01 still says "index subject and **customer name**" while § Data model still says *"No denormalised customer PII … Name and e-mail resolve live through `customers`."* "Exclude `handle_value` and `contact_handle`" is still the non-mechanism (the indexer sets `fields: params.record` verbatim, `search-indexer.ts:266-277`), and `contact_handle` is on `connect_conversation`, an entity T-SRCH-01 does not index. No `fieldPolicy`, no reindex-on-rename. |
| **M7** | R7's "let the unique index arbitrate" names no index | **RESOLVED** | R7 now names `connect_conversations` unique `(tenant_id, external_conversation_id)`, insert-and-catch-23505, and § Consistency adds the savepoint. |
| **M8** | Scheduler entries never registered | **RESOLVED** | T-WRK-03 registers T-WRK-01/02/T-MET-01 with the scheduler and states "without this none of them ever run". (The `@open-mercato/scheduler` production dependency and the `hasRegistration` guard are still unstated — noted, not re-filed.) |
| **M9** | A new workspace package is not auto-discovered | **PARTIAL** | T-SET-03 and two ledger rows now cover `apps/mercato/src/modules.ts` and the template mirror — the substance is fixed. Two of the three supporting facts are wrong: the citation (**F-m1**) and the package.json file (**F-m2**). |
| **m1** | Duplicate identity resolver, no precedence rule | **UNRESOLVED** | T-ING-03 still builds `<M>/lib/identity-resolver.ts` with no mention of the shipped `contact-resolver.ts` or the `communication_channels.contact.resolved` event that already carries `contactPersonId`. |
| **m2** | T-UP-04 writes into a file that does not exist | **UNRESOLVED** | The defect was transplanted, not fixed: v2 correctly notes `messages/AGENTS.md` does not exist, then targets `communication_channels/AGENTS.md`, which also does not exist. See **F-m3**. |
| **m3** | Wrong optimistic-lock helper for the command routes | **UNRESOLVED** | Neither `enforceCommandOptimisticLock` nor `enforceCommandOptimisticLockWithGuards` appears anywhere in v2; T-CMD-01 and § API contracts are silent. The guard scans *every* workspace package (`optimistic-lock-command-coverage.test.ts:7-8`), so `packages/connect` is in scope. |
| **m4** | Nothing allocates `case_number` | **RESOLVED** | T-SEQ-01 adds `<M>/lib/case-number.ts`. The pattern it names does not transfer cleanly — filed fresh as **F-M6**. |
| **m5** | `SendAsUserActor` missing from § Migration | **RESOLVED** | § Migration: *"`SendMessageInput` and `SendAsUserActor` gain sender identity (3, STABLE)"*; also in PR A's row. |
| **m6** | Four-segment ACL drift + `/metrics/baseline` overload | **PARTIAL** | The overload is now documented ("a documented overload, not a new ID"). The `<module>.<resource>.<verb>` **"with no exceptions"** drift at `frozen-surfaces.md:66-67` is still unreconciled. See **F-m5**. |
| **m7** | `connect.case.assigned` has no declared writer | **PARTIAL** | v2 names one — and the writer it names is impossible. See **F-M4**. |

**Tally:** 8 RESOLVED · 7 PARTIAL · 5 UNRESOLVED (20 of 20 accounted for).

---

## 2. Fresh findings

### Critical

#### F-C1 — `message.received` does not carry a thread id: FR-008's `message_thread_id` has no writer, so the whole facade is unreachable for inbound-only Cases

**Spec location:** § Reading peer data ("Thread ids come from events, not from a facade"); FR-008;
T-DATA-02; T-ING-01; § Aggregates.

**Defect.** v2 asserts both ids come from the event payload. Only one does. The emitted payload is,
verbatim (`packages/core/src/modules/communication_channels/commands/ingest-inbound-message.ts:515-529`):

```
messageId, externalMessageId, channelLinkId, conversationId,
channelId, providerKey, channelType, direction, tenantId, organizationId
```

There is no `threadId`, no `messageThreadId`, no `message_thread_id`. `last_message_id` can be
satisfied from `messageId`; **`message_thread_id` cannot be satisfied at all on the inbound path.**

The other half of the claim does hold: `SendAsUserResult` is
`{ ok: true; messageId; threadId; channelId; providerKey }`
(`packages/core/src/modules/communication_channels/lib/send-as-user.ts:53-60`) — verified, `threadId`
is present. But that only populates the column **after the first agent reply**. A Case that has been
ingested and not yet replied to has `message_thread_id = NULL`, and § Containment says the facade
*"accepts only thread ids the caller already owns"* — so the Inbox cannot render the thread of any
Case before someone replies to it, which is every Case at the moment an agent opens it. This is C2
one layer down, in the exact shape the rewrite was meant to eliminate.

**The data is in hand at emit time and simply not published.** `ingest-inbound-message.ts:386-405`
already holds `message.threadId` from the compose result
(`commandBus.execute<…, { id: string; threadId: string | null }>` at `:385-391`) and writes
`messageThreadId: message.threadId ?? message.id` into `ChannelThreadMapping` at `:404`.

**Fix.** Either (a) add `messageThreadId: message.threadId ?? message.id` to the `message.received`
payload as part of PR C — an additive payload change on an already-frozen event ID, BC-safe — and
say so in § Blocking upstream PRs and § Migration; or (b) key the facade on **message id** rather
than thread id (`getThreadMessagesForMessage(messageId)`), letting `communication_channels` resolve
the thread internally. Whichever is chosen, FR-008 must stop asserting the field is already
available, and T-ING-01's "stores `message_thread_id`/`last_message_id` from the event payload" must
be corrected.

---

#### F-C2 — the facade's new owner owns the direction data but not the bodies, so PR C is the storage coupling its own ledger row forbids

**Spec location:** § Reading peer data; § Core-edit ledger row 1; PR C; T-UP-04.

**Defect.** v2's argument for moving the facade is sound as far as it goes: `direction`,
`channelType` and `deliveryStatus` are `MessageChannelLink` columns, and the dependency-direction
quote is accurate — `communication_channels/data/extensions.ts:6-8` does say *"The hub knows about
other modules (auth, customers, messages) but those modules do NOT know about the hub — dependency
direction is one-way (hub → others)."*

But the projection the Inbox needs is **body + subject + sentAt + sender**, and those live in
`messages.messages`. The hub has never read them. Its one cross-module read into `messages` pulls
**ids only**, for scope filtering:
`applyMessageParticipantScope(db.selectFrom('messages as m'), userId).select('m.id')`
(`packages/core/src/modules/communication_channels/data/enrichers.ts:144-147`, import at `:6-9`).
Nothing in the module ever selects a message body.

So PR C must add one of:
- a raw Kysely/SQL select of `messages.body/subject/sent_at` from `communication_channels` — which is
  precisely the *"peer-module table access"* that the ledger row's own citation
  (`.ai/lessons/cross-module-query-precedent-is-not-permission-to-copy.md`) says must sit behind a
  facade **owned by the source module**; the source of a body is `messages`, not the hub; **or**
- an import of the `messages` `Message` entity class into `communication_channels` — a compile-time
  entity dependency across module boundaries, which root `AGENTS.md` § Architecture forbids.

The same file the spec quotes for the dependency direction also says, two lines further down,
*"Lookups across these links happen via the query engine, never via raw SQL joins."*
(`extensions.ts:8-9`) — the sanctioned third option, which v2 does not name.

**Fix.** Pick one and state it. Either restore the two-facade design (a `messages`-owned body reader
+ the hub's `communicationChannelsThreadReader` for direction/channel/delivery, composed by
`connect`), or state explicitly that the hub facade hydrates bodies **through the query engine** on
`messages:message` per its own `extensions.ts:8-9`, and say in the ledger row why that is not the
storage coupling the lesson forbids. Also restate the `ThreadMessage` projection shape (it vanished
in the rewrite) and settle attachments, which the hub cannot supply either.

---

#### F-C3 — nullable `organization_id` makes every org-less Case invisible and un-editable on the CRUD route

**Spec location:** § Data model, first paragraph (*"`organization_id` is nullable, not NOT NULL"*);
T-API-01; FR-020; FR-024; T-DATA-01…08.

**Defect.** The **premise** is correct — `ingest-inbound-message.ts:201,213` does write
`organizationId: input.scope.organizationId ?? null`, and every hub entity declares
`organizationId?: string | null` (`communication_channels/data/entities.ts:163,210,256,314,356,417`).
The **consequence** is not worked through, and it is destructive.

`makeCrudRoute` defaults `orgField: 'organizationId'` (`packages/shared/src/lib/crud/factory.ts:1019`),
and every scoped read runs through `buildScopedWhere`, which sets the org predicate to a concrete
value or an `$in` list and **never** to `IS NULL`
(`packages/shared/src/lib/api/crud.ts:14-29`). A row with `organization_id IS NULL` therefore matches
no CRUD read. On top of that:

- create returns `400 "Organization context is required"` when there is no org context, and writes
  `entityData.organizationId = targetOrgId` unconditionally (`factory.ts:2388-2391`);
- update and delete do the same pre-flight and then scope by `targetOrgId` (`factory.ts:2716-2726`,
  `:3029-3039`).

So a Case ingested from an org-less inbound is created by the subscriber, counted in
`connect_metric_daily`, projected, and then **never appears on `/api/connect/cases`, cannot be
updated, and cannot be soft-deleted**. T-TEST-05/06 would not catch it: both create their fixtures
through the API, which always stamps a concrete org.

The two escape hatches are both bad as written. `orgField: null` disables automatic org scoping
entirely, contradicting FR-020. Storing the tenant id in the org column is what the hub's own contact
resolver does as a fallback (`organizationId: input.scope.organizationId ?? input.scope.tenantId`,
`ingest-inbound-message.ts:306-307`) and would silently cross-link organisations.

**Fix.** Decide the org policy explicitly and test it. Recommended: keep the column nullable to match
the peer rows, but have T-ING-01 **resolve a concrete organisation** for every Case (from
`CommunicationChannel.organizationId`, falling back to a per-tenant default org recorded in
`connect_tenant_settings`), and state that `connect_cases.organization_id` is NOT NULL in practice
even though the peer binding is nullable. If genuinely-org-less Cases must be supported, T-API-01
must document the non-default scoping it uses and add a T-TEST-05 case that creates an org-less Case
through the *subscriber* and asserts it is visible, editable and tenant-isolated.

---

### Major

#### F-M1 — FR-011's reconciler is specified as a scheduled worker, but the only legal data source is an event; and the event fires on every retry attempt

**Spec location:** FR-011; T-WRK-02 (`<M>/workers/reconcile-delivery.ts`); T-WRK-03; § Consistency
row "Delivery reconcile"; T-TEST-04.

**Defect, two parts.**

1. **Wrong mechanism.** T-WRK-03 registers T-WRK-02 "with the scheduler", i.e. a periodic job. A
   periodic job can only learn a delivery outcome by reading `message_channel_links.delivery_status`
   — a `communication_channels` table that § Reading peer data forbids `connect` from querying, and
   which the one authorised facade (a *thread* reader) does not expose. The correct and available
   mechanism is a **subscriber**, and the events already carry the correlation key `sendAsUser`
   returns: `communication_channels.message.sent` emits `{ messageId, externalMessageId,
   channelLinkId, conversationId, channelId, providerKey, channelType, direction: 'outbound', … }`
   (`deliver-outbound-message.ts:470-485`) and `.delivery_failed` emits `{ messageId, channelLinkId,
   conversationId, channelId, providerKey, channelType, transient, error, status, … }` (`:546-562`).
   Both IDs are declared with `clientBroadcast: true` (`communication_channels/events.ts:13-25`).
   v2's task list contains no `<M>/subscribers/reconcile-delivery.ts`.

2. **`.delivery_failed` is not terminal.** It is emitted on **every** failed attempt, including
   transient ones that will be retried up to `OUTBOUND_DELIVERY_MAX_ATTEMPTS = 3`
   (`workers/outbound-delivery.ts:32`; the worker's own header says *"The command already wrote the
   failure record + emitted `.delivery_failed`, so the worker just decides whether to schedule
   another attempt"*, `:50-56`). A subscriber that takes the first `.delivery_failed` at face value
   flips `connect_message` to `failed` and shows the agent a retry button on attempt 1 of 3, then
   flips to `sent` when attempt 3 succeeds — a visible flapping state that FR-011 and T-TEST-04
   assert against.

**Fix.** Replace T-WRK-02 with `<M>/subscribers/reconcile-delivery.ts` (`persistent: true`)
subscribing to both IDs and correlating on `messageId` against `connect_messages.message_id`. State
that `.delivery_failed` with `transient: true` maps to a `retrying` presentation, **not** `failed`,
and that only `transient: false` (or exhaustion) is terminal. Add the corresponding
`connect_message.delivery_status` value or say why `queued` covers it. Extend T-TEST-04 to replay a
transient failure followed by a success.

---

#### F-M2 — R5's mitigation has no task: T-API-01 never declares `enrichers`

**Spec location:** R5; T-API-01; T-TEST-08.

**Defect.** The mechanism v2 now names is real and correct. `makeCrudRoute` accepts
`enrichers?: { entityId }` (`packages/shared/src/lib/crud/factory.ts:508-509`), runs
`applyResponseEnrichers` on the list payload after `afterList` (`:1336-1345`), and the runner
**throws** if a list-path enricher lacks `enrichMany`
(`packages/shared/src/lib/crud/enricher-runner.ts:247-255`) — so N+1 is structurally prevented.

But the only place v2 mentions an enricher outside R5's prose is T-WID-01. T-API-01 specifies
`makeCrudRoute` + `indexer` + OpenAPI + `metadata` and no `enrichers` key, and no task creates
`<M>/data/enrichers.ts`. As written, R5's mitigation ships as an assertion.

**Fix.** Add `<M>/data/enrichers.ts` as a task (a single `enrichMany` doing two batched `$in`
lookups — customer ids → names, channel ids → display names — mirroring
`communication_channels/data/enrichers.ts:164-220`, four queries per page regardless of row count),
add `enrichers: { entityId: E.connect.connect_case }` to T-API-01, and derive T-TEST-08's ceiling
from that count instead of leaving it "the declared ceiling". Note the id form the platform actually
uses is a string (`customers/api/people/route.ts:89` passes `'customers.person'`).

---

#### F-M3 — T-WID-01's "has open case" column cannot run: `sales/api/orders/route.ts` declares no enricher host

**Spec location:** T-WID-01 (*"needs both a response enricher (supplies the field) and an
`InjectionColumnWidget` (renders the column)"*); PR B; § Core-edit ledger.

**Defect.** An enricher only runs where the **host route** opts in. `sales/api/orders/route.ts`
contains no `enrichers` key at all (its only `entity:` references are `SalesOrder` at `:9` and
`:27`); the routes that do opt in are `customers/api/people/route.ts:89`,
`customers/api/interactions/route.ts:87`, `customers/api/deals/route.ts:450`,
`staff/api/timesheets/time-projects/route.ts:94`, `catalog/api/products/route.ts:806`,
`catalog/api/variants/route.ts:107` and `sales/lib/makeSalesLineRoute.ts:156`.

So T-WID-01 requires an edit to `packages/core/src/modules/sales/api/orders/route.ts` adding
`enrichers: { entityId: … }`. That edit is a core change to `sales` that appears in **neither** the
Core-edit ledger nor PR B, whose scope is *"stability commitment on `customers.interactions.create`
… four new detail injection spots plus one declaration"*.

**Fix.** Add the `sales/api/orders/route.ts` enricher-host edit to PR B and to the Core-edit ledger
with a class and a "sanctioned alternative considered" cell, or drop the orders-list column from
Phase 1. Note that the enricher will be `connect`-owned but declared against `sales:sales_order`,
which also needs a feature gate so a user without `connect.inbox.view` does not learn that a case
exists.

---

#### F-M4 — `connect.case.assigned`'s newly-named writer is forbidden by FR-024, and `new → in_progress` still has no endpoint

**Spec location:** § Frozen surfaces (*"`connect.case.assigned` is emitted by T-API-03 (transfer) and
by assignment on the CRUD route"*); FR-024; § API contracts CRUD line; § Status machine row 1.

**Defect.** The two statements are in direct contradiction, three paragraphs apart in the same
section. § API contracts says CRUD uses `makeCrudRoute(…)` *"with `status`, `resolved_at`,
`closed_at` and `assignee_user_id` **excluded from the updatable set** (FR-024)"*, and FR-024
restates it as a MUST NOT. The CRUD route therefore cannot perform "assignment", so it cannot emit
`connect.case.assigned`.

Consequently the only writer is T-API-03 (`/transfer`) — which is also the declared writer of
`connect.case.transferred`, making one of the two IDs writer-less again. Separately, § Status machine
row 1 gives `new → in_progress` the trigger *"assign, or first agent action"*, but § API contracts
lists no assign endpoint, so half that trigger is unreachable.

**Fix.** Add `POST /api/connect/cases/{id}/assign` (feature `connect.inbox.handle`, guard op
`update`) to the § API contracts table with its own task, name it as the writer of
`connect.case.assigned`, and say how it differs from `/transfer` (self-claim vs. hand-off) — or drop
`connect.case.assigned` from the frozen ten and defer it, applying § Frozen-surface drift's own
"every ID has a writer" test.

---

#### F-M5 — poll-on-focus + 30 s is unspecified where it collides with optimistic locking, and it is the load R5 is measured against

**Spec location:** § Inbox freshness; T-UI-11; FR-007; T-UI-07; U7; R5; § Cache deferral.

**Defect.** Polling is precedented in this repo (`WmsOperationalDashboardPage.tsx:62,415` at 60 s;
`QueryIndexesTable.tsx:356` at 4 s; `visibilitychange` handling in
`packages/ui/src/backend/progress/useProgressPoll.ts:146`), so the choice is defensible. Two things
about it are unspecified and one is precedent-contrary.

1. **It can silently disarm FR-007.** § UI says *"each pane holds its own `updatedAt`"*, and optimistic
   locking works only because the client holds a **stale** version. v2 never says whether the 30 s
   poll refreshes that held `updatedAt`. If it does, U7 (two tabs edit one Case → conflict bar) is
   unreachable within 30 s and the second tab silently overwrites — the exact defect FR-007 forbids.
   If it does not, every poll's payload disagrees with the held header and the pane must decide
   whether to surface a conflict for a change the user did not make.
2. **The closest shipped precedent does the opposite, and for free.** The platform's own Inbox for
   this archetype invalidates on `useAppEvent('messages.message.*')` **and**
   `useAppEvent('om:bridge:reconnected')` (`messages/components/MessagesInboxPageClient.tsx:84-90`),
   and `communication_channels.message.received` is already `clientBroadcast: true`
   (`communication_channels/events.ts:6-11`) — so `connect` can subscribe today at zero upstream
   cost. § Inbox freshness does not mention that this option is already wired.
3. **It contradicts R5's own budget.** Every agent polling an uncached list endpoint every 30 s —
   with the F-M2 enricher attached — is the sustained load R5 caps, and T-TEST-08 measures a single
   request. The interaction is unmodelled.

**Fix.** State the `updatedAt` rule explicitly (recommended: the pane's lock header is pinned at
load/last-successful-write and is **not** advanced by a background poll; a poll that observes a newer
`updatedAt` renders the conflict bar without rewriting the header). Add `om:bridge:reconnected`
handling to T-UI-11 regardless of the push decision, and either subscribe to the existing
`communication_channels.message.received` broadcast or record in § Inbox freshness that it was
considered and why it was declined. Give T-TEST-08 a per-agent-per-minute figure, not just a
per-request one.

---

#### F-M6 — T-SEQ-01 copies a pattern whose scope is org-NOT-NULL into a nullable-org, per-tenant-unique column

**Spec location:** T-SEQ-01; FR-002; § Data model (`case_number` *"unique per tenant"*,
`organization_id` nullable).

**Defect.** The named pattern does not transfer. `SalesDocumentSequence` declares
`@Property({ name: 'organization_id', type: 'uuid' }) organizationId!: string` — **non-nullable** —
and its uniqueness is `@Unique({ properties: ['organizationId', 'tenantId', 'documentKind'] })`
(`packages/core/src/modules/sales/data/entities.ts:790-806`); the generator's scope type is
`{ organizationId: string; tenantId: string }`
(`packages/core/src/modules/sales/services/salesDocumentNumberGenerator.ts:13-16`). v2 asks for a
**per-tenant** unique `case_number` on rows whose `organization_id` may be NULL, so a per-(org,tenant)
sequence row cannot be located and a per-tenant sequence is a different design.

It is also a `sales`-owned service, not a shared helper, so "the pattern" must be re-implemented
rather than reused — and T-SEQ-01 names no concurrency strategy, which is the only interesting part
of a sequence allocator (the sales generator carries `MAX_SEQUENCE`, a settings lookup and a
collision-avoidance nanoid; none of that is specified for `connect`).

**Fix.** Declare `connect_case_sequences` keyed on `(tenant_id, ???)` explicitly, resolving the org
question together with **F-C3**; name the concurrency strategy (`SELECT … FOR UPDATE` on the sequence
row inside the ingest transaction, or an insert-and-retry on the `(tenant_id, case_number)` unique);
add a seed in `onTenantCreated`; and add a T-TEST case for concurrent allocation.

---

### Minor

#### F-m1 — the citation supporting T-SET-03 points at the wrong subsystem
The Core-edit ledger row says the CLI AST-parses `enabledModules`, citing
`packages/cli/src/lib/agentic-setup.ts:94-101`. That function is `readEnabledModuleIds`, used for
**agentic-harness module fact-sheet selection** (its own header says so at `:92-95`) — it has nothing
to do with `yarn generate`. The generate/migration path is `loadEnabledModulesFromConfig`
(`packages/cli/src/lib/resolver.ts:342-364`), which reads `src/modules.ts` and falls back to scanning
`src/modules/*`. The conclusion is right; the evidence is not.
**Fix.** Cite `resolver.ts:342-364`.

#### F-m2 — T-SET-03 names the wrong `package.json`
T-SET-03 says *"root `package.json` workspace dep"*. The root `package.json` has **zero**
`@open-mercato/*` dependencies (it only declares `workspaces: ['apps/*','packages/*',
'external/official-modules/packages/*']`); the `workspace:*` entries live in
`apps/mercato/package.json` (e.g. `@open-mercato/checkout: workspace:*`).
**Fix.** Point T-SET-03 at `apps/mercato/package.json`, and add the `packages/create-app/template`
package.json mirror if the packages ship in scaffolds.

#### F-m3 — `communication_channels/AGENTS.md` does not exist either
T-UP-04 and PR C say *"a 'Public Contract Surfaces' table in the module's `AGENTS.md`"*. Neither
`packages/core/src/modules/communication_channels/AGENTS.md` nor
`packages/core/src/modules/messages/AGENTS.md` exists. v2 spotted the second and missed the first, so
T-UP-04 is a **file creation**, and a new module `AGENTS.md` counts against the shared instruction
budget checked by `yarn agents:check-budget` (root `AGENTS.md` § Instruction budget).
**Fix.** Reword T-UP-04 to "create `communication_channels/AGENTS.md`" and put the budget check in
PR C's DoD.

#### F-m4 — T-DATA-05's widening is feasible, but the task names only one of the file's two path resolvers
Verified: `readEntitySource` at `optimistic-lock-editable-entities.test.ts:70-75` is
`join(__dirname, '..', 'modules', moduleId, 'data', 'entities.ts')` — hard-bound to
`packages/core/src/modules`, so a `connect` key does throw ENOENT at collection time exactly as
T-DATA-05 says, and widening is straightforward (the sibling guard
`packages/search/src/modules/search/__tests__/global-search-acl.test.ts:73-78` already lists
`packages/checkout` alongside `packages/core`, so the multi-package precedent exists — T-SRCH-01's
widening is uncontroversial).

Two things T-DATA-05 omits. The file has a **second** `__dirname`-relative read at `:204`
(`join(__dirname, '..', 'modules', route)`) for the reader-resolution guard; it is only skipped
because case (a) short-circuits when the entity has `deleted_at` (`:166-168`) — which every `connect`
table does, per § Data model. That dependency should be stated, or a future `connect` table without
`deleted_at` reds the file again. And widening makes a `packages/core` test read from
`packages/connect`, i.e. a core guard that fails when an optional OSS package is absent.
**Fix.** State both: the `deleted_at` precondition, and that the widened resolver must tolerate a
missing package path rather than throw.

#### F-m5 — the four-segment ACL drift is still unreconciled
§ Frozen surfaces cites `frozen-surfaces.md:68-70` for the six IDs but not `:66-67`, which states the
format is `<module>.<resource>.<verb>` **"with no exceptions"** and then lists the four-segment
`connect.cases.view.all` (and `connect_analytics.view.agents`,
`connect_routing.presence.manage.others`). v2 resolves the `/metrics/baseline` overload but leaves the
format contradiction standing, in a surface v2 itself calls DB-stored and rename-hostile.
**Fix.** Either soften `frozen-surfaces.md:66-67` to allow a qualifier segment, or rename to
`connect.cases.view_all` before commit 1 — and say which, in § Frozen surfaces.

---

FINDINGS: 3C/6M/5m

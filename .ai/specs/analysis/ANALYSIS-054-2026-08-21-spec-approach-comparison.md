# ANALYSIS-054 — Mercato Connect: comparison of two specification packages

**Date**: 2026-08-21
**Subjects**:
- **A** — `cez/a5fd2e52` · `.ai/specs/2026-08-21-mercato-connect-omnichannel.md` + companion dir + `ANALYSIS-051/052/053`. ~2,982 authored lines / 18 files. Workflow: speckit (`specify → plan → tasks → analyze`) + two `om-pre-implement-spec` passes + one `om-spec-writing` architectural review.
- **B** — `cez/1d5b5fb2` · `.ai/specs/2026-08-21-app-spec-mercato-connect.md` (v3) + `2026-08-21-connect-phase-1-one-inbox.md` + `ANALYSIS-2026-08-21-connect-phase-1` + `app-spec-notes/`. ~2,200 authored current lines (plus 3,723 lines of copied design HTML and a 2,317-line superseded v1). Workflow: app-spec + inline architect checkpoints + inline challenger + three independent review rounds + one `om-pre-implement-spec` pass.

**Method**: both packages read in full and scored independently before comparison. All self-assessments (A's ANALYSIS-051/052/053; B's challenger-review and three review registers) were treated as claims, not evidence. 30+ factual assertions were re-checked against source in this worktree; the audit is §3.

**Reviewer independence**: this comparison was produced by a third session with no authorship stake in either package. It has its own limits — it verified spot-checks, not every claim, and it did not implement either design.

---

## 1. Scorecard

Scored 1–5 per dimension, independently, before comparison.

| # | Dimension | **A** | Evidence | **B** | Evidence |
|---|---|:--:|---|:--:|---|
| 1 | Requirement fidelity to the design | **4** | 12 stories / 100 FRs / 25 edge cases / 22 SCs, each screen traceable; 15 named Assumptions where the prototype was silent (`spec.md:303-509`). But the design source is not kept in the package — traceability is to a URL — and the prototype is read as UI, never as a fixture. | **3** | Design source kept in-repo and mined as data (`app-spec-notes/design-source/`), catching things A structurally could not. But v3 is **not self-contained**: §§4.1–4.4, 6, 8, 9 are absent and §§2/3/3.5/5 are deltas against a v2 file that was overwritten and no longer exists (`app-spec-mercato-connect.md:32-35`). Nine of thirteen screens have no readable current requirement. |
| 2 | Grounding in the real codebase | **4** | Line-exact on everything it checked: `realtimePush?: boolean` at `communication_channels/lib/adapter.ts:50` ✓; `messages` has no `di.ts` ✓; `di.ts` entity-registration comment quoted verbatim ✓; DOM bridge 4096 B / 30 s / 45 s ✓; root `AGENTS.md` 31635 vs 31232 ✓. Found and fixed a real repo doc defect (`packages/core/AGENTS.md:76`). Docked for what it never checked — the send path, `senderUserId`, the module-toggle mechanism. | **4** | 20+ claims verified, all correct, several at line precision (`availabilityMerge.ts:135`, `send-as-user.ts:101-103`, `sync.ts:854`, `nav.ts:307`, `people-v2/[id]/page.tsx:300`). Docked because the **shipped v3 still carries a clause its own reviewer proved fabricated** (`app-spec-mercato-connect.md:407`, "tests pass only because they pin `TZ=UTC`") alongside two other known-wrong platform claims, deliberately unpatched. |
| 3 | Architectural soundness | **3** | Thread aggregate, peer-read facades, FK-id+snapshot, one-directional reach are all right (`research.md` R-01, `contracts/peer-read-facades.md`). Against: the eight-modules-are-eight-toggles thesis (`research.md` R-11, FR-071–074, SC-009) has **no runtime mechanism in this platform**; and the unified thread has **no specified write path** (§3.1 below). | **4** | Deeper on the questions that bite: shared-channel send blocker decomposed into four real causes (`phase-1:147` D5); non-nullable `CustomerInteraction.entity` with three rejected alternatives before recommending stage-and-backfill (`app-spec:410`); `principal_kind` with fail-closed sentinel semantics; derived-and-reconciled `current_case_count` with a backfill. Against: nine packages asserted not justified; invariant 14 unimplementable as costed (register-v3 C3). |
| 4 | Backward-compatibility discipline | **3** | Audited **13** surfaces; `BACKWARD_COMPATIBILITY.md` has **14**. The omitted one is **#12 AI Agent/Tool/UI Part/Override IDs (FROZEN)** — which A's own P1 adds to (`tasks.md` T063 `ai-agents.ts`, T064 `ai-tools.ts`). Everything audited is correct. | **4** | Audited all 14 and flagged that the tooling's table is stale (`ANALYSIS-…-connect-phase-1.md:50`). `frozen-surfaces.md` is the best BC artifact in either package: 16 module IDs, 10 events, 36 ACL IDs (un-hiding ten from a `<key>` wildcard), 4 spots + 1 declaration corrected against the shipped regex, 9 DI keys, 7 notification IDs, 9 AI IDs, with a precedence rule. Docked for residual drift (§3.2). |
| 5 | Data protection & tenancy | **3** | Tenancy is strong — composite scoping everywhere, V13 as a hard non-negotiable gate, broadcast payloads restricted to ids/counters, encrypted `identifier` excluded from the search doc (`tasks.md` T044). PII fails: `customer_snapshot` carries name + e-mail on three entities and is in no encryption map (`data-model.md:29`, T011) — A's own Critical A1, **still unfixed in `tasks.md`**. `identifier_hash` reinvents a shipped primitive. | **4** | `encryption.ts` + `hashField: 'handle_value_hash'` with the unique index on the hash and `lookupHashCandidates` on read (`phase-1:121-127`) — uses the platform mechanism `auth`/`customer_accounts`/`messages` already use. Consent re-checked at dial time; `revokeAllUserSessions` **inside** the re-link transaction; cross-tenant reference returns **404, never 403**. No denormalised customer PII exists at all. Against: `connect_pending_projection` leak path open (register-v3 C6). |
| 6 | Implementability | **4** | 87 tasks, **every one names a file path**, dependency graph + parallel sets + runner mode recorded, tests mandatory rather than opt-in (`tasks.md:26-33`). The best executable artifact in either package. Docked for ≥6 stale task cross-references surviving the renumber (§3.1) — the exact risk ANALYSIS-051 logged and then hit. | **3** | Phase 1 is genuinely executable: 40 named commits, 4 independently-mergeable slices, ordered plan, binding upstream PR order A→B→D. But commits are named, not pathed ("WF1-11 composer"); the App Spec above it is a delta document an implementer cannot resolve; and two Phase-2 blockers have no owner (`businessMillisBetween`/`addBusinessMillis` do not exist; `responded_at` not derivable from what Phase 1 records — register-v3 C5). |
| 7 | Testability & acceptance | **4** | V1–V14 map to acceptance scenarios; the two hardest guarantees get dedicated specs (SC-005 never-auto-send T077, tenancy T058); cache invalidation, undo round-trip, racing-inbound concurrency, render budget all have tasks. Against: SC-013 is a post-launch business KPI (A's own A7, unfixed); and T056 promises "all six US1 acceptance scenarios" while scenario 1 requires a **phone** contact that P1 cannot produce (`tasks.md:24`). | **4** | Best negative-path coverage in either package: T4/T5 (auto-responder, DSN → **no Case**), T7 (failed send does **not** stamp first response and does not advance status), T20 (query-count ceiling at 300 Cases), T21 (redelivery no-op), T22 (denying guard blocks *and* `afterSuccessCallbacks` do not run), T23 (ciphertext unreadable at rest, hash uniqueness), T14+T15 (cross-tenant **and** cross-customer). Against: programme-level KPIs openly not measurable. |
| 8 | Scope discipline | **4** | P1 = one module, two stories, exclusions enumerated, four named boundaries where P1 touches P2/P3 concerns, "then stop and re-plan" (`tasks.md:6-24, 269`). Against: the spec bundles eight capabilities (A's own A2). | **4** | Sharper slice: e-mail + web form only, on adapters that already ship; no SLA, no queues, no routing, no AI, no portal; `service_queue_id` "always null in Phase 1"; queues "absent entirely, **not stubbed**" (`phase-1:150`). Against: the programme above it is eight phases with an openly wrong business case and two live product decisions parked as author recommendations. |
| 9 | Honesty & self-knowledge | **4** | Reviewer-independence caveat in ANALYSIS-053 is exemplary; counts corrected in public with reasons (22→23→28 entities, 26→25 edge cases); pre-existing budget failure verified by stash probe not assumed. Against: the checklist's "**Verdict: … Ready for `/om-implement-spec`**" (`checklists/requirements.md:104`) was never retracted after ANALYSIS-053 returned **request changes** — the entry point ships both. | **5** | Unmatched. v3 opens with "⚠️ architecture usable, **business case and estimate are not**", names three known-wrong things and says they were deliberately not patched a fourth time. register-v3 adjudicates a disagreement **between its own reviewers** and explains why both are right about what they checked. It retracts a fabricated clause inside its own anti-fabrication exemplar. §5's process finding — "the rule is sound; nothing enforced it" — is the sharpest sentence in either package. |
| 10 | Signal-to-noise | **4** | ~2,980 lines for 100 FRs + 7 contracts + 87 tasks; contracts are dense and each earns its place. `tasks.md` repeats AGENTS.md rules inline — deliberate and defensible for isolated task execution. | **3** | Not bloated in volume, but the *shape* costs the reader: a delta-only v3 forces reconstruction across three review registers, and whole sections simply aren't there. Business arithmetic occupies a large share of §1 and is known-wrong. `frozen-surfaces.md` and `commits-by-workflow.md` are excellent and dense. |
| | **Total** | **37** | | **38** | |

The totals are close and that is the honest result. They are not two attempts at the same quality level — they are two packages with **inverted failure modes**. A is an execution plan with unverified architectural premises. B is a verification record with no execution plan.

---

## 2. What each caught that the other missed

### 2.1 What A caught that B missed

**A-1. The peer-read boundary, with the correct lesson and the correct precedent.**
A identified that reading `messages` and `communication_channels` tables from a new module is storage coupling, cited `.ai/lessons.md` → *"Cross-module query precedent is not permission to copy storage coupling"* (verified, `.ai/lessons.md:58`), noticed that `communication_channels/di.ts`'s entity registrations are commented *"for EntityManager lookups by string"* and are therefore **not a read API** (verified verbatim), and that the sanctioned precedent in the same file is `communicationChannelsSendAsUser` (verified). It then specified two source-owned facades with nine numbered requirements including mandatory scope parameters, batching, plain projections, empty-vs-missing distinction and no-side-effects (`contracts/peer-read-facades.md` P-01…P-09). B specifies no read boundary at all — `phase-1:112` says only "binds to `communication_channels` via subscriber + adapter send".

**A-2. `messages` has no DI surface, and adding one is the right fix.**
Verified: `packages/core/src/modules/messages/` contains no `di.ts`. A treats this as a blocker and adds one as an additive BC #9 change with an AGENTS.md contract-surface entry (T020, T022). B's Phase 1 never confronts how `connect` reads thread messages.

**A-3. The system-initiated write path as a systematic blind spot.**
ANALYSIS-052's three majors (D1 no cache invalidation on inbound, D2 no timeout on the outbound provider call, D3 check-then-act on conversation creation) were found by asking one question — "who writes this when no agent is present?" — and are all real. B's Phase 1 gets D3's equivalent right (T21, idempotent on `external_message_id`) but has **no timeout requirement anywhere** on its adapter send path, and its cache decision is "no caching in Phase 1", which sidesteps rather than solves D1.

**A-4. A named negative assertion for the product's hardest safety promise.**
SC-005 / T077 (`never-auto-send.spec.ts`, "MUST run on every build") is a standing regression gate on "no reply reaches a customer an agent did not see". B's invariant 5 states the same rule more precisely (re-evaluated *inside the append transaction*) but has no Phase-1 test because Phase 1 has no AI — so the guarantee ships untested when AI arrives in Phase 4.

**A-5. Explicit degradation as a testable contract, not a hope.**
FR-091 + V14 + T079/T080 assert both directions: every capability degrades with a *named explanation* when a peer is absent, **and** no platform module imports or hard-requires the suite. B asserts the boundary in prose (`architect-checkpoints.md`) and round 2 correctly noted that `module-decoupling.test.ts` is a hand-written fixture with no static import-graph check — but B then does not specify a replacement.

**A-6. A file-pathed, dependency-ordered task list.** This is not a small thing. An agent can execute `tasks.md` tomorrow. It cannot execute `commits-by-workflow.md` without first deciding where every file goes.

### 2.2 What B caught that A missed

**B-1. Cross-channel reply — the product's headline behaviour — has no working send path.**
Verified: `send-as-user.ts:101-103` returns **403 "You can only send through channels you own"** when `channel.userId !== actor.userId`. A contact centre works shared mailboxes and shared numbers. B decomposed this into four independent blockers (per-user credentials with nothing writing a `user_id IS NULL` row on this path; from-address derived from the credential blob; no path creates a shared channel; `senderUserId` NOT NULL), rejected a caller-supplied `allowSharedChannel` flag as *itself an escalation vector*, and costed it as an 8–12 commit upstream workstream that must merge first (`phase-1:147` D5, `frozen-surfaces.md:131`).
A's T031 says "resolve the target `CommunicationChannel`, call the existing `ChannelAdapter.sendMessage`" — bypassing the in-process facade A itself mandates for reads, bypassing `guardOutboundCreate`, and never touching the ownership gate. **FR-013, US1 scenario 3 and V1 all depend on a path A has not established exists.**

**B-2. `messages.Message.senderUserId` is NOT NULL.**
Verified (`messages/data/entities.ts:53-54`). A writes calls, bot entries and system events into the thread as `Message` rows (`research.md` R-07, FR-009) and never mentions the column. B names it as a DB contract-surface change needing sign-off and cites `communication_channels/lib/system-user.ts` as the shipped workaround — and then notices that the workaround returns a **sentinel UUID with no `auth.users` row** (verified, `system-user.ts:8`), which is why `principal_kind` must fail closed.

**B-3. There is no runtime module enable/disable in this platform.**
Verified: `feature_toggles` entities carry `identifier`/`type`/`default_value` and a tenant override — **no `module_id`, no nav or route binding**; module registration is build-time in `apps/mercato/src/modules.ts`; no `isModuleEnabled`/`moduleEnabled` primitive exists in `packages/shared` or `packages/core`.
A's entire module decomposition rests on the opposite: FR-071–074, US6, SC-009 ("**without any restart or re-login**") and research R-11 ("the platform's unit of enable/disable *is* the module"). A's Complexity Tracking defends eight modules *because* the module boundary is the toggle boundary. It is not, at runtime.
B found this in round 1 (B-4), proposed `configs.ModuleConfig` + `page.meta.visible` in v3, and then round 3 correctly refuted its own fix — `visible` is consumed at exactly one site, `nav.ts:307`, so the URL and the API stay reachable (verified). B is two levels deeper on a question A never asked once.

**B-4. `packages/contact-center` sits outside the entity-level optimistic-lock gate.**
Verified: `optimistic-lock-ui-coverage-workspace.test.ts` and `optimistic-lock-command-coverage.test.ts` scan every workspace package; `optimistic-lock-editable-entities.test.ts` resolves entity paths as `__dirname/../modules/<id>` — **`packages/core` only**. Root `AGENTS.md` names that test as the enforcement for the default-ON rule. A's `plan.md` rule 8 reads PASS with no note; B's v3 §4.5 states the inversion and adds each `connect*` entity to the curated map as an explicit line item.

**B-5. `CustomerInteraction.entity` is a non-nullable `@ManyToOne`.**
Verified, plus `requireTimelineParentEntity` rejects any kind outside `{person, company}`. An unidentified contact therefore **cannot** be projected onto the Customer 360 timeline. B enumerated four options, rejected three with reasons, and recommended stage-and-backfill via `connect_pending_projection`. A's FR-016 ("closing MUST record an after-contact summary on the customer record") and FR-029 (unified timeline) never name `CustomerInteraction` and would hit this wall the first time an unknown caller's case is closed.

**B-6. `hashField` already exists; do not invent a hash column.**
Verified: `auth/encryption.ts`, `customer_accounts/encryption.ts` and `messages` all use `hashField` for encrypted equality lookup. A specifies a bespoke `identifier_hash` "deterministic hash for lookup without decryption" with no keying requirement and no reference to the platform mechanism; B uses `hashField` and additionally handles the keyed-`v2:`-vs-legacy-unkeyed case via `lookupHashCandidates`, and puts the unique index on the hash because *"a plain `@Unique` on the ciphertext is meaningless, since every row has a distinct IV"* (`phase-1:219`).

**B-7. The prototype as a fixture, not a picture.**
B read `CHANNELS_CFG`, `BARS`, `KPIS`, `CAMPAIGNS`, the intent table and `navKeys` as data and found: the first-response SLA KPI is a **regression sold as a gain** (93 % → 91 %, warning colour, −2 pts against a 93 % goal); the spec said 12 screens while `navKeys` enumerates 13; the prototype claims 12 intents and shows 5; the channel-mix chart does not reconcile against any single denominator and is hand-authored. A's Assumption 5 dutifully copies the prototype's SLA presets and Assumption 10 its reporting period, but A never notices that the prototype's own numbers disagree with each other. On requirement *fidelity* A is more complete; on requirement *truth* B is the only one that looked.

**B-8. The widget spot pattern A and B both initially got wrong.**
Verified: `sales/extension-points.ts:22` declares `sales.document.detail.{kind}:{surface}` with `kind: ^(order|quote)$` and `surface: ^(tabs|details)$` — it rejects both `return` and `sidebar`. B's round 3 caught this against its own commit plan and corrected to the shipped `detail:sales.order:shipping` family. It also verified that `detail:customers.person:tabs` is *used* at `people-v2/[id]/page.tsx:300` but **not declared** in `extension-points.ts`. A's `contracts/ui-extension.md` names six host spots it consumes, including `admin.page:/backend/customers/[id]:after` and `crud-form:customers:person:fields`, with no check that any of them exists.

---

## 3. Factual accuracy audit

### 3.1 A — claims checked

| # | Claim | Where | Verdict |
|---|---|---|---|
| 1 | `communication_channels/di.ts` registers entity classes "for EntityManager lookups by string"; sanctioned precedent is `communicationChannelsSendAsUser` | `research.md` R-01, `peer-read-facades.md:15-18` | ✅ **Correct, verbatim** |
| 2 | `messages` has no `di.ts` | `peer-read-facades.md:16` | ✅ **Correct** |
| 3 | `ChannelThreadMapping.message_thread_id` maps external conversations onto `messages.Message.thread_id`; `messages_thread_idx` exists; no `MessageThread` entity | `research.md` R-01 | ✅ **Correct** (`entities.ts:336`, `messages/data/entities.ts:29,47`) |
| 4 | **"The cross-channel primitive already exists and is unused at the product level… the unified thread is an *aggregation* problem, not a storage one… FR-088/SC-018 come free"** | entry point:66, `research.md` R-01:19 | ⛔ **Half wrong — see 3.1a** |
| 5 | `realtimePush?: boolean` at `lib/adapter.ts:50` is the in-file precedent with identical omit-means-default semantics | `research.md` R-09 | ✅ **Correct, line-exact** |
| 6 | API route URLs include the module id; `packages/core/AGENTS.md:76` documents it wrongly | ANALYSIS-051:49 | ✅ **Correct** — `cli/src/lib/generators/openapi.ts:196` builds `` `/api/${modId}/…` ``. A found and fixed a genuine repo defect. |
| 7 | `packages/enterprise` hosts `record_locks`, `security`, `sso`, `system_status_overlays` as sibling modules | `research.md` R-11, `plan.md:104` | ✅ **Correct** |
| 8 | DOM Event Bridge caps payloads at 4096 B, heartbeats 30 s, reconnects at 45 s | `research.md` R-04, `contracts/events.md:7` | ✅ **Correct** (`packages/events/AGENTS.md:178-179`) |
| 9 | `.ai/lessons.md` records "Cross-module query precedent is not permission to copy storage coupling" | `peer-read-facades.md:9` | ✅ **Correct** (`.ai/lessons.md:58`) |
| 10 | `planner/commands/availability.ts` is the `extractUndoPayload` precedent | `tasks.md` T028 | ✅ **Correct** (lines 19, 260, 311) |
| 11 | `agents:check-budget` fails pre-existing at 31635 vs 31232 bytes | entry point:178, `checklists/requirements.md:102` | ✅ **Correct, byte-exact** — reproduced |
| 12 | `MessageChannelLink` at `data/entities.ts:269`; `ContactHint` at `lib/adapter.ts:382` | `research.md` R-05, R-02 | ✅ **Correct** |
| 13 | `ChannelAdapter.sendMessage` at `lib/adapter.ts:55` | `research.md` R-05 | ⚠️ **Wrong line** — it is at `:501`. Harmless. |
| 14 | "No BC violations found across **all 13 surfaces**" | ANALYSIS-051:29 | ⛔ **Wrong** — `BACKWARD_COMPATIBILITY.md` has **14**. A's table skips **#12 AI Agent/Tool/UI Part/Override IDs (FROZEN)** and renumbers CLI to 13 and Generated to 14→13. A's own P1 adds AI agent and tool IDs (T063, T064). A inherited "13" from root `AGENTS.md` without checking the document it cites. |
| 15 | Module id `conversations`, event prefix, ACL prefix, table prefix all free | ANALYSIS-051 table | ✅ **Correct** |
| 16 | Task cross-references after the Phase-2A renumber | `tasks.md`, `peer-read-facades.md` | ⛔ **Six stale refs — see 3.1b** |

**3.1a — the load-bearing error.** A's schema claim is right: `channel_thread_mappings_ext_conv_uq` is unique on `(externalConversationId, tenantId)`, while `messageThreadId` carries only an index — so N external conversations *may* share one thread id. But nothing in the platform ever produces that state. Every strategy in `lib/thread-matcher.ts` filters by `channelId` (`:110, :128, :150, :174`) — the shipped matcher is strictly **intra-channel**. `ingest-inbound-message.ts:402` writes `messageThreadId: message.threadId ?? message.id`, seeded from that channel-scoped match. So a WhatsApp message and a phone call for the same customer get **different** thread ids, always.

To unify them, `conversations` must **write** `ChannelThreadMapping.messageThreadId` — a write into a peer module's table, which A's own C1 rule forbids and which A's facades explicitly cannot do (`peer-read-facades.md` P-06: *"Pure reads — no writes, no events, no side effects"*). T042 "folds a new external conversation into a `ServiceConversation` **via the T019 facade**", a read facade.

The consequence is that A's P1 has **no specified mechanism to bind two channels into one thread** — the entire product. And the branch A takes decides FR-088/SC-018: if `conversations` keeps the binding privately in `ConversationChannelBinding` (which it has), then a pre-existing platform surface reading the same `threadId` sees only one channel, and SC-018 ("identical message history from both surfaces, zero divergence") is **false**. T057 (`single-record.spec.ts`) asserts exactly the property this ambiguity decides. None of A's three analyses caught it.

**3.1b — stale task cross-references.** `T041` is *"Export `openApi` from each route file"*; the inbound-binding subscriber is `T042`. `T041` is referenced as "inbound binding" in four live places: `tasks.md:59`, `tasks.md:144`, `tasks.md:214`, `peer-read-facades.md:105`. `peer-read-facades.md:90` cites `T043` for the search-index exclusion; the `search.ts` task is `T044` (`T043` is the query-index subscriber) — ANALYSIS-053's "A8 fixed immediately" moved this from T046 to the *wrong* number. `peer-read-facades.md:92` cites `T078` for `module-decoupling.test.ts`; that is `T079`. The entry point says "86 tasks" at line 23 and "87 tasks" at line 160. ANALYSIS-051 logged "renumbering fragility — never renumber by regex; regenerate the file" as a medium risk, and the package then did exactly that.

### 3.2 B — claims checked

| # | Claim | Where | Verdict |
|---|---|---|---|
| 1 | `planner` cannot express business hours: `availabilityMerge.ts:135` steps `cursor + 7 * DAY_MS`; `timezone` appears 0 times; `BYDAY` written at `availability-weekly.ts:89` and never parsed; only `FREQ=DAILY\|WEEKLY` accepted | `app-spec:407` | ✅ **All four correct**, verified individually. `parseRrule` reads only DTSTART/DURATION/FREQ/COUNT. |
| 2 | "…and the tests pass only because they pin `TZ=UTC`" | `app-spec:407` | ⛔ **Fabricated, and B knows it.** `availabilityMerge.ts` has 0 local-time accessors and 1 UTC accessor; there is no `lib/__tests__/availabilityMerge.test.ts`. register-v3 §2 identifies this as an invented clause inside R0.1's own exemplar — **and it is still in the shipped v3.** |
| 3 | `businessMillisBetween` / `addBusinessMillis` exist nowhere repo-wide | `frozen-surfaces.md:185` | ✅ **Correct** — 0 hits |
| 4 | `send-as-user.ts:101-103` hard-gates on channel ownership; `:191-236` creates both `ExternalConversation` and `ChannelThreadMapping`; `senderUserId` is NOT NULL | `phase-1:147`, register-v2 A2 | ✅ **All correct, line-accurate** |
| 5 | `integration_credentials.user_id` is `nullable: true` with a partial unique index — so *"nothing writes a `user_id IS NULL` row"* is too broad | register-v3 §2 | ✅ **Correct**, and it is a correction of B's own v3 text |
| 6 | `example_customers_sync/lib/sync.ts:854` already calls `customers.interactions.create` cross-module via the bus | `app-spec:409` | ✅ **Correct** — refutes B's own v2 premise |
| 7 | `CustomerInteraction.entity` is non-nullable `@ManyToOne`; `requireTimelineParentEntity` demands `kind ∈ {person, company}` | `app-spec:410` | ✅ **Correct** |
| 8 | `configs.ModuleConfig` carries `module_id` with per-tenant partial unique indexes at `:8` and `:13` | register-v2 | ✅ **Correct** |
| 9 | `page.meta.visible` is consumed at exactly one site — sidebar construction — so URL and API stay reachable | register-v3 §2 | ✅ **Correct** (`nav.ts:307`); refutes B's own v3 §4.5 |
| 10 | `feature_toggles` cannot disable modules — no `module_id`, no nav/route binding | register-v1 §1 | ✅ **Correct** |
| 11 | `inbox_ops/lib/rateLimiter.ts` has no sender dimension; cache keys hardcoded to `inbox_ops:` | register-v3 §2 | ⚠️ **Mostly correct.** Keys are hardcoded to `inbox_ops:rate_limit:${key}` ✓ and the only two call sites are a global bucket (`inbound.ts:294`) and a tenant bucket (`:339`) ✓. But `key` is a caller-supplied parameter, so a `(channel_id, from_handle_hash)` bucket *is* expressible — the defect is the namespace collision and the absent call site, not the signature. Slightly overstated. |
| 12 | `sales.document.detail.{kind}:{surface}` rejects `return` and `sidebar`; `detail:sales.order:shipping` is the right family | `frozen-surfaces.md:109` | ✅ **Correct** — `kind: ^(order\|quote)$`, `surface: ^(tabs\|details)$` |
| 13 | `detail:customers.person:tabs` is used at `people-v2/[id]/page.tsx:300` but not declared in `extension-points.ts` | `frozen-surfaces.md:106` | ✅ **Correct, line-exact** |
| 14 | Two of four optimistic-lock gates are workspace-wide; the entity-level `updated_at` gate is `packages/core`-curated | `app-spec:412` | ✅ **Correct** |
| 15 | `hashField` is the platform mechanism, used by `auth`, `customer_accounts`, `messages` | ANALYSIS C2 | ✅ **Correct** |
| 16 | `BACKWARD_COMPATIBILITY.md` has 14 surfaces; the skill's table says 13 | ANALYSIS N1 | ✅ **Correct** |
| 17 | The scheduler tick's "60 s interval floor" | `app-spec:431` | ⛔ **Wrong, and caught by B.** `Math.max(10, … ?? '60')` — default 60, floor 10. Still wrong in shipped v3. |
| 18 | `enforceCommandOptimisticLockWithGuards` — "31 call sites" (v3) vs "34 files / ~45 sites" (round 3) | `app-spec:415`, register-v3 | ⚠️ **Neither reproduces.** My count: 43 files, 101 occurrences (including tests/apps). Round 3's complaint — that no counting rule is stated — is the correct verdict on both numbers. |
| 19 | `frozen-surfaces.md` is the single source of truth for every frozen ID | `frozen-surfaces.md:3` | ⛔ **Contradicted by its own package.** `frozen-surfaces.md:68` lists the six Phase-1 `connect` ACL IDs including `connect.identities.manage`; `phase-1:318` lists six **different** IDs including `connect_analytics.view` and omitting `connect.identities.manage`. Meanwhile `phase-1:523` says "**Seven** new `connect.*` IDs" where `phase-1:302` and `frozen-surfaces.md:42` both say **ten**. And Phase 1's `/metrics/baseline` route is guarded by `connect_analytics.view`, a feature `frozen-surfaces.md` assigns to a module that does not exist until Phase 2. |

### 3.3 The named confidently-wrong assertions

- **A**: *"the cross-channel primitive already exists and is unused at the product level… FR-088/SC-018 come free"* (§3.1a). This is the thesis the whole package rests on, it is presented as verified-against-source, and it is wrong in the half that matters — the schema permits it, the platform never produces it, and A's own read-only facade rule forbids the write that would.
- **A**: *"No BC violations found across all 13 surfaces"* — the count is wrong and the omitted surface is one the slice touches.
- **B**: *"the tests pass only because they pin `TZ=UTC`"* and *"the 60 s interval floor"* and *"`configs.ModuleConfig` + `page.meta.visible` removes nav and API surface"* — all three are wrong, all three are in the current shipped v3, and **all three are identified as wrong inside the same package**, in a review register the spec's own header points at. That is a different and much less dangerous failure than A's: B's reader is warned; A's is not.

---

## 4. Where they disagree architecturally

**4.1 Where the cross-channel aggregate lives. B is right.**
A puts the aggregate on `messages.Message.threadId` and inherits the thread from the hub. B puts it in its own table: `connect_case` is the parent, `connect_conversation` is 1:1 with an `ExternalConversation` (unique on `(tenant_id, external_conversation_id)`), and grouping is `connect`'s own column. Given §3.1a — the platform's thread key is per-channel and only the hub writes it — B's placement is the one that works without a cross-module write. A's is more elegant *if* someone owns cross-channel thread minting; nobody does, and A does not propose to. **Not a trade-off: B's model is correct and A's needs repair.**

**4.2 Module granularity and the toggle boundary. Neither is right; B is closer.**
A: eight modules because each must be independently toggleable at runtime (FR-071–074, SC-009). B: nine packages because per-module disable is build-time registration in `apps/<app>/src/modules.ts`. Verified: there is no runtime module enable/disable primitive. A's premise is false. B's premise is true but its conclusion doesn't follow — build-time registration works identically for nine modules in one package, so nine packages buys nothing here (A's single-package-with-siblings layout matches the shipped `packages/enterprise` precedent better). The honest answer neither reaches: **the prototype's Settings switchboard is a tenant-level feature gate, not a module registry**, and it needs `configs.ModuleConfig` plus route-level enforcement that `page.meta.visible` does not provide.

**4.3 Voice. Genuine trade-off; A's is better specified.**
A defines a vendor-neutral `TelephonyAdapter` mirroring `ChannelAdapter`, with 11 numbered behavioural requirements on implementers (T-01…T-11) and an explicit ownership split table. B leaves telephony as **OQ-2, an open blocker**, having verified there is no upstream artifact of any kind (`grep webrtc|SIP|twilio|voip|softphone` → one false positive). Both defensible: A gets a contract that survives vendor choice; B refuses to specify against an unknown. A's is the more useful artifact and carries the risk that a real vendor won't fit `supplyRoutingContext`/`publishFlow` as shaped.

**4.4 Whether to build a cache in the first slice. B is right.**
A specifies a full cache-key and invalidation strategy in P1 (T015, T033, T042, T061). B declares **no caching in Phase 1** as an explicit decision: *"a cache before the SLA clock exists would only add invalidation paths to unpick in Phase 2"* (`phase-1:134`). A's own ANALYSIS-052 D1 is a direct consequence of building the cache early and then missing a write path. B's decision is stated, not omitted, which is what the rule actually requires.

**4.5 Requirement form. Trade-off, and they should be combined.**
A: 100 numbered testable FRs a checklist can walk. B: a ubiquitous language, 16 numbered invariants each naming *who writes it / in which transaction / what happens when the module is absent*, and derived-value formulas with anti-gaming clauses. B's invariant form catches whole classes A cannot express — e.g. that containment's numerator must require ≥1 bot outbound message, or containment **rises as the queue backs up**. A's FR form gives traceable coverage B has lost. There is no reason not to have both.

---

## 5. Workflow assessment

**A's loop — speckit + audit chain.** `/speckit-specify → plan → tasks → analyze`, then `om-pre-implement-spec` ×2, then `om-spec-writing` architectural review. Verdict: **the artifact-production half is excellent and the verification half has a structural ceiling.** Every pass changed the artifact and the changes are traceable: `/speckit-analyze` F1 pulled merge reversal into P1 (a real correctness fix); ANALYSIS-051 C1 created Phase 2A and a new contract document; ANALYSIS-052's three majors each landed in a task edit. This is not ceremony — the diffs are real and mostly correct.

Its ceiling is that **every pass was a checklist run by the author against the author's own text**. ANALYSIS-052 says so explicitly and demonstrates it: installing the missing code-review checklist produced three majors *"that pass 1 structurally could not have found"* — the finding rate tracked the checklist inventory, not the reasoning. The pattern repeats at the next level: ANALYSIS-053's Critical A1 exists because the rubric asked "is every PII column covered?" where the earlier passes asked "is encryption addressed?". Nothing in A's loop ever re-opened the *codebase* to falsify a premise it had already accepted — which is exactly why R-01, the one claim everything rests on, survived three reviews unchallenged (§3.1a). A's loop verifies **internal consistency and rule compliance**, at which it is very good, and cannot verify **premises**.

**B's loop — architect checkpoints → challenger → three independent review rounds.** Verdict: **the most effective verification process in either package, and it did not converge.**

It earns that on evidence. Round 1 produced 28 criticals across three role-scoped reviewers and its diagnosis — *"the author verifies that platform artefacts exist, not that they do the job"* — is the correct generalisation. Round 2 caught v2 repeating that exact error on its single largest decision (`planner`) **and writing it into §9 as a lesson learned**. Round 3 caught v3 violating the §0 evidence rules v3 had just written, 19 times, including a fabricated clause inside R0.1's own worked example. Each round found a *new class* of defect, not a re-run of the last. I re-verified 15 of these findings against source and every one held.

Two things separate it from A's loop. First, **it adjudicates reviewer disagreement rather than averaging it**: when DDD called §1.2.1 "the strongest section in the document" and PM/UX called it wrong, round 3 resolved it — DDD verified the arithmetic, which reproduces; PM/UX tested the unit, which does not; PM/UX went a level deeper. Second, **it diagnoses its own method, not just its output**: register-v3 §5 concludes that better rules do not fix self-verification, predicts that a v4 written the same way yields a fourth variant, and names the process change that would work (every capability claim carries a `file:line` to the code path that *performs* the behaviour, checked by someone other than the author).

Its failure is that **the loop outran the document**. Three rounds of findings were applied to v1 and v2 in place; the current v3 is a delta against a file that no longer exists, missing seven sections, carrying three claims its own reviewer proved false. B has the better *knowledge* and the worse *artifact*. It correctly refused to patch a fourth time — patching again would have produced a fourth variant, which is what its own analysis predicts — but the decision leaves an unusable programme spec behind.

**Was either mostly ceremony?** No. Both loops changed their artifacts in ways I can diff and verify. But they bought different things. A's bought **completeness and executability**. B's bought **truth**. On the evidence here, adversarial role-scoped review that re-opens the source is worth several times a checklist re-run by the author — the three findings that would actually break A's implementation (§2.2 B-1, B-3, and by extension §3.1a) are all of the kind only B's method produces.

---

## 6. Recommendation

**Merge, with B's Phase 1 as the shipping slice and A's execution discipline applied to it.**

Carrying A forward alone ships a slice whose headline behaviour (reply on any channel) has no working send path, whose unified thread has no write path, whose PII column is unencrypted against a stated hard rule, and whose modularity story has no mechanism. Carrying B forward alone ships a correct, narrow inbox under a programme spec its own review forbids implementing, with no file-level task list and two unowned Phase-2 blockers.

Exactly what comes from where:

| Layer | Source | Why, and what must be reconciled |
|---|---|---|
| **Shipping slice** | **B** — `2026-08-21-connect-phase-1-one-inbox.md` | Ships on adapters that already exist and its acceptance scenarios are satisfiable within the slice. A's P1 promises US1 scenario 1 (phone + WhatsApp in one thread) with no telephony until P2. Reconcile: pick one module id — `connect` and `conversations` are both free; prefer `connect` since `frozen-surfaces.md` already freezes 16 IDs around it. |
| **Product requirements** | **A** — `spec.md` §§Requirements, Success Criteria, Edge Cases | 100 numbered FRs / 22 SCs / 25 edge cases are traceable and self-contained; B has no current equivalent for nine of thirteen screens. Reconcile: **delete A's § Platform composition reuse column and replace it with B's verified §4.5/§4.6**; delete SC-009's "without any restart" until a mechanism exists; re-scope FR-071–074 from "module toggle" to "tenant feature gate". |
| **Domain rules** | **B** — §1.3 glossary, §1.4.2 invariants, §1.4.3 derived values | Add on top of A's FRs, not instead. B's invariant form (writer / transaction / absent-module behaviour) and its anti-gaming clauses express constraints A's FR form cannot. Keep A's numbering so traceability survives. |
| **Composition boundary** | **A's peer-read facades** + **B's aggregate placement** | Keep `contracts/peer-read-facades.md` P-01…P-09 verbatim — it is the best boundary artifact in either package. Replace A's `ServiceConversation`-keyed-on-`thread_id` with B's Case ← Conversation(1:1 `ExternalConversation`) model per §4.1. If cross-channel `Message.threadId` unification is still wanted, it needs a **write** facade owned by `communication_channels`, specified and costed — it is not free. |
| **Send path** | **B** — D5 / upstream PR A | Non-negotiable and blocking. A's T031 must be replaced by the shared-channel workstream: shared-channel creation command, `user_id IS NULL` credential provisioning, sender identity through `SendMessageInput`, authorisation delegated to `assertCanManageChannel`, `senderUserId` NOT NULL relaxation signed off. Keep A's D2 addition — an explicit timeout mapping expiry to 422 — which B lacks. |
| **BC + frozen surfaces** | **B** — `frozen-surfaces.md` wholesale | All 14 surfaces, including #12 AI IDs which A omits. Reconcile before commit 1: the six Phase-1 `connect` ACL IDs (`frozen-surfaces.md:68` vs `phase-1:318`), and seven-vs-ten event IDs (`phase-1:523` vs `:302`). Add A's `ChannelCapabilities.voice?` classification if telephony stays in scope — and rename it, `voiceNotes` already occupies the adjacent namespace. |
| **Data protection** | **B** | `encryption.ts` + `hashField` + unique index on the hash + `lookupHashCandidates` replaces A's bespoke `identifier_hash`. Apply A's ANALYSIS-053 A1 fix in its *recommended* form: drop name and e-mail from any snapshot and resolve live through `customers` with `tryResolve`, keeping only VIP flag / value metrics / initials. Add A's search-index exclusion (T044) as a standing rule. |
| **Execution plan** | **A's format**, **B's content** | Rewrite B's 40 named commits in A's `tasks.md` shape: file path per task, dependency graph, parallel sets, recorded runner, tests mandatory. **Regenerate IDs; never renumber** — A's six stale cross-references are the case study. Prepend B's binding upstream order A→B→D. |
| **Tests** | Union | B's negative paths (T4, T5, T7, T20, T21, T22, T23) and both isolation dimensions (T14 cross-tenant, T15 cross-customer via `ids=`); A's V13 tenancy hard gate, SC-005 standing negative assertion, V14 absent-module degradation, and the cache/undo/racing-inbound tests. |
| **Process** | **B's**, with its own round-3 fix | Role-scoped adversarial review that re-opens source, with the gate register-v3 §5 specifies: **every platform capability claim carries a `file:line` to the code path that performs the behaviour, checked by someone other than the author, before it is allowed to carry a commit credit or an architectural decision.** Applied to A's artifact set, that gate catches §3.1a on the first pass. |

**Do not carry forward**: A's `plan.md` Constitution Check as written (rules 8 and 9 read PASS on premises that don't hold); A's `research.md` R-11 module-decomposition rationale; B's App Spec §§1.2 and 4.8 (business case and estimate, known-wrong by B's own statement); B's nine-package decision.

---

## 7. Residual risk — what neither package addresses

1. **Nobody owns cross-channel thread minting.** A assumes the hub does it (it doesn't — §3.1a). B sidesteps it by grouping in its own table, which is correct for `connect` but means a pre-existing platform surface reading `messages` still sees per-channel threads. So FR-088 / SC-018 — *"a conversation surfaced in Mercato Connect and the same conversation reached through an existing surface are the same record"* — is **unsatisfiable as written** under either design without new work in `communication_channels`. Someone has to either weaken the requirement to "the same messages, grouped differently per surface" or fund a cross-channel thread-matcher.

2. **Identity resolution across channels has no evidence model in either package.** Both specify a confidence score and a threshold (A: `confidence numeric(4,3)` + `match_method`; B: per-`handle_type` thresholds, which is the better shape). Neither specifies *how confidence is computed* for a phone number seen on WhatsApp versus an Instagram handle, and the shipped `contact-resolver` returns a `ContactHint` with no score. This is the input to the Critical-severity failure both packages name (showing customer A's orders to customer B), and it is unspecified in both.

3. **The Settings switchboard has no enforcement layer.** Verified: `page.meta.visible` hides nav only; the URL and the API stay reachable; ACL grants persist. A tenant that "disables" campaigns still has `/api/*/campaigns` answering and every granted feature intact. Both packages promise the screen; neither specifies route-level or ACL-level enforcement, and B explicitly flags it as unimplementable-as-costed without fixing it.

4. **Attachment handling is absent from both.** A's FR-014 offers "attaching a file" and its edge case names "messages carrying multiple attachments"; B's composer takes `attachments[]`. Neither touches the `attachments` module, size limits, virus scanning, retention, or what happens when a provider rejects an attachment after the message body succeeded. The prototype shows attachments; both specs treat them as a field.

5. **Working-hours arithmetic has no home.** A's R-03 puts working-hours maths inside `computeSlaState` without saying where the calendar comes from. B reinstates `connect_business_calendar` but round 3 correctly notes it *"restored the storage shape and not the maths"* — `businessMillisBetween` / `addBusinessMillis` do not exist repo-wide (verified) and are specified nowhere. Every SLA number in either package depends on functions that do not exist.

6. **`packages/contact-center` / `packages/connect*` entities fall outside `optimistic-lock-editable-entities.test.ts`** (verified `packages/core`-curated). B adds the curated-map line items; A does not. Either way, the fix is a hand-maintained allowlist entry that a future module will forget — the gate itself should be widened, and neither package proposes that.

7. **Neither package has an independent human sign-off.** A's ANALYSIS-053 asks for one explicitly. B's OQ-9 was "resolved" by review rounds whose independence I cannot verify from the artifacts — round 1 claims three independent agents while `challenger-review.md:10` records a session constraint forbidding subagents. The review *content* is demonstrably good (§3.2), so this does not invalidate it, but the provenance is unestablished and should not be treated as an independent gate on a package that carries a Critical.

---

## Appendix — verification commands

All checks were run locally (not via `scripts/docker-exec.mjs`) from `.ai/cezar/worktrees/a5fd2e52-6792-406f-9aa8-d87e5a56d198`. Key reproductions:

```bash
grep -nE "^### [0-9]+\." BACKWARD_COMPATIBILITY.md                      # 14 surfaces, not 13
test -f packages/core/src/modules/messages/di.ts                        # absent
grep -n "realtimePush" packages/core/src/modules/communication_channels/lib/adapter.ts   # :50
grep -n "channelId" packages/core/src/modules/communication_channels/lib/thread-matcher.ts  # every strategy
grep -n "messageThreadId" packages/core/src/modules/communication_channels/commands/ingest-inbound-message.ts  # :402
sed -n '95,105p' packages/core/src/modules/communication_channels/lib/send-as-user.ts     # ownership 403
grep -n "senderUserId" packages/core/src/modules/messages/data/entities.ts                # NOT NULL
sed -n '125,140p' packages/core/src/modules/planner/lib/availabilityMerge.ts              # 7 * DAY_MS
grep -c "timezone" packages/core/src/modules/planner/lib/availabilityMerge.ts             # 0
grep -n "join(__dirname" packages/core/src/__tests__/optimistic-lock-editable-entities.test.ts  # core-only
sed -n '20,30p' packages/core/src/modules/sales/extension-points.ts                       # spot regex
node scripts/check-agents-md-budget.mjs                                                    # 31635 / 31232
```

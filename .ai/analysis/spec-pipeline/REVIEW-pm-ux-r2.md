# REVIEW — PM / UX reviewer, round 2

**Target.** [`.ai/specs/2026-08-22-connect-phase-1-v2.md`](../../specs/2026-08-22-connect-phase-1-v2.md)
(v2, rewrite-whole successor to the frozen `2026-08-21-connect-phase-1-merged.md`).

**Round-1 file.** [`REVIEW-pm-ux.md`](REVIEW-pm-ux.md) — 4C / 13M / 7m. Verified below one row per
finding. No other reviewer's file was read.

**Lens, unchanged.** Product and user journey. The committed prototype
(`.ai/specs/app-spec-notes/design-source/mercato-connect.dc.html`) is read as data, not as a picture.

**External facts checked this round (not taken from the spec).**
`scripts/i18n-check-sync.ts:25` does list `['pl','es','de','ko']` (FR-023's citation is accurate);
`:165` shows `--fix` fills a missing key with `enFlat[key]`, i.e. English;
`package.json:86` exposes a separate `i18n:check-values` that v2's Definition of done omits.
`app-spec-notes/frozen-surfaces.md` confirms the six ACL IDs and ten event IDs v2 cites.

---

## 1. Regression table — round-1 findings against v2

| # | Round-1 finding (short) | Verdict | Reason, at v2's text |
|---|---|---|---|
| **C1** | FR-003's arrow chain forbids the happy path; `escalated` unreachable | **RESOLVED** | § Status machine (`:204-214`) is an explicit from/to/trigger table including `in_progress → resolved`, `waiting_customer → in_progress` and `resolved → in_progress`; `escalated` + `escalation_reason` dropped in § Scope (`:55-58`); T-TEST-15 asserts legal and illegal transitions. Residual: no `→ closed` edge except from `resolved`, so discarding junk still costs a wrap-up note (see M9 below). |
| **C2** | Reply to a resolved Case orphans; FR-005's "no inbound" unmeasurable | **PARTIAL** | § Attach rule condition 3 (`:192-193`) and § Status machine `resolved → in_progress` fix it **for a linked identity**; FR-005 now measures on `connect_conversation.last_inbound_at` (`:96-98`); T-TEST-16 covers it. But condition 1 (`:189-190`) — "an **unresolved identity never attaches** and always opens its own Case" — re-creates the orphan for exactly the population sitting in the manual-match queue. See fresh **F-C1** context and **F-M1**. |
| **C3** | Manual-match task is a phrase: no table, route, screen, owner, test | **PARTIAL** | `connect_manual_match_tasks` (`:348-349`), `/api/connect/manual-match-tasks` (`:391`), `/backend/connect/manual-match` (`:427`), FR-014/FR-026, T-UI-10/T-API-10 all exist. Still no owner/persona (the word "persona" does not occur), **no notification, no queue badge, no T-TEST row, no U-row**, and `dismissed` has no rule. See fresh **F-M1**. |
| **C4** | ROI case is self-referential; no success criteria | **PARTIAL** | The **withdrawal is complete and honest**: § Success criteria (`:63-69`) states the arithmetic (6.20+1.10=7.30 etc.), says "**The ROI claim is withdrawn**", and no "48 500 PLN", "1.2–1.8 FTE" or prototype KPI survives anywhere in the document (grep-verified). The **replacement is not sound**: three of the five SCs cannot be evaluated from their own stated source and one requires reading a table § Reading peer data forbids — fresh **F-C3**. C4's fix item (4) also asked for a Problem Statement; v2 still has none, and no Final Compliance Report, against `.ai/specs/AGENTS.md` § Spec Content Checklist. |
| **M1** | Auto-acknowledgement assumed by R1 and T-TEST-03, specified nowhere | **PARTIAL** | FR-025 (`:121-123`), T-ING-05 (`:509`), `auto_ack_enabled` (`:355`) and § Scope "In" (`:45`) now exist. Content, timing, channel, default and the interaction with `first_human_outbound_at` / the status machine are still unspecified, and only the *negative* test (T-TEST-03) exists. Fresh **F-M2**. |
| **M2** | No surface for an agent to create a Case | **UNRESOLVED** | `POST /api/connect/cases` is still folded into the CRUD row (`:382`); no FR covers manual creation; § UI's `/cases` is still "(DataTable + CSV)" with no create dialog task; § Scope does not declare Phase 1 inbound-only. FR-002 additionally requires an "originating channel" a manual Case cannot supply. |
| **M3** | Transfer: no UI, no target picker, no notification | **PARTIAL** | T-API-03 (`:520`) gained the clause "notifies the receiving agent". That is the whole specification: the string `notif` occurs **once in the entire document**, in a task line. Fresh **F-M4**. No transfer dialog task, no user-list route, no reason field. |
| **M4** | Empty states deleted; U6 unsatisfiable | **PARTIAL** | § UI (`:432-433`) now asserts "Every screen defines empty, loading, error and permission-degraded states" — a promise with no table behind it; not one state is actually defined. U6 is unchanged and still unsatisfiable: the correct empty-Inbox state ("Kolejka pusta. Dobra robota.") has no CTA by design. |
| **M5** | Counting layer: no reader, no screen, no definition, no test | **PARTIAL** | `connect_metric_daily` (`:351-353`), `/backend/connect/metrics` + T-UI-09, FR-019's "**and a screen that reads it**" now exist. `duplicate_reply_candidates` is still undefined; there is still **no T-TEST row for FR-019**; the reader is still `connect.cases.view.all` (now an admitted overload, `:412-413`). Fresh **F-M7**. |
| **M6** | Confidence computation and thresholds undefined | **PARTIAL** | `confidence` is now typed (integer 0–100, `:338`), `match_method` is stored and required by FR-013, thresholds are named as `connect_tenant_settings` columns (`:355`). **How confidence is computed is still not stated**, no default threshold values are given, and § UI still renders the number to the agent (`:424-425`) on an undefined scale. |
| **M7** | The customer-context rail — the headline value prop — has no FR and no test | **UNRESOLVED** | FR-001…FR-027 contain no rail requirement. § UI is still one sentence: "Right: customer card, order context, contact-identity panel with confidence and link/verify" (`:424-425`). No field list, no zero-order rendering, no unresolved-identity rendering. U1 is still "login → inbox → reply"; T-TEST-08 still counts queries only. R5 (`:454`) names the enricher that would *fetch* it, which is a mechanism without a requirement. |
| **M8** | Two competing Customer-360 surfaces | **RESOLVED (with a new gap)** | `/backend/connect/customers/[id]` is dropped; Customer 360 ships as injection widgets into the `customers` detail page (`:428-430`), consistent with FR-017. The de-duplication is correct. What the widgets *contain*, and where "Karta klienta" from the Inbox now goes, are still unstated — fresh **F-M5**. |
| **M9** | Wrap-up: interaction unspecified, `wrap_up_seconds` has no writer, gate inherited from an AI drafter | **UNRESOLVED** | FR-004 is verbatim unchanged (`:95`); T-API-04 is "wrap-up gate". No interaction, no minimum length, no statement that the note becomes the `CustomerInteraction` body. `wrap_up_seconds` (`:317`) still has no start event, no writer task and no consumer — and SC-005 now promises "handle time" that no column holds (**F-C3**). The AI dependency is still not called out as a decision. |
| **M10** | Auto-close silent, indistinguishable from a human close, no undo surface | **PARTIAL** | `connect_case_transitions` (`:333-334`, actor + reason + payload) makes auto-close **distinguishable in the data** — a better answer than the `close_reason` column I proposed, and FR-003's "record actor" now has somewhere to write. Not fixed: nobody is told (no notification, no `clientBroadcast`), no list/detail rule shows which, and `close` remains an undoable command whose worker-actor invocation has no surface. |
| **M11** | Inbox has no update mechanism | **RESOLVED** | § Inbox freshness (`:256-259`): poll-on-focus plus a 30 s interval on the list and open Case, `updatedAt` driving the conflict bar, T-UI-11, deferral of `clientBroadcast` stated as a decision. The collision-*reduction* half (show assignee / `last_agent_touch_at`, warn on a recently touched Case) was not taken; U7 still tests the collision as the expected experience. |
| **M12** | `ZG-` hard-coded into a FROZEN column | **RESOLVED** | `case_number` is `<prefix>-<seq>` with `case_number_prefix` in `connect_tenant_settings` (`:311-312`, `:354`). Defaults, validation and the mid-life change rule are missing — fresh **F-m1**. |
| **M13** | Traceability regressed 100 FRs → 23, no mapping | **PARTIAL** | 27 FRs and five SCs now; every FR names a task, every test scenario names a file path (`:557-558`). Still **no FR-mapping appendix**, no user stories, no edge-case table, no Problem Statement — so U1…U8 and the screens still have no requirement to trace to, which is how **F-M3**, **F-M5**, **F-M6** and **F-m2** below stayed invisible. |
| **m1** | U4 tests inline status advance that § UI no longer describes | **PARTIAL** | U4 is restated as "list filter + **status via action route**" (`:579`), consistent with FR-024. § UI's `/cases` still describes no status affordance at all, so the test still has no requirement. |
| **m2** | Permission-degraded states undefined | **PARTIAL** | Named in the § UI promise sentence (`:432`); no capability→rendering table exists. FR-021's 404 rendering is still undefined at the page level. |
| **m3** | Channel chips + "badge cluster" for a two-channel phase | **UNRESOLVED** | § UI `:421-422` carries "channel filter chips" and "channel-badge cluster" verbatim from the nine-channel prototype, while § Scope (`:60-61`) ships two channel types. |
| **m4** | `priority` has no setter, semantics or consumer | **UNRESOLVED** | FR-002 still requires it (`:91`), the column still exists (`:313`), and it is *not* in FR-024's excluded set — so the generic CRUD `PUT` is its de-facto setter by omission rather than by decision. No meaning, no default sort, no filter. |
| **m5** | `connect_tenant_settings` columns never enumerated | **PARTIAL** | Six columns are now named (`:353-355`). No types, no defaults (except the attach floor of 60), no validation ranges, and no statement of which are exposed on `/settings` — see **F-m2**. |
| **m6** | "Both scored ~37" misquotes the cited scorecard | **RESOLVED (moot)** | v2 has no Provenance section and makes no scorecard claim. |
| **m7** | Prototype's channel pie does not reconcile | **RESOLVED (moot)** | No prototype figure is cited as a measurement anywhere in v2; the ROI withdrawal removed the only consumer. |

**Regression tally: 6 RESOLVED · 12 PARTIAL · 6 UNRESOLVED.**

---

## 2. Fresh findings on what is new in v2

### Critical

#### F-C1 — A front-line agent's Inbox is empty by construction: no route can assign a Case, and FR-024 contradicts § Frozen surfaces about whether one exists

**Location.** FR-024 (`:103-104`); § API contracts (`:382`, `:396`); § Frozen surfaces (`:415-417`);
`api/interceptors.ts` narrowing (`:404-406`); FR-002 (`:90-91`); FR-022 (`:160-162`); T-API-01 (`:496`).

**Defect.** Three of v2's own statements cannot all be true:

1. FR-024: the CRUD route "MUST NOT be able to change `status`, `resolved_at`, `closed_at` or
   **`assignee_user_id`**"; T-API-01 repeats it as an implementation instruction.
2. § Frozen surfaces: "`connect.case.assigned` is emitted by T-API-03 (transfer) **and by assignment
   on the CRUD route**" — the writer FR-024 just forbade.
3. The only other route that touches ownership is `POST /cases/{id}/transfer`.

So in the shipped Phase 1 there is **no assign action and no self-claim**. Now compose that with
FR-022 and the interceptor: without `connect.cases.view.all`, listing is narrowed by injecting an
`assignee_user_id` filter. Inbound Cases are created unassigned (FR-002 explicitly allows "an
explicit unassigned state"; no rule auto-assigns). An `assignee_user_id = me` filter does not match
NULL.

**Journey.** The front-line agent — `connect.inbox.view` + `connect.inbox.handle`, no `.view.all`,
the persona the whole phase exists for — logs in and sees **zero Cases**, permanently, because every
Case that could be theirs is unassigned and nothing they can do makes it theirs. The only escape is
another user who *does* hold `.view.all` transferring each Case individually. Work cannot enter the
desk. U1 ("login → inbox → reply") passes only if the test fixture holds `.view.all`, which is not
the persona the requirement describes.

**Fix.** (a) Decide and state whether the Inbox default view is "mine" or "mine + unassigned", and
make the interceptor's narrowing `assignee_user_id = me OR assignee_user_id IS NULL`. (b) Add a
`POST /api/connect/cases/{id}/assign` action route (feature `connect.inbox.handle`, self-assign
allowed, emits `connect.case.assigned`, writes a transition row), give it an FR and a task, and
delete "and by assignment on the CRUD route" from § Frozen surfaces so FR-024 is not contradicted.
(c) Add an "Unassigned" filter chip to the left pane and a U-row asserting an agent without
`.view.all` can find, claim and answer a new Case.

#### F-C2 — Async send has no retry route, no failure notification, no failed counter and no queue timeout: an agent can believe they answered while the customer receives nothing

**Location.** FR-010 (`:114-115`), FR-011 (`:116-118`); § UI composer (`:422-424`); § Consistency
"Send" and "Delivery reconcile" (`:469-470`); `connect_messages` (`:329-331`); T-API-07 (`:524`),
T-WRK-02 (`:531`), T-TEST-04 (`:564`); `connect_metric_daily` (`:351-353`).

**Defect.** v2 correctly makes send asynchronous, and correctly says a `failed` send must not stamp
`first_human_outbound_at` or advance the Case. The agent-facing half of that journey is not designed:

- **No retry endpoint.** § UI says "failed ones a retry" and `connect_messages` carries
  `retry_count`, which implies an in-place retry. The API table has exactly one message route,
  `POST /cases/{id}/messages` (guard op `create`). Nothing mutates `retry_count`; nothing re-enqueues
  a `connect_message`. The affordance has no contract, so an implementer will either re-POST (a
  second `connect_message` row, a second provider attempt, `retry_count` dead) or ship a disabled
  button.
- **No discovery outside the open Case.** Failure "surfaces on the message" — i.e. in the thread of
  that one Case. § Inbox freshness polls only the list and the *open* Case. There is no
  notification, no per-row failure indicator specified for the list, and a `failed` send leaves the
  Case in `in_progress` (FR-011), which is byte-identical in the list to a Case nobody has answered
  yet. The agent types a reply, sees it accepted (202), closes the tab, and never learns.
- **No timeout, no dead letter.** `delivery_status` is `queued|sent|failed` with no rule for how long
  `queued` may persist, no dead-letter transition, and no worker that ages queued rows. If the
  reconcile worker never hears from the hub, the message stays `queued` forever and displays as
  "pending" indefinitely.
- **Nothing counts it.** `connect_metric_daily` has `outbound_count` but no `outbound_failed`. So
  the counting layer — the phase's one deliverable per SC-005 — cannot report the failure mode that
  most directly destroys the product's promise, and no SC covers outbound delivery at all.
- **No test of the agent path.** T-TEST-04 asserts the server-side effects of `sent` and `failed`;
  no U-row exercises retry.

**Journey.** "I answered that customer" is the one claim a service desk must never be wrong about.
As specified, Phase 1 can be wrong about it silently, and the operator's dashboard will not show it.

**Fix.** Add `POST /api/connect/cases/{id}/messages/{messageId}/retry` (feature
`connect.inbox.handle`, increments `retry_count`, re-enqueues, bounded by a stated max). Add an FR:
a `failed` send MUST raise an in-app notification to the sending agent and MUST mark the Case row in
the list until acknowledged. Add `queued_timeout_minutes` with a `failed` transition and a stated
`failure_reason`. Add `outbound_failed` to `connect_metric_daily` and a sixth SC ("≥ 99.x % of
accepted sends reach `sent`, and 100 % of `failed` sends are surfaced to their author"). Add a
U-row: send → force failure → agent sees it and retries successfully.

#### F-C3 — SC-001…SC-005 replace an unmeasurable ROI claim with criteria that are, in three cases, unmeasurable from the source they name — and one of them requires reading a table the spec forbids `connect` to read

**Location.** § Success criteria (`:71-80`); § Reading peer data (`:224`); § Consistency "Resolve"
(`:468`); FR-018 (`:144-147`); FR-019 (`:148-150`); `connect_metric_daily` (`:351-353`).

The withdrawal itself is clean and I credit it — the arithmetic is stated, the claim is retracted,
and no prototype figure survives. The replacement is where the honesty has to hold, and it does not:

| SC | Stated measurement | Defect |
|---|---|---|
| SC-001 | "`connect_metric_daily.cases_opened` **vs `ExternalMessage` count**" | `ExternalMessage` is a `communication_channels` entity. § Reading peer data forbids `connect` from querying that module's tables in any form. Either the criterion has no instrument in the product, or it violates the containment rule the spec spends a section establishing. Worse, the comparison is not an identity even by hand: an inbound may open a Case, attach to one, or be suppressed, and `connect_metric_daily` has **no `attached` counter**, so the three terms cannot be reconciled against the fourth. "100 %" is not evaluable. |
| SC-002 | "`connect_metric_daily.suppressed_inbound`" | The criterion is "no `(channel, sender)` pair opens more than **`N`** Cases per window". `N` is never given; the window is never given; and `suppressed_inbound` is a **count of suppressions**, not a per-pair count of Cases opened. A day on which one loop opened 40 Cases and a day on which suppression worked perfectly can produce the same number. |
| SC-003 | "T-TEST-05, T-TEST-06" | This is a build gate, not an operational criterion. Two green tests are the entry condition for shipping, not evidence of "zero disclosures" in production. Either state it as a release gate (fine, and it already is one in § Definition of done) or give it a production instrument. |
| SC-004 | "`connect_pending_projections` **drain lag**" | The subject is "every resolved Case **with a linked identity**". Per FR-018 and § Consistency, a linked-identity resolve projects **directly**; only an *unresolved* identity stages a row in `connect_pending_projections`. The named source therefore measures the exact complement of the stated population, and the population the SC is about leaves no trace to measure. |
| SC-005 | "the counting layer itself" | The baseline is defined as "volume, inbound/outbound split, **and handle time**". `connect_metric_daily` ships `cases_opened/resolved/reopened`, `inbound_count`, `outbound_count`, `suppressed_inbound`, `duplicate_reply_candidates` — **no handle-time column**. `wrap_up_seconds` exists on the Case with no writer (round-1 M9, still UNRESOLVED) and no aggregation. A third of the promised baseline has no storage. |

SC-005's framing — "Phase 1 **produces** the baseline; it cannot also **be** measured against one
that does not yet exist" — is the right instinct and I want it kept. But it only works if the
counting layer actually holds the three quantities named, and if the four criteria around it are
things a person can compute on day 31.

**Fix.** (1) SC-001: define the reconciliation identity explicitly
(`inbound_count = cases_opened + attached_to_existing + suppressed_inbound`), add the missing
`attached_to_existing` column, and drop the `ExternalMessage` comparison or name the human/ops query
that performs it outside `connect`. (2) SC-002: state `N` and the window, and count the thing —
`max_cases_per_channel_sender_per_day`. (3) SC-003: move to § Definition of done and replace with an
operational criterion, e.g. "zero 200-responses to a cross-tenant id in the access log". (4) SC-004:
measure `resolved_at → CustomerInteraction.created_at` for linked identities and use
`connect_pending_projections` drain lag as a *separate* criterion for the unresolved path. (5)
SC-005: add handle-time storage (`first_agent_touch_at → resolved_at` aggregate, plus a defined
writer for `wrap_up_seconds`) or delete "handle time" from the promise.

### Major

#### F-M1 — The manual-match queue exists but nothing routes a human to it; a task can be created and never seen, and R2's Critical mitigation depends on someone seeing it

**Location.** FR-014 (`:129-130`), FR-015 (`:131-133`), FR-026 (`:137-138`); `connect_manual_match_tasks`
(`:348-349`); `/backend/connect/manual-match` (`:427`), T-UI-10 (`:541`), T-API-10 (`:543`);
R2 (`:451`); § Attach rule condition 1 (`:189-190`); FR-018 (`:144-147`); the test tables (`:559-581`).

C3 is repaired at the artefact level. The journey is not:

- **Nobody is notified.** No notification, no nav badge, no count, no daily digest, no assignment.
  `/manual-match` is a URL an agent must decide to visit. Nothing in the Inbox — where the agent
  actually is — links to it or says "this Case's sender went to the queue".
- **No owner.** No persona is named anywhere in v2 (grep: "persona" absent). The route is gated on
  `connect.inbox.handle` while `/unlink` needs `connect.identities.manage` — two capability levels
  on one workflow, unchanged from round 1.
- **No ageing, no ordering.** `candidate_customer_ids` is stored; nothing states the queue's sort,
  a staleness threshold, or what an unworked 30-day-old task does.
- **`dismissed` has no rule.** The state exists in the column; no FR says who may dismiss, what it
  means for the identity, or whether a later inbound from the same handle re-opens the task
  (FR-015 says unlink re-opens one; dismissal says nothing).
- **No test, no U-row.** T-TEST-01…16 contain no manual-match scenario — FR-014's task write and
  FR-026's "resolving it MUST link the identity and drain any staged projection" are both untested,
  and U3 is "link from the **rail**", not from the queue.

**Compounded consequence, and this is the sharp part.** Because § Attach rule condition 1 makes an
unresolved identity never attach, every message from an unidentified sender opens a **new Case**
unless it lands in the same `ExternalConversation`. And because FR-018 stages the projection, every
Case they open resolves into a pending projection nobody drains. So an unworked queue silently
produces: fragmented Cases, an empty right rail (no FR defines the unresolved rendering — round-1
M7), and a growing staged-projection backlog that SC-004 will read as drain lag. R2 is rated
**Critical** and its mitigation column now reads "manual-match queue is a real surface". A surface
with no notification, no owner and no test is real in the schema and absent from the day.

**Fix.** Add an FR: creating a manual-match task MUST raise an in-app notification to holders of
`connect.identities.manage` (or write a count the Connect nav renders as a badge), and the Inbox
right rail MUST link to the task for the current Case when `link_state='unresolved'`. Name the
owning persona and align the link/resolve/unlink features on it. Define `dismissed` and the
re-open-on-new-inbound rule. Add T-TEST-17 (sub-threshold → task created → resolve → identity linked
→ staged projection drained) and a U-row for the queue screen. Also state the § Attach rule
precedence: does the `ExternalConversation` unique key (R7) attach *before* the identity rule is
consulted? As written the two mechanisms are stated independently and an implementer must guess.

#### F-M2 — The auto-acknowledgement is one sentence: no content, no default, no channel rule, and its interaction with the delivery model can drive an illegal status transition

**Location.** FR-025 (`:121-123`), T-ING-05 (`:509`); `auto_ack_enabled` (`:355`); FR-011 (`:116-118`);
§ Status machine (`:204-214`); § Consistency (`:465-471`); T-TEST-03 (`:563`); T-I18N-01 (`:502`).

FR-025 is a real requirement now, which closes round-1 M1's worst form. What the customer receives is
still undefined, and one integration is actively unsafe:

- **Content.** Nothing states that the ack carries the case number — the identifier v2 spends a
  FROZEN column, a sequence allocator and a tenant-configurable prefix on. Nothing states whether it
  gives an expected response time, a reply-to that threads back into the same Conversation, or an
  unsubscribe. With no portal, the ack is the **only** artefact the customer ever receives from
  Connect; it is specified in twelve words.
- **Default.** `auto_ack_enabled` has no stated default. Defaulting ON means every tenant that
  installs Connect starts auto-mailing its customers on day one without configuring the text;
  defaulting OFF means FR-025 ships dead and SC-002/R1's "never sent to a suppressed sender"
  protects nothing.
- **Channel.** "to the customer" — on the originating channel? A `channel-webform` submission may
  carry no reply address at all (the intake schema is not specified in T-CH-01). No rule covers the
  no-address case.
- **Editability.** `/backend/connect/settings` exposes a boolean; no template, no per-locale body,
  no preview. T-I18N-01 lists no ack keys, so the customer-facing text has no home in the five-locale
  contract and will be hard-coded by whoever writes T-ING-05.
- **Status collision.** FR-011 says a `sent` outbound stamps `first_human_outbound_at` and advances
  the Case to `waiting_customer`. If the ack travels the same `connect_message` + reconcile path
  (T-ING-05 is a separate lib, but § Consistency has **no boundary row for the ack**, so this is
  undecided), then a brand-new Case would (a) be stamped with a "human" first-outbound it never had,
  corrupting the handle-time baseline SC-005 promises, and (b) attempt `new → waiting_customer`,
  which is **not a legal transition** in § Status machine — so the ack would either throw or the
  machine would need an edge nobody has declared.
- **No positive test.** T-TEST-03 asserts an ack is *not* sent for auto-responders. No scenario
  asserts one *is* sent, exactly once, for a first inbound.

**Fix.** Add the ack's content contract (case number, channel, reply-threading, i18n key list) to
§ UI or a short § Customer-facing messages; state the default for `auto_ack_enabled` and justify it;
state the no-reply-address behaviour; add a § Consistency row for the ack; state explicitly that an
automated outbound MUST NOT stamp `first_human_outbound_at` and MUST NOT change status (or add the
edge); and extend T-TEST-01 to assert exactly one ack.

#### F-M3 — Reopen is silent and ownerless: nobody is told, the Case returns to a possibly-absent agent's private queue, and it is invisible in the list

**Location.** FR-006 (`:99-100`), § Status machine `resolved → in_progress` and the reopen paragraph
(`:212`, `:216-217`); T-TEST-16 (`:576`); FR-022 + interceptor (`:160-162`, `:404-406`);
T-EVT-01 "No `clientBroadcast` in Phase 1" (`:495`); § Inbox freshness (`:256-259`).

The mechanic is correct and tested. The journey around it is not specified at all:

- **Ownership.** No rule says what happens to `assignee_user_id` on reopen. By default it keeps the
  original agent. Combined with F-C1's narrowing, a reopened Case is then visible **only** to that
  one agent — who may be on holiday, off shift or gone. Nothing ages it, nothing un-assigns it,
  nothing offers it to anyone else. The customer's "it's still broken" lands in a private queue.
- **Notification.** `connect.case.reopened` is emitted, has no `clientBroadcast`, and no notification
  is specified. The agent learns on their next 30 s poll **if** they are looking at the list.
- **Invisibility.** A reopened Case becomes `in_progress`, indistinguishable in the list from any
  other in-progress Case. `reopen_count` exists in the data; no § UI rule renders it, no filter
  chip selects reopened Cases, and no sort surfaces them first — although a reopen is the single
  strongest signal that a customer was failed.
- **The wrap-up is buried.** § Status machine says reopen "preserves `wrap_up_note` as a
  `connect_case_transition` payload" — good for audit, but nothing states that the agent picking the
  Case back up **sees** what was said last time, which is the entire point of not orphaning it.

**Fix.** State the reopen ownership rule (recommend: keep the assignee, but make reopened Cases
visible to all `connect.inbox.view` holders regardless of `.view.all`, or auto-unassign after
`reopen_reassign_hours`). Add an FR requiring an in-app notification to the previous assignee on
reopen. Add a "Reopened" filter chip plus a row badge driven by `reopen_count`, and require the Case
detail to render the preserved wrap-up note at the reopen boundary. Add a U-row.

#### F-M4 — "notifies the receiving agent" is five words in a task line: no FR, no notification ID, no channel, no content, no BC surface entry, no test

**Location.** T-API-03 (`:520`); § Frozen surfaces (`:410-417`); § Migration & backward compatibility
(`:589-594`); FR-002 (`:90-91`); the test tables (`:559-581`); § UI (`:419-444`).

v2 answers round-1 M3's notification gap with a clause inside a file-path task line — the only
occurrence of `notif` in the document. Everything a notification needs is absent:

- **No FR.** Transfer notification is not required by any FR, so FR traceability does not cover it
  and an implementer under time pressure drops it as task colour.
- **No ID, and it is a frozen surface.** `BACKWARD_COMPATIBILITY.md` classifies notification IDs as
  a contract surface (#11). v2's Migration section enumerates additive surfaces 1, 5, 6, 7, 8, 9, 10
  and 14 — **notification IDs are not listed**, so this notification would ship an unfrozen,
  undeclared ID into a FROZEN category. `app-spec-notes/frozen-surfaces.md` likewise freezes the ten
  `connect.*` events and the six ACL IDs, and lists no notification IDs.
- **No channel or content.** In-app bell, e-mail, both? Does it carry the case number, the
  transferring agent, the reason? There is no reason field — round-1 M3 noted package B's
  `{ assigneeUserId, reason }` body was dropped, and v2 does not restore it.
- **No target picker.** No route in § API contracts returns a list of assignable users, and no UI
  task builds a transfer dialog. T-UI-01…12 has no transfer control.
- **No test.** T-TEST-13 asserts transfer's *undo*. Nothing asserts the receiving agent is notified.

Combined with F-C1 (transfer is currently the **only** way a Case gets an owner) this is not a
peripheral action — it is the load-bearing assignment mechanism of the phase.

**Fix.** Add an FR ("transfer and assignment MUST raise an in-app notification to the new assignee,
carrying case number, subject and the transferring agent"), declare the notification ID(s) in
`frozen-surfaces.md` and add surface 11 to § Migration, restore the `reason` field, add a transfer
dialog task with a stated source for the assignee list (a scoped user endpoint, which no peer-read
facade currently covers), and add a T-TEST row plus a U-row.

#### F-M5 — Customer 360 became four injection spots with no content spec, no navigation path from the Inbox, and an orphaned U5

**Location.** § UI (`:427-430`), T-WID-01 (`:546`), U5 (`:579`), upstream PR B (`:272`);
FR-017 (`:142-143`); FR-001…FR-027 (no Customer-360 requirement).

Dropping `/backend/connect/customers/[id]` is the right call and resolves M8. What replaced it is
thinner than what was removed:

- **No content.** "four new detail injection spots plus one declaration" (PR B) and "Customer 360
  injection widgets" (T-WID-01) — the spots are not named, their contents are not listed, and no FR
  requires any of them. The frozen spec at least inherited package B's "header KPIs and four tabs".
  A reviewer cannot tell whether the widget shows case history, open cases, last contact, or a link.
- **U5 is orphaned.** "U5 Customer 360 tabs" is carried forward verbatim from a document where a
  tabbed Connect screen existed. There are no tabs any more. The test names a UI that v2 deleted.
- **No navigation.** The Inbox centre-pane header in the source package had a "Karta klienta"
  action. § UI's centre pane is now "header, thread rendering, composer" — the action is gone and no
  destination is stated. The agent's path from a conversation to the customer's history is
  unspecified.
- **The value proposition still sits in the rail, and the rail still has no FR** (round-1 M7,
  UNRESOLVED). So the "customer context" promise in the TLDR is now carried by two surfaces, neither
  of which has a requirement: an Inbox rail described in one sentence and four unnamed injection
  spots.

**Fix.** Name the four spots and their contents (recommend: open-cases count, last-contact
timestamp, recent-cases list, identity/link panel), add an FR for each surface, restate U5 against
the real widgets, and specify the Inbox → customer navigation (which page, which target, what an
agent without `customers` read features sees).

#### F-M6 — Suppressed inbound is invisible to every human: a false-positive auto-responder match silently deletes a real customer's e-mail

**Location.** FR-012 (`:119-120`), T-ING-02 (`:506`), R1 (`:450`); `connect_metric_daily.suppressed_inbound`
(`:351-353`); § UI (`:419-444`); SC-002 (`:74`); T-TEST-03/T-TEST-14 (`:563`, `:574`).

FR-012 requires suppressed traffic to "MUST NOT open a Case, MUST NOT be acknowledged, and MUST be
counted". Counting is a daily integer. There is:

- no screen that lists what was suppressed (§ UI's six surfaces contain no suppression view);
- no per-message record — `connect_messages` holds outbound only, and no table stores a suppressed
  inbound;
- no review or release path — nothing lets a human say "that was not an auto-responder, open a
  Case";
- no customer-facing consequence stated: a suppressed message is also not acknowledged (FR-025), so
  the customer gets total silence.

R1's mitigation is a `(channel_id, from_handle_hash)` **window** in Connect's own limiter — meaning
suppression is not only header-based but rate-based. A genuinely busy customer sending three
messages in quick succession, or a shared address (`biuro@`, `zamowienia@`) used by several people,
can trip a window rule. The `Auto-Submitted`/`Precedence` header check is likewise not
false-positive-free: plenty of legitimate ticketing and CRM senders set `Precedence: bulk`.

**Journey.** The failure is invisible, silent to the customer, and irreversible. A shared mailbox at
least kept the message. Phase 1 is the first system in the chain that can lose a customer contact
with no trace beyond `suppressed_inbound += 1`.

**Fix.** Store suppressed inbounds (handle hash, channel, reason, `external_message_id`, timestamp)
with a retention window, add a read-only "Suppressed" view (on `/metrics` or `/settings`, feature
`connect.cases.view.all`) listing them with the reason, and add a "create Case from this" action for
a false positive. State the window rule's parameters in `connect_tenant_settings` so an operator can
loosen it. Add a T-TEST row asserting a suppressed inbound is recorded and releasable.

#### F-M7 — `/backend/connect/metrics` is a URL with no audience, no content, no ACL, no empty state and no test; and it is the phase's only deliverable per SC-005

**Location.** FR-019 (`:148-150`), T-UI-09 (`:540`), T-API-15 (`:545`), `/metrics` (`:427`);
§ Frozen surfaces ACL overload (`:412-413`); `connect_metric_daily` (`:351-353`); SC-005 (`:77`);
the test tables (`:559-581`).

FR-019's "**and a screen that reads it**" answers round-1 M5's "no reader". The screen is then
specified as a single path in a comma-separated list and a one-line task. Missing:

- **Audience.** No persona. The page's own ACL is not stated (only the API's, which reuses
  `connect.cases.view.all` — an admitted overload, so every agent who can see all Cases can read
  the operator's baseline). The people who need it — an operations lead, a support manager — are
  not modelled anywhere in v2.
- **Content.** Which of the eight columns render, over what period, as a table or as charts, with
  what comparison. `duplicate_reply_candidates` — the metric that would settle package B's founding
  "~4 % of e-mail volume answered twice" claim — is **still undefined** (round-1 M5, PARTIAL): no
  formula, no window. Two implementers ship two different numbers, and per SC-005 that number *is*
  the deliverable.
- **The first 30 days.** SC-005 says the baseline "exists after 30 days". Nothing states what the
  screen renders on day 3 — a partial trend that will be read as a real one, or a stated
  "insufficient data" state. § UI's blanket promise ("every screen defines empty/loading/error
  states") is a promise, not a state (M4, PARTIAL).
- **No test.** No T-TEST row asserts the counters against a seeded fixture, and no U-row opens the
  screen. FR-019 is the only FR in v2 whose entire verification is absent.

**Fix.** Define each counter with a formula and a window (especially `duplicate_reply_candidates`:
e.g. "≥ 2 outbound messages from distinct `actor_user_id`s on one Conversation within N minutes"),
state the screen's audience, ACL and layout, define the insufficient-data state with a stated
minimum window, and add T-TEST-18 (counters against a seeded fixture, including drift reporting)
plus a U-row.

#### F-M8 — CSV export of case data has no FR, no route, no feature gate — but a security test asserts on it

**Location.** § UI (`:427`) "`/backend/connect/cases` (DataTable + CSV)"; T-UI-06 (`:538`);
T-TEST-05 (`:565`) "invisible to tenant B on **every** route, list, search and **export**";
§ API contracts (`:380-393`); FR-001…FR-027.

The export is named in three places and specified in none. It has no route in the API table, no
feature (does `connect.inbox.view` suffice, or does export need `connect.cases.view.all`?), no
column list, and no statement of whether it includes customer identifiers — which, for a table whose
identity handles are encrypted at rest with a hash index (FR-016) and whose search index deliberately
**excludes** `handle_value` and `contact_handle` (T-SRCH-01), is a live question. An export is the
standard route by which encryption-at-rest is undone in practice.

T-TEST-05 asserts the export enforces tenant isolation, so the test surface exists while the product
surface does not.

**Fix.** Add an FR for the export (columns enumerated, contact handles excluded or explicitly
included with a stated justification, gated on its own feature or on `connect.cases.view.all`,
row-cap stated), add the route to § API contracts, and note the export in § Risks alongside R2 —
exporting is how a cross-customer link becomes a permanent copy.

#### F-M9 — "All five locales ship complete" is mechanically satisfiable in English, and the Definition of done omits the only check that would catch it

**Location.** FR-023 (`:163-164`), T-I18N-01 (`:502`), R9 (`:458`), U8 (`:580-581`),
§ Definition of done (`:604`).

FR-023's citation is accurate — `scripts/i18n-check-sync.ts:25` does require `pl, es, de, ko`
alongside `en`. Two things follow that v2 does not account for:

- **"Complete" means key parity, not translation.** `i18n-check-sync.ts:165` fills a missing key with
  `enFlat[key]` under `--fix`, and `package.json:88` exposes that as `yarn i18n:fix`. The path of
  least resistance under a slice deadline produces five complete files, four of them in English, and
  the checker exits 0.
- **The check that catches it is not in the gate.** `package.json:86` ships
  `i18n:check-values` — root `AGENTS.md` describes it as the non-English coverage check. v2's
  Definition of done runs only `i18n:check-hardcoded`. U8 asserts "all five locales with no
  missing-key placeholders" — an English fill has no placeholder and passes.
- **No source and no owner.** The prototype is Polish-only (R9's own observation). Nobody is named
  as the source of German, Spanish or Korean copy, no machine-translation-then-review policy is
  stated, and the volume is not trivial: six screens, a status machine, an ACL feature set, error
  strings and (per FR-025) customer-facing e-mail copy. R9 rates this **Low** with the mitigation
  "Five locales from day one", which is the claim, not a mitigation.

A Korean-locale user silently receiving an English backoffice is a worse outcome than a documented
two-locale Phase 1, because it looks shipped.

**Fix.** Add `corepack yarn i18n:check-values` to § Definition of done and restate FR-023 as
"complete **and translated** — `i18n:check-values` reports no English fallback in `pl/es/de/ko`".
Name the translation source and the reviewer per locale. Restate U8 to assert a locale-specific
string, not the absence of placeholders. If no source exists, ship `en` + `pl` and add the other
three to the phase that has one — and say so, rather than passing a checker.

### Minor

#### F-m1 — `<prefix>-<seq>` fixes the `ZG-` hard-coding but leaves the prefix undefined, unvalidated and unchangeable-in-practice

**Location.** § Data model `case_number` (`:311-312`), `connect_tenant_settings` (`:353-355`),
T-SEQ-01 (`:492`).

The fix is the right shape and I credit it. Four gaps remain: no **default** is stated (a tenant
that never opens Settings gets what?); no **validation** (round-1 M12 proposed `[A-Z]{2,5}`; nothing
constrains it, so a prefix containing `-` breaks the format's parseability); the prefix is
**per-tenant, not per-locale**, so v2's five-locale tenant still shows one language's abbreviation
to everyone; and there is **no rule for changing it mid-life** — `case_number` is FROZEN and unique
per tenant on the whole string, so after a prefix change old and new Cases carry different formats
and reverting the prefix can collide with an already-issued number. Also unresolved from round 1:
nothing states whether the case number appears in the FR-025 acknowledgement, which is the only
place a customer could ever learn it.

**Fix.** State the default (`CASE` for `en`, or seed from the tenant's locale), add the validation
pattern, forbid changing the prefix once a sequence has been allocated (or make the sequence
prefix-scoped), and state that the number appears in the acknowledgement and the Case header.

#### F-m2 — Three screens have no FR, and § Frozen surfaces' ACL set has no screen-to-feature mapping

**Location.** § UI (`:419-433`); § Requirements; § Frozen surfaces (`:410-413`); T-UI-06/08/12
(`:538`, `:539`, `:542`); T-API-14 (`:544`).

Screens with no requirement behind them: `/backend/connect/cases` (the list — no FR names it, its
filters, its columns or the CSV, see F-M8), `/cases/[id]` (no FR; its relationship to the Inbox
centre pane is unstated — are they the same component or two renderings of one Case?), and
`/backend/connect/settings` (no FR; which of the six `connect_tenant_settings` columns are
tenant-editable, with what validation, is still unstated — round-1 m5, PARTIAL). Conversely FR-012
(suppression, see F-M6) has no screen.

Six ACL IDs are frozen but no table maps feature → screen → rendering, which is the artefact that
would have made round-1 m2 ("permission-degraded states") answerable and would catch F-C1's
narrowing problem mechanically.

**Fix.** Add a short screen table: path | FR | ACL feature | empty state | degraded rendering. It is
six rows and it closes m2, m5, M4's promise and this finding at once.

#### F-m3 — The task list still builds `connect_case_reopen`, a table § Data model replaced

**Location.** T-DATA-02 (`:485`) lists `connect_case_reopen` among the entities to create;
§ Data model (`:301-368`) enumerates eleven tables and `connect_case_reopen` is not among them —
reopen is now carried by `connect_case_transitions` (`:333-334`) plus `reopen_count` on the Case
(`:317`), which is the better design.

An implementer following the task list ships a dead table with a migration and a snapshot entry that
no FR, route, screen or test references. Trivial to fix, but it is the same class of drift that made
round-1 M13 (traceability) worth filing: the task list and the data model were edited independently.

**Fix.** Delete `connect_case_reopen` from T-DATA-02.

---

## 3. What a human still cannot do in Phase 1 as specified

| Journey | Status in v2 |
|---|---|
| Log in as a front-line agent and see any work at all | **Impossible** — no assign route, list narrowed to `assignee_user_id = me`, all inbound unassigned (F-C1) |
| Trust that a sent reply reached the customer | **No** — no retry route, no failure notification, no failed counter, no queue timeout (F-C2) |
| Open a Case for work that did not arrive by e-mail | **No surface** (round-1 M2, UNRESOLVED) |
| Find out that contacts are waiting to be identified | Screen exists; **nothing routes anyone to it, no test** (F-M1) |
| Hand a Case to a colleague and have them know | Claimed in a task clause; **no FR, no ID, no channel, no test, no dialog** (F-M4) |
| Learn that a customer replied to a Case you resolved | **Reopens silently into your private queue** (F-M3) |
| See what the system silently discarded as an auto-responder | **No surface at all** (F-M6) |
| Read the baseline the phase exists to produce | Screen named; **no audience, no content, one metric undefined, no test** (F-M7) |
| Know what the customer received when their mail became a Case | FR exists; **content, default, channel unspecified** (F-M2) |
| Resolve a one-line Case quickly | Still hard-blocked on a free-text note the design assumed AI wrote (round-1 M9, UNRESOLVED) |
| See the customer's orders while replying — the TLDR's promise | **Still no FR and no test** (round-1 M7, UNRESOLVED) |

FINDINGS: 3C/9M/3m

# REVIEW — PM / UX reviewer

**Role.** PM-UX reviewer in the four-role adversarial review of
[`.ai/specs/2026-08-21-connect-phase-1-merged.md`](../../specs/2026-08-21-connect-phase-1-merged.md).
Lens: the product and the user journey — screen/requirement traceability, metric arithmetic,
un-designed states, dead-ending journeys.

**Evidence read.** The merged spec; the two source packages
(`2026-08-21-connect-phase-1-one-inbox.md`, `2026-08-21-app-spec-mercato-connect.md`,
`2026-08-21-mercato-connect-omnichannel.md`); `.ai/specs/analysis/ANALYSIS-054-…`; and the
committed design prototype
`.ai/specs/app-spec-notes/design-source/mercato-connect.dc.html`, read **as data** — its
`CH`, `CONVS`, `TICKETS`, `QUEUES`, `KPIS`, `BARS`, `AGENT_STATS`, `INTENTS`, `CHANNELS_CFG`,
`CAMPAIGNS`, `AI_METRICS`, `MODULES` fixtures were extracted and arithmetically reconciled.
Source packages were treated as fixtures only; none of their platform assertions were relied on.

**Method note.** Findings are stated against the merged spec's own line references. Where the
merged spec *deleted* something that existed in a source package, that is called out explicitly,
because the merge's Provenance table claims to carry those layers forward.

---

## Critical

### C1 — FR-003 states the lifecycle as a linear chain; that chain forbids the happy path and every journey the spec elsewhere requires

**Location.** Merged spec § Requirements → Case lifecycle, FR-003 (line 97); implemented by
T-DOM-01 (line 368).

**Defect.** FR-003 reads, verbatim:

> **FR-003** Status MUST progress `new → in_progress → waiting_customer → escalated → resolved →
> closed`, and every transition MUST record actor and time. → T-DOM-01

T-DOM-01 is `<M>/lib/case-state.ts` — "status machine, **illegal transitions rejected with a
field error**". An implementer given only this spec builds exactly the chain written. That chain:

- forbids `in_progress → resolved` (the ordinary path: agent answers, customer is happy, done) —
  every Case would have to pass through `escalated` to be resolved;
- forbids `waiting_customer → in_progress`, so a Case can never come back when the customer
  replies — the single most common transition in a service desk;
- forbids `new → in_progress` being skipped and forbids `new → resolved` (one-touch answers);
- has no edge for FR-006's reopen at all. FR-006 says a resolved Case "MUST be reopenable in
  place"; the chain has no arrow leaving `resolved` except to `closed`.
- has no edge for FR-011, which says a failed send "MUST NOT advance the Case to
  `waiting_customer`" — implying sends *do* advance to `waiting_customer`, which the chain only
  permits from `in_progress`, so a send from `new` is illegal.

`escalated` is worse than mis-ordered: Phase 1 has no queues, no routing and no notifications
(§ Scope, line 82: "queues are absent entirely, not stubbed"). Escalation has no recipient and no
effect. `escalation_reason` (line 245) is a column nobody writes and nobody reads, and no FR says
who escalates or what changes when they do.

Neither source package states it as a chain — B's phase spec (`:184`) writes it as a plain enum:
`new|in_progress|waiting_customer|escalated|resolved|closed`. The chain arrow is an artefact of
the merge.

**Fix.** Replace FR-003's arrow chain with an explicit transition table (from-state → allowed
to-states → who may perform it), including `waiting_customer → in_progress` (system, on inbound),
`{new,in_progress,waiting_customer,escalated} → resolved`, `resolved → in_progress` (reopen), and
`escalated` as an optional flag-state reachable from and returning to `in_progress`. Either give
`escalated` a Phase-1 consumer (a filter chip in the Cases list plus an assignee notification) or
cut it and `escalation_reason` from Phase 1 and note the deferral.

---

### C2 — A customer replying to a resolved Case dead-ends into an orphan Case, and FR-005's auto-close condition is unmeasurable as written

**Location.** FR-001 (line 93), FR-005 (line 100), FR-006 (line 105), T-ING-04 (line 379),
T-WRK-01 (line 394).

**Defect.** FR-001:

> An inbound message MUST become exactly one Case, or attach to an **open** Case for the same
> identity within `case_attach_window_minutes`.

T-ING-04 floors that window at 60 minutes. So the only inbound routing rule in Phase 1 is:
*attach to an open Case inside the window, else create a new one.* A `resolved` Case is not open.

Consequences:

1. **The journey dead-ends.** The customer answers "it's still broken" to case `ZG-1042` two
   hours after the agent resolved it. Phase 1 opens `ZG-1103` with a fresh number, an empty
   history, no owner and no link to `ZG-1042`. The agent who resolved it is never told. This is
   precisely the failure the product exists to remove — B's own Problem Statement (`:59-66`)
   lists "No history. The customer's previous contacts are in another folder, another inbox, or
   another person's memory." Phase 1 recreates it inside its own database.
2. **FR-006 has no trigger.** Reopen is specified as an explicit API action
   (`POST /cases/{id}/reopen`, line 288) with a `connect.case.reopen` row, but nothing in the
   ingest path ever reopens. The only actor who knows a reopen is needed is the customer, who has
   no surface (portal is out of scope, line 81) — and the agent, who would have to notice the
   orphan Case and manually correlate it.
3. **FR-005's condition cannot be evaluated.** FR-005: `resolved → closed` happens "by the
   auto-close job after `auto_close_after_days` **with no inbound**". Under FR-001 no inbound can
   ever land on a resolved Case, so "no inbound" is vacuously true for every resolved Case, always.
   The two requirements are mutually inconsistent: FR-005 assumes inbound is tracked against
   resolved Cases; FR-001 guarantees it never is.

**Fix.** Add an FR: inbound for an identity with a `resolved` Case inside `reopen_window_days`
MUST reopen that Case in place (status → `in_progress`, write `connect_case_reopen`, emit
`connect.case.reopened`, clear `resolved_at`) rather than open a new one; inbound after that
window opens a new Case that carries `related_case_id` back to the original and surfaces it in the
Case detail. State the relationship between `case_attach_window_minutes` (open Cases),
`reopen_window_days` (resolved Cases) and `auto_close_after_days` (closed) with defaults, and add
a test row alongside T-TEST-02.

---

### C3 — FR-014's "manual-match task" is a phrase: no table, no route, no screen, no owner, no test. It is the named mitigation for a Critical risk

**Location.** FR-014 (line 121), R2 (line 346), T-ING-03 (line 378), § Data model (lines 233-274),
§ UI (lines 319-339), § Integration test coverage (lines 406-429).

**Defect.** FR-014:

> Below the per-`handle_type` threshold the system MUST link **nothing**, set
> `link_state='unresolved'` and **raise a manual-match task**. → T-ING-03

The string "manual-match" occurs exactly twice in the whole document: in FR-014 and in R2's
mitigation column. Everything downstream of "raise a task" is missing:

- **No entity.** § Data model enumerates `connect_cases`, `connect_conversations`,
  `connect_contact_identities`, `connect_case_reopens`, `connect_pending_projections`,
  `connect_tenant_settings`, `connect_case_tags`. There is no task table.
- **No route.** The API table has `GET /api/connect/contact-identities` but the merged spec, unlike
  B (`:256` "Filter by `linkState`, `customerEntityId`"), does not even state that it can be
  filtered by link state.
- **No screen.** § UI names five surfaces: `/inbox`, `/cases`, `/cases/[id]`, `/customers/[id]`,
  `/settings`. None is a manual-match worklist. The only place an unresolved identity appears is
  the Inbox right rail — "contact-identity panel with confidence and link/verify" (line 325) —
  which you can only reach by already having opened that Case. There is no way to ask "what is
  waiting for me to identify?"
- **No task, no test.** T-ING-03 is `lib/identity-resolver.ts` — a resolver cannot write a row to a
  table that does not exist. No T-UI covers it. No T-TEST row covers it. U3 ("link from the rail")
  tests linking, not discovering.
- **No owner.** No persona is defined anywhere in the merged spec (the word "persona" does not
  appear), so it is not stated whether a front-line agent, a supervisor or a data steward works
  these. This matters because `/link` is gated on `connect.inbox.handle` and `/unlink` on
  `connect.identities.manage` (line 293) — two different capability levels on one workflow.

The prototype confirms this state was never designed. Its identity rail draws only the *linked*
case: "Numer z WhatsApp, adres e-mail i profil Instagram zostały połączone w jeden profil." with
"94%" and a "Sprawdź dopasowanie" button. There is no unresolved rendering in the fixture at all.

This is not a cosmetic gap. R2 is rated **Critical** — "Wrong identity link exposes another
customer's orders" — and its mitigation column literally reads "ambiguous handles raise a
manual-match task". A mitigation that produces an invisible row is not a mitigation; it is a
queue of unserved customers that grows silently, and the right rail meanwhile shows an agent a
Case with an unknown customer and no orders — the exact "no context" failure the phase exists to
fix, with nothing telling the agent it is fixable.

**Fix.** Either (a) specify it properly: a `connect_identity_match_tasks` table (or an
`unresolved` filter on `contact-identities` with an explicit worklist), a
`/backend/connect/identities` screen with an FR, an assignee/feature owner, an FR for what the
Inbox rail renders while unresolved (including that order context is suppressed, not empty), and
T-TEST/U rows; or (b) cut the phrase from FR-014, state that Phase 1 leaves unresolved identities
discoverable only in-Case, and downgrade R2's mitigation text to what actually ships — but then R2
needs a different Critical mitigation.

---

### C4 — The programme's business case is a restatement of the prototype's decorative delta chips against the wrong counterfactual; the merged spec ships no success criteria and cannot settle it

**Location.** Merged spec has **no** Problem Statement, no Overview, no success metrics, no
acceptance criteria and no Final Compliance Report (heading list: Provenance, Readiness, TLDR,
Scope, Requirements, Architecture, Blocking upstream PRs, Core-edit ledger, Data model, API
contracts, UI, Risks, Tasks, Integration test coverage, Migration & BC, Open questions,
Changelog). It inherits its justification from the App Spec § 1.2.2, and parks the measurement
question in Q3 (line 452).

**Defect — the arithmetic.** App Spec § 1.2.2 states:

> | Cost per contact | 7.30 PLN | ≤ 6.20 PLN | |
> | First-contact resolution | 72.3 % | ≥ 78 % | |
> | Average handling time | 5:30 | ≤ 4:38 | |
> | Contacts closed without an agent | 29 % | ≥ 38 % | |
> | NPS | 57 | ≥ 61 | |
>
> **Consolidated value.** At 44 060 contacts, 1.10 PLN saved per contact is **≈ 48 500 PLN/month.**

Reconciled against the prototype's `KPIS` fixture:

```
{ label:'Koszt kontaktu',                        value:'6,20 zł', delta:'-1,10 zł' }
{ label:'Rozwiązane przy pierwszym kontakcie',   value:'78,4%',   delta:'+6,1 pkt' }
{ label:'Średni czas obsługi',                   value:'4:38',    delta:'-52 s'    }
{ label:'Sprawy obsłużone przez AI',             value:'38%',     delta:'+9 pkt'   }
{ label:'NPS',                                   value:'61',      delta:'+4'       }
```

Every single "Target" is the prototype's **current** value and every single "Baseline" is
`current − delta`: 6.20+1.10 = 7.30; 78.4−6.1 = 72.3; 4:38+52 s = 5:30; 38−9 = 29; 61−4 = 57.
The prototype's own subtitle is "Sierpień 2026 · wszystkie kanały · **porównanie z poprzednim
miesiącem**" — those deltas are month-over-month movement **inside an already-running Connect**
(nine channels, bots at 38 % containment, AI Assist, campaigns). They are not the delta versus
the shared mailbox that Phase 1 replaces. The entire 48 500 PLN/month case measures Connect
against Connect-one-month-ago.

The proof is the one row where the prototype has no delta chip: `abandon: '3,2%'` carries no
delta, and § 1.2.2 could not manufacture a target for it — it is the sole row marked "**not yet
measurable** — OQ-14". The method is visible in its own failure mode.

**Defect — the denominator.** 44 060 is the sum of the prototype's `CHANNELS_CFG` volumes
*including* `portal: { volume: '3 100 sesji' }`:

```
8 410 + 6 120 + 5 480 + 4 260 + 1 940 + 1 210 + 12 800 + 740 = 40 960   (contact channels)
40 960 + 3 100 = 44 060                                                  (+ portal sessions)
```

Portal rows are labelled *sesji* (sessions) — self-service page views where no agent was
involved and no contact cost was incurred. Multiplying an agent-cost saving over them inflates
the headline by 3 100 × 1.10 = **3 410 PLN/month (≈ 7 %)**; the defensible figure is ≈ 45 060 PLN.

**Defect — an unsupported headline.** The prototype's `INTENTS` fixture cannot produce the 38 %
containment the FTE claim rests on ("Containment 29 % → 38 % releases **1.2–1.8 FTE**"):

```
contained ≈ 4210×.84 + 2980×.62 + 1640×.71 + 860×.48 ≈ 6 961 / month
6 961 / 40 960 = 17.0 %   (of all contacts)
6 961 / 10 230 = 68.0 %   (of intent-covered contacts)
```

38 % reconciles with neither denominator. Similarly `AI_METRICS` claims "Sugestie przyjęte przez
agentów **72 %**" while the volume-weighted `AGENT_STATS.ai` column gives 53.5 %. The App Spec
already caught one instance of this ("matches 3 of 6 rows and misses 'Social i pozostałe' by 2.5
points, so it is hand-authored, not computed") — by my reconciliation it matches **2 of 6**, not
3 — but stopped at the channel pie and did not re-run the check on the KPI row it then converted
into targets.

**Defect — Phase 1 cannot settle any of it.** Q3 says the baseline is "Not resolvable from the
prototype; the fixture never separates inbound from outbound. Only operator data closes it."
That is half true — the prototype *does* state volume (40 960/month; `BARS` sums to 10 210/week,
consistent) and `CAMPAIGNS` isolates 6 210 + 3 900 outbound sends, so a partial split is
derivable. More importantly the merged spec ships no instrument that would close it either: see
M5 below.

**Fix.** (1) Delete "Target = prototype current value" from § 1.2.2 and restate every target as a
delta against the *shared-mailbox* baseline, explicitly marked as unmeasured until FR-019 reports.
(2) Correct the denominator to 40 960 and restate the value as ≈ 45 000 PLN/month, or justify
counting portal sessions. (3) Withdraw the 1.2–1.8 FTE claim until containment is reconciled with
a stated intent model. (4) Give the merged spec a Problem Statement (carry B's four failures,
`:59-70`) and a short "Phase 1 succeeds when…" table with three or four criteria the counting
layer can actually evaluate — the spec-content checklist in `.ai/specs/AGENTS.md` requires
Problem Statement and Final Compliance Report and the merged document has neither.

---

## Major

### M1 — The auto-acknowledgement to the customer is assumed by a Critical risk and asserted by a test, but is specified nowhere; the customer is never told their e-mail became a Case

**Location.** R1 (line 345), T-TEST-03 (line 415), § Scope (line 74), FR-012 (line 116).

R1's Critical scenario opens with "**Connect acknowledges**, a vacation responder replies, a Case
opens, repeat." T-TEST-03 asserts "**No Case created, no acknowledgement sent**" — a negative that
only makes sense if acknowledgements are sent on the positive path. But:

- No FR requires sending one. FR-012 is about *suppressing inbound* auto-responder traffic, not
  about *emitting* an acknowledgement — § Scope's "inbound ingest with auto-responder and bounce
  suppression" is the suppression side only.
- No task builds it (T-ING-01…04, T-CH-01 are attach/create/suppress/window/adapter).
- No template, no i18n keys for it in T-I18N-01, no send path (T-API-07 is the agent composer).

Product consequence: the operator's customer sends mail to a support address and receives nothing
— no confirmation, no case number, no expected response time. Under a shared mailbox they at
least got a human reply eventually; Phase 1 adds a silent triage layer in front. With no portal
(line 81) and no notifications, `ZG-<seq>` exists only inside the backoffice, so the case number
the spec spends a FROZEN DB column on is never communicated to anyone outside.

**Fix.** Decide explicitly. Either add an FR ("an inbound message that opens a Case MUST send a
templated acknowledgement carrying the case number, on the originating channel, suppressed for
auto-submitted traffic"), with a task, i18n keys and an idempotency rule that R1's loop guard can
reference — or remove "Connect acknowledges" from R1 and "no acknowledgement sent" from
T-TEST-03, and state in § Scope that Phase 1 is silent to the customer, which is a product
decision the operator should sign off.

### M2 — There is no surface where an agent creates a Case, although the route, the source packages and the prototype all have one

**Location.** § API contracts row 1 (line 285); § UI (lines 319-328); T-UI-06…09 (line 401).

The merged spec collapses cases CRUD to a single "GET/POST/PUT/DELETE `/api/connect/cases` …
factory" row. B's phase spec was explicit: "`POST /api/connect/cases` | `connect.inbox.handle` |
**Manual case creation**" (`:246`). The prototype has two creation entry points — `Utwórz
zgłoszenie` on the Zgłoszenia screen and `Nowe zgłoszenie` on the customer header — plus an empty
state CTA `[Utwórz zgłoszenie]` (B `:378`).

The merged § UI describes `/cases` as "(DataTable + CSV)" and nothing else. No FR covers manual
creation; T-UI-07 is one word ("Cases list · Case detail · Customer 360 · settings").

Product consequence: **inbound is the only origin of work.** An agent who takes a phone call, or
who is handed a problem in person, or who needs to open a Case proactively after spotting a
delayed order, cannot. For a service desk that is not a Phase-1-acceptable constraint unless it is
a stated decision. It also strands the FR-017 projection: work done outside an inbound channel
never reaches the Customer 360 timeline, so the timeline is systematically incomplete.

**Fix.** Add an FR ("an agent with `connect.inbox.handle` MUST be able to open a Case manually
against a chosen customer and channel"), a task for the create dialog/form, and a U-row; or state
in § Scope that Phase 1 is inbound-only, remove `POST /cases` from the route table, and remove the
`[Utwórz zgłoszenie]` empty-state CTA inherited from B.

### M3 — Transfer has a route, a command, an event and an undo, but no UI, no target picker and no notification to the receiving agent

**Location.** FR-002 (owner) line 95; `/transfer` route line 289; T-CMD-01 line 395; T-TEST-13
line 425; § UI lines 319-339.

"transfer" appears five times in the merged spec — never in § UI and never in the task list as a
UI task. B's phase spec described the centre-pane header actions explicitly ("actions Przekaż /
Karta klienta / Zamknij sprawę", `:355`), matching the prototype's `Przekaż` button; the merge
reduced that line to "Centre: header, thread rendering `in`/`out`/`sys` distinctly, composer with
reply-channel picker."

Unspecified as a result: where the transfer control lives; how the target is chosen (the assignee
picker needs a scoped user list — no route supplies one, and none of the peer-read facades cover
`auth`/`staff`); whether a reason is required (B had `{ assigneeUserId, reason }`, the merge
dropped the body); and what the receiving agent sees.

**The notification gap is the sharp part.** The string "notif" does not occur anywhere in the
merged spec. With no notification, no `clientBroadcast` (T-EVT-01, line 369) and no assignment
e-mail, a transferred Case simply appears in the target's filtered list the next time they reload.
For an urgent escalation that is a silent hand-off into a void. The same gap applies to any
assignment (FR-002's "owner") and to `escalated` (C1).

**Fix.** Specify the transfer interaction (dialog, target source, mandatory reason), add a
task and a U-row, and add an FR requiring an in-app notification to the new assignee on transfer
and on assignment — the platform has a notifications mechanism (root `AGENTS.md` Task Router →
Notifications) and Phase 1 currently uses none of it.

### M4 — Empty states were deleted in the merge, yet U6 tests them — and U6's assertion is falsified by the table it came from

**Location.** § Integration test coverage, UI row (line 428); § UI (no empty-state content).

U6 reads: "every empty state with a working CTA". The merged § UI mentions only
"`LoadingMessage`/`ErrorMessage` per pane". B's phase spec had a six-row Empty states table
(`:370-381`) that the merge dropped wholesale. So U6 is a test with no requirement — a Playwright
test authored against a specification section that no longer exists.

Worse, U6's claim is false against its own source. B's table includes:

> | Inbox, nothing | "Kolejka pusta. Dobra robota." | **—** |

An empty queue correctly has no CTA. "Every empty state with a working CTA" is therefore
unsatisfiable as written even if the table were restored, and two other rows have CTAs that are
questionable Phase-1 affordances: "[Poproś administratora]" (a CTA that does nothing) and
"[Utwórz zgłoszenie]" (a screen that does not exist per M2).

Missing entirely from both documents: the **error** state per pane beyond a component name (what
does the right rail render when the `sales` order fetch fails but the thread loaded? B said "a
failed context fetch leaves the thread and composer usable", `:345` — the merge dropped that too),
and the **loading** choreography of a three-pane composite where each pane loads independently.

**Fix.** Restore the empty-state table into the merged § UI with a row per surface (Inbox filtered
/ Inbox empty / Cases filtered / Cases never-used / Customer 360 no history / identity unresolved
/ metrics no data), each with a message key and either a CTA **or an explicit "no CTA — this is a
success state"**; add per-pane error and loading behaviour including partial-failure rules; then
restate U6 as "every empty state renders its specified message, and every state that declares a
CTA has one that resolves with the viewing persona's features."

### M5 — FR-019's counting layer has no reader, no screen, no definition and no test; it cannot close Q3

**Location.** FR-019 (line 134), `/api/connect/metrics/baseline` (line 295), drift note (line 313),
T-MET-01 (line 403), Q3 (line 452), § UI (lines 319-328).

FR-019: "Phase 1 MUST ship the counting layer: cases opened/resolved, inbound/outbound timestamps,
duplicate-reply candidates."

- **No screen.** § UI lists five surfaces; none is a metrics page. The output is a JSON endpoint
  and a worker. No human reads it without curl.
- **No reader.** After the drift reconciliation the endpoint is guarded by
  `connect.cases.view.all` — a *listing-breadth* capability being reused as an *analytics* one.
  That means every agent who can see all Cases can also pull the operator's cost baseline, and no
  role is nominated as the metric's audience.
- **No definition.** "duplicate-reply candidates" is the metric that would close B's Problem
  Statement #1 ("Two agents answer the same e-mail… Estimated at ~4% of e-mail volume — a figure
  this phase must *measure*, not assume", `:61-63`) and it is never defined: not two outbound
  messages within N minutes, not two distinct `senderUserId`s on one Conversation, not anything.
  Two implementers will build two different numbers.
- **No test.** T-TEST-01…13 contain no metrics row. R6 says "the baseline job reconciles and
  reports drift" — reports it where, to whom, in what form?
- **Contradiction with Q3.** Q3 says baseline volume "is what Phase 1 *measures*" while
  simultaneously "Only operator data closes it". Both are true only if Phase 1 ships an instrument
  that an operator will actually look at. As specified it does not.

**Fix.** Define each counter with its formula and window; nominate the reader (a Phase-1
read-only `/backend/connect/insights` panel, or an explicit "CSV export from the Cases list is the
Phase-1 reporting surface, no chart ships" decision); give it its own ACL feature rather than
overloading `connect.cases.view.all`; add a T-TEST row asserting the counters against a seeded
fixture; and restate Q3 as "closed when FR-019 has reported N days of production data", naming N.

### M6 — Identity confidence is undefined, so the number the UI renders and the threshold that gates a Critical risk are both unspecified — a gap ANALYSIS-054 already flagged and the merge did not repair

**Location.** FR-013 (line 119), FR-014 (line 121), § Data model `confidence` (line 256), § UI
right rail (line 325), R2 (line 346), T-ING-03 (line 378).

FR-013 requires "a recorded confidence and match method"; FR-014 gates on "the per-`handle_type`
threshold". Nowhere does the spec say **how confidence is computed**, what the per-`handle_type`
thresholds are, or where they are configured (`connect_tenant_settings` is described only as
"typed columns, not key/value" — line 262 — and its columns are never listed).

The merged spec's own cited Evidence says this outright:

> Both specify a confidence score and a threshold… Neither specifies *how confidence is computed*
> for a phone number seen on WhatsApp versus an Instagram handle, and the shipped
> `contact-resolver` returns a `ContactHint` with no score. This is the input to the
> Critical-severity failure both packages name (showing customer A's orders to customer B), and it
> is unspecified in both. — `ANALYSIS-054`, § 217

UX consequence: the right rail renders "confidence" to an agent (the prototype draws "94%" next to
"Sprawdź dopasowanie"). A percentage with no defined meaning is worse than no percentage — it
invites the agent to treat 94 % as trustworthy and 71 % as not, on a scale nobody defined. And
because Phase 1's only handle types are e-mail and web-form (§ Scope, line 86), e-mail-to-customer
matching is either an exact hash hit (confidence 1.0) or nothing — so the whole confidence/threshold
apparatus has no discriminating input in this phase at all, while shipping a FROZEN column and a
user-visible number.

**Fix.** For Phase 1, state the actual rule ("exact `handle_value_hash` match on a
`customers` e-mail → `auto_linked`, confidence 1.0; anything else → `unresolved`"), set the
per-`handle_type` threshold table with defaults in `connect_tenant_settings`, and either hide the
confidence figure from the rail in Phase 1 or label it with the match method it came from
("dopasowano po adresie e-mail" rather than "94%").

### M7 — The headline value proposition — the customer context rail — has no requirement and no test

**Location.** TLDR (line 65), § UI right rail (line 325), FR-001…FR-023, U1 (line 427).

The TLDR's promise is "the agent replies from a three-pane Inbox **with the customer's orders on
screen**". That is the whole product argument against a shared mailbox (B's Problem Statement #2:
"No context. The agent alt-tabs to the ERP to find the order, the shipment and the return.").

No FR requires it. FR-001…FR-023 cover lifecycle, delivery, identity, projection, tenancy and
i18n; the right rail is mentioned only in one prose sentence of § UI: "Right: customer card, order
context, contact-identity panel with confidence and link/verify." No field list, no source, no
behaviour when the customer has zero orders, no behaviour when the identity is unresolved. No test
asserts it: U1 is "login → inbox → reply"; U5 is Customer 360 tabs. T-TEST-08 counts queries at 300
Cases but asserts nothing about content.

The merge also silently dropped B's field list ("customer card (LTV, orders, NPS, churn)",
`:357`) — probably correctly, since Phase 1 has no NPS source (surveys are out of scope) and no
churn model — but replaced it with nothing, so the rail's contents are now undefined rather than
narrowed.

**Fix.** Add an FR: "The Inbox MUST render, for a Case with a resolved identity, the customer's
identity, their most recent N orders with status, and any linked order/return/shipment from
`source_*_id` — resolved through public `sales`/`customers` APIs, batched per page." Enumerate the
fields, define the unresolved and zero-order renderings, and add a U-row asserting the order
appears.

### M8 — Two competing Customer-360 surfaces; `/backend/connect/customers/[id]` is a screen with no FR

**Location.** § UI (line 327), FR-017 (line 128), T-WID-01 (line 402), Upstream PR B (line 198).

The spec simultaneously ships:

- `/backend/connect/customers/[id]` — "Customer 360" (line 327, T-UI-08), and
- four new injection spots into `customers`' and `sales`' existing detail pages plus a "has open
  case" column on the orders list (T-WID-01, PR B).

Meanwhile FR-017 — the only projection requirement — says resolving "MUST project a
`CustomerInteraction` onto the **Customer 360 timeline**", which is `customers`' own timeline on
`customers`' own detail page.

So there are two customer detail pages, the FR points at the `customers` one, and the `connect`
one has no FR, no field list beyond B's "header KPIs and four tabs" (`:367`), and no stated
relationship to the other. An agent clicking "Karta klienta" from the Inbox has no defined
destination. If Phase 1 injects widgets into the platform's customer page, the second page is
redundant; if the second page is the product surface, the widgets are.

**Fix.** Pick one. Recommended: drop `/backend/connect/customers/[id]` for Phase 1, route "Karta
klienta" to the platform `customers` detail page, and let T-WID-01's injected widgets carry the
Connect content — that is the sanctioned extension mechanism and it removes a whole screen from
the phase. If the standalone page stays, give it an FR, a field list, and a stated reason why the
injection spots are still needed.

### M9 — Wrap-up: the interaction is unspecified, `wrap_up_seconds` has no writer, and the blocking gate is inherited from an AI-drafted design that Phase 1 explicitly excludes

**Location.** FR-004 (line 99), `wrap_up_note` / `wrap_up_seconds` (line 242), T-API-04 (line 389),
§ Scope out-list (line 81).

FR-004: "A Case MUST NOT reach `resolved` with an empty wrap-up note." The spec never says:

- **Where.** Modal on clicking Resolve? Inline field in the composer? A dedicated wrap-up pane?
- **When the timer runs.** `wrap_up_seconds` is a stored column with no start event, no stop
  event, no writer task and no consumer in Phase 1 (there is no AHT metric — FR-019 counts cases
  and timestamps). It is a FROZEN column measuring something undefined.
- **What counts as non-empty.** One character? A whitespace check? A minimum length?
- **What happens to the note.** FR-017 projects a `CustomerInteraction` — does the wrap-up note
  become the interaction body? Nothing says so, and that is the obvious answer.

**The product question the spec never asks.** The prototype's wrap-up is *AI-authored*: the
composer's hint is "Podsumowanie po rozmowie **wypełni AI**", and Settings offers "Podsumowanie po
rozmowie od AI — **Agent tylko zatwierdza treść notatki**" behind a toggle. Phase 1 explicitly
excludes "AI suggestions, summaries, **wrap-up drafts**" (line 81). So Phase 1 keeps the *gate* the
design justified with an *assistant* and removes the assistant. Every resolve now costs the agent
a free-text write, hard-blocked, on every Case including one-line "yes, it shipped Tuesday"
answers. That is a per-resolution tax on the exact volume metric (FR-019 cases resolved) the phase
exists to establish a baseline for — it will depress resolutions and produce a corpus of "ok" notes.

**Fix.** Specify the interaction (recommend: inline required field in the resolve dialog,
`Cmd/Ctrl+Enter` to submit per the DS rule, minimum length stated). State that the note becomes
the projected `CustomerInteraction` body. Either give `wrap_up_seconds` a defined start/stop and a
writer task, or drop the column from Phase 1. And reconsider the hard block: a defensible Phase-1
alternative is "resolve requires a note **or** an explicit 'no note needed' reason code", which
preserves the data intent without blocking the fast path — or accept the block but say so as a
decision with the AI dependency called out, so Phase 4 does not silently re-justify it.

### M10 — Auto-close is silent, indistinguishable from a human close, and has no undo surface

**Location.** FR-005 (line 100), T-WRK-01 (line 394), § Commands and undo (lines 177-181),
§ Data model `connect_cases` (lines 238-245).

The auto-close job closes resolved Cases after `auto_close_after_days`. Nobody is told: no
customer message (M1: Phase 1 is silent to the customer), no agent notification (no notifications
at all), no `clientBroadcast`. `close` is listed as an undoable command with
`extractUndoPayload()`, but undo requires a surface to invoke it from and none is specified — and
the actor here is a worker, so there is no session in which an undo toast could appear.

`connect_cases` has `closed_at` but no `closed_by_user_id` and no `close_reason`. A Case closed by
a supervisor and a Case closed by a timer are byte-identical in the data, so the FR-019 counting
layer cannot distinguish "resolved and confirmed" from "resolved and abandoned by timeout" — which
is exactly the distinction an operator needs to know whether the desk is working.

FR-003 requires "every transition MUST record actor and time"; the auto-close transition has no
human actor and the schema provides nowhere to record a system one.

**Fix.** Add `closed_by_user_id` (nullable) and `close_reason` (`manual` | `auto_close` |
`merged`) to `connect_cases`; require the Cases list and detail to show which; require the
auto-close job to emit `connect.case.closed` with the reason (already declared) and to be
reportable in FR-019; and state whether reopen remains available after auto-close (see C2) — if it
does, "undo" is unnecessary and the § Commands and undo entry for `close` should say so.

### M11 — The Inbox has no update mechanism at all, while U7 tests the conflict that absence maximises

**Location.** T-EVT-01 (line 369) "No `clientBroadcast` in Phase 1"; FR-007 (line 104); U7 (line
429); § UI (lines 319-339).

The strings "refresh", "poll" and "notif" do not occur in the merged spec. B's phase spec at least
said how the agent copes — "the Inbox refreshes on interaction; live push arrives with the
wallboard in Phase 3" (`:308-309`) — and the merge deleted that sentence, leaving the "no
clientBroadcast" decision with no stated alternative.

Journey consequence: an agent sits on the Inbox. A new e-mail arrives. Nothing happens. They learn
about it when they next navigate. The prototype's own nav carries a live `counts.open` badge on
Inbox and a live wallboard "Dane odświeżają się co 4 sekundy", so the design assumed liveness
throughout.

It also compounds FR-007. Two agents on a shared mailbox with no presence indicator, no live
update and no assignment notification will collide constantly — and the spec's own U7 ("two tabs
edit one Case → conflict bar") tests that collision as the *expected* experience rather than
treating it as the thing to reduce. The 409 conflict bar is a last line of defence, not an
answer to "two agents answer the same e-mail", which is B's Problem Statement #1 and the ~4 %
figure this phase is supposed to measure.

**Fix.** State the Phase-1 freshness mechanism explicitly — at minimum "the Case list re-fetches
on window focus and on every mutation; the Case detail re-fetches on focus" — and add a
lightweight collision guard that does not need SSE: show `assignee` and `last_agent_touch_at` on
every Inbox row and warn when opening a Case another agent touched within N minutes. Say in
§ Scope that live push is Phase 3.

### M12 — `ZG-` is a Polish abbreviation frozen into a DB column while FR-023 requires complete `en`

**Location.** § Data model (line 238) "`case_number` (`ZG-<seq>`, unique per tenant…)"; FR-023
(line 144); § Frozen-surface drift (lines 304-317).

`ZG` is short for *zgłoszenie*. It is hard-coded in a DB-stored, tenant-unique, FROZEN identifier
that appears in every list, every detail header, every CSV export and (once M1 is resolved) every
customer-facing message. An English-locale tenant will see `ZG-1042` and it will mean nothing.
FR-023 requires "`pl` and `en` ship complete" — a locale file cannot retranslate a stored
identifier.

The merged spec itself sets the precedent for treating this class of problem as blocking: its
§ Frozen-surface drift section reconciles two disagreements "both … FROZEN, DB-stored, and cost a
data migration to change later" **before commit 1**. `case_number`'s prefix is the same class and
was not flagged.

**Fix.** Add `case_number_prefix` to `connect_tenant_settings` (default `ZG`, validated
`[A-Z]{2,5}`), have the sequence generator read it, and state the format as
`<prefix>-<seq>`. Add it to the pre-commit-1 frozen-surface reconciliation list.

### M13 — Traceability regressed from 100 FRs to 23 with no mapping, and the merge's own Provenance claims otherwise

**Location.** § Provenance table (line 22); § Requirements (lines 88-144).

The Provenance table justifies taking package A for "Numbered requirements, peer-read facade
contract, task discipline, tenancy gate — **100 traceable FRs** and a file-pathed task graph".
ANALYSIS-054 scores A's requirement fidelity on "12 stories / 100 FRs / 25 edge cases / 22 SCs,
**each screen traceable**".

The merged document ships **23** FRs, zero user stories, zero success criteria and zero edge
cases, with no mapping table showing which of A's 100 were folded, which were deferred to Phases
2-8, and which were dropped. The artefact the merge cites as A's strength is the artefact it did
not carry. There is no way for a reviewer to check whether a screen or a journey was lost in the
compression — which is how C3, M2, M3 and M4 above got through.

**Fix.** Add an appendix table mapping A's FR ids → merged FR id | deferred to Phase N | dropped
(with reason). Restore a short user-story and success-criteria section (three or four stories is
enough for a phase this size) so the FRs have something to trace *to*, and so the U1-U8 Playwright
rows have requirements to reference.

---

## Minor

### m1 — U4 tests "inline status" advance, which § UI no longer describes
§ UI reduces `/cases` to "(DataTable + CSV)". B had "inline status advance" (`:365`) and the
prototype instructs "Kliknij status, aby przesunąć zgłoszenie dalej". U4 (line 428) still says
"list filter + inline status". Restore the requirement or fix the test row. Note that inline
advance also needs C1's transition table to know which next state to offer.

### m2 — Permissions-degraded states are undefined
FR-022 narrows listing without `connect.cases.view.all`, and `/link` vs `/unlink` sit on different
features (line 293), but § UI never says what a view-only agent (`connect.inbox.view` without
`.handle`) sees — hidden composer or disabled composer, hidden Resolve or 403 on click — nor what
the page renders when FR-021 returns 404 for a cross-org id. Add a short "capability → rendering"
table.

### m3 — Channel filter chips and a "channel-badge cluster" for a two-channel phase
§ UI keeps "Left: channel filter chips … with a channel-badge cluster" (line 322) from a
nine-channel prototype (`CHANNELS_CFG` has nine entries; the Settings screen counts "z 9"). Phase 1
ships e-mail and web form. Two chips and a one-badge "cluster" is decorative chrome that will read
as unfinished. Either state that the chips render only when >1 channel type is connected, or drop
them for Phase 1 and note the deferral.

### m4 — `priority` is a field with no setter, no semantics and no consumer
FR-002 requires priority; the data model stores it; nothing sets it (B said "agent-set in Phase 1",
`:185`, and the merge dropped that), no FR defines what the values mean with no SLA and no
routing, and no screen is stated to sort or filter by it. Either give it a setter, a default sort
and a stated meaning, or ship the column and say Phase 1 does not act on it.

### m5 — `connect_tenant_settings` columns are never enumerated, so the Settings screen has no content
Line 262 says only "typed columns, not key/value". The spec references
`case_attach_window_minutes`, `auto_close_after_days`, `reopen_window_days` and per-`handle_type`
thresholds; B additionally had `touch_idle_cutoff_seconds`. T-UI-09 is the word "settings". List
the columns with types, defaults and validation, and say which are exposed on
`/backend/connect/settings` and which are not tenant-editable.

### m6 — Provenance says "Both scored ~37/50"; ANALYSIS-054 scored A 37 and B 38
Line 16 vs the cited Evidence's scorecard total row. Trivial, but the merged spec's framing ("both
scored ~37") slightly flattens a result its own citation states precisely, and the sentence is load-
bearing for the "carry both forward" decision. Quote the real numbers.

### m7 — The prototype's channel-share pie does not reconcile with its own volumes, and the App Spec's audit of that fact is itself off by one
Against the `CHANNELS_CFG` denominator of 40 960: SMS 31.25 % (shown 31 ✓), Telefon 20.53 % (21 ✓),
E-mail 14.94 % (shown **16**), Chat 13.38 % (shown **14**), WhatsApp 10.40 % (shown **11**),
Social+pozostałe 9.49 % (shown **7**). That is 2 of 6 matching, not the "matches 3 of 6 rows" the
App Spec states. Irrelevant to Phase 1's build, relevant to whether the fixture's numbers may be
cited as a baseline anywhere (see C4). Note for contrast that the fixture *is* internally
consistent elsewhere — `BARS` heights all resolve against a 2 636 axis max, `liveTotals.waiting`
(17) equals the sum of `QUEUES.waiting` (8+4+3+2), and the NAG-8841 scorecard's 9+10+7+9 = 35/40 =
87.5 % matches `RECORDINGS.score: 88` — so the KPI/pie rows are the hand-authored exceptions, which
is exactly why they should not be reused as measurements.

---

## Summary of what a human cannot do in Phase 1 as specified

| Journey | Status |
|---|---|
| Answer an inbound e-mail from one screen with the order visible | Specified in prose; no FR, no test (M7) |
| Open a Case for work that did not arrive by e-mail | **No surface** (M2) |
| Find out which contacts need manual identification | **No surface, no table, no test** (C3) |
| Hand a Case to a colleague and have them know | Route exists; **no UI, no notification** (M3) |
| Continue a conversation after resolving it | **Dead-ends into an orphan Case** (C2) |
| Resolve a simple Case quickly | Hard-blocked on a free-text note the design assumed AI wrote (M9) |
| Learn that a Case auto-closed, or undo it | **No surface, no data to distinguish it** (M10) |
| See that new work arrived while sitting in the Inbox | **No mechanism specified** (M11) |
| Read the baseline the phase exists to establish | **No screen, no reader, metric undefined** (M5) |
| Receive any confirmation as the customer | **Nothing is sent; assumed by R1 and T-TEST-03** (M1) |

FINDINGS: 4C/13M/7m

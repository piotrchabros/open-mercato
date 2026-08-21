# Independent review register — App Spec: Mercato Connect

**Spec under review:** `.ai/specs/2026-08-21-app-spec-mercato-connect.md` (v1, 2026-08-21)
**Date:** 2026-08-21
**Reviewers:** three independent agents, one per owner role, each blocked from reading the
author's self-review until it had written its own findings.

| Reviewer | Scope | Findings |
|---|---|---|
| **Architect** | Platform claims verified against source | 5 critical, 10 major, 6 minor, 9 missed capabilities |
| **DDD challenger** | Invariants, formulas, ubiquitous language, stories | 14 critical, 22 major, 13 minor, 8 rejected false alarms |
| **PM / UX** | Design fidelity vs the prototype, ROI arithmetic, phasing | 9 critical, 15 major, 14 minor, 19-row number audit |

> **This register supersedes `challenger-review.md`'s verdict.** That file was the author's
> inline self-review, run under a session constraint that forbade subagents. It is retained for
> the audit trail, but three of its "Pass" rows and two of its ACCEPTED findings are falsified
> below. **OQ-9 is now resolved:** the independent pass ran, and it was necessary.

---

## 1. Verified by the author, first-hand

Re-checked directly against source rather than taken on the reviewers' word.

| Claim | Verdict | Evidence |
|---|---|---|
| Volume base is 44 060, not 28 000 | **CONFIRMED** | Sum of all nine `CHANNELS_CFG` rows = 44 060. The spec's 28 160 is a 7-channel sum excluding `sms` (12 800) and `portal` (3 100), yet is described as "across 9 channels". The prototype's channel-share chart independently confirms SMS is in the base: 12 800/40 960 = 31.2% ≡ its "SMS 31%", 8 410/40 960 = 20.5% ≡ its "Telefon 21%" |
| The SLA KPI row was inverted | **CONFIRMED** | `label:'SLA pierwszej odpowiedzi', value:'91%', delta:'-2 pkt', deltaColor:'var(--status-warning-icon)', hint:'cel 93%'`. Warning colour, negative delta ⇒ baseline 93%, current 91%. The spec states baseline 91% → target 93% |
| `feature_toggles` is not a module-disable mechanism | **CONFIRMED** | Entity carries `identifier`/`type`/`default_value`; override carries `tenant_id`/`value`. No module id, no nav or route binding. Every consumer outside the module is a test, a fixture, or `customers/setup.ts` |
| `UserTask.escalatedAt`/`escalatedTo` are never written | **CONFIRMED** | Present in the migration, the zod validator, the OpenAPI schema and one validator test. No `lib/`, `api/`, `subscriber/` or `worker/` code writes them |
| `planner` can replace `connect_business_hours` | **CONFIRMED** | `PlannerAvailabilityRuleSet.timezone`; `PlannerAvailabilityRule.rrule` + `exdates` (jsonb) + `kind`; `getMergedAvailabilityWindows` ships with a service wrapper and tests |
| `call_transcripts` has no implementation | **CONFIRMED** | `CallTranscript` has zero hits across all `.ts`/`.tsx` in `packages/` and `apps/` |
| The `SPEC-049` citation resolves to a tombstone | **CONFIRMED** | The file exists but reads "This specification was renumbered… New canonical file: `SPEC-046b`". Canonical is `SPEC-046b-2026-02-27-customers-interactions-unification.md` |

---

## 2. Blocking — needs a user decision before revision

These are not defects with a correct answer; they are product decisions the spec made
silently and cannot make on its own.

**B-1 — Is Open Mercato the host instance, or one integration among several?** (PM/UX C-8)
§1.1's commercial premise is "runs inside the same instance that already holds the orders…
one licence instead of two, and no CRM↔helpdesk sync to maintain." The prototype's own
Settings table models **"Open Mercato ERP" as a disconnectable integration** with a sync
timestamp, a read/write scope and a `Rozłącz` button — sitting alongside HubSpot ("CRM
sprzedaż"), Dynamics 365 ("CRM B2B"), SalesManago, BaseLinker, PrestaShop and InPost/DHL. So
the design shows the operator still running six integrations, two of them CRMs. This decides
whether the data layer is direct `sales`/`customers` API reads (§4.5 as written) or adapters
over `data_sync`, and whether §1.1's sync-tax saving is honest.

**B-2 — Is pre-sales / B2B in scope?** (PM/UX C-7)
Two of four seeded queues are "Sprzedaż i doradztwo" and "B2B i hurt". Conversation c8 is a
62 000 zł B2B lead whose AI actions are "Przypisz opiekuna B2B" and "Utwórz wycenę w Open
Mercato"; c4 is a pre-purchase question against an 8 213 zł active cart. The spec frames
Connect as "the customer-service surface", has no sales-rep persona, no `source_quote_id`, no
lead assignment, and no revenue in the ROI outside outbound campaigns. Either scope it in
(persona + entity + story + revenue ROI) or exclude it in §1.2 and change the seeded queues.

**B-3 — What constrains AI hosting?** (PM/UX C-4)
The prototype prints "Dane klienta nie opuszczają instancji Open Mercato" as a standing rule
on the AI Assist screen. The spec renders the panel and never converts the promise into an
invariant, a requirement or a constraint on provider/model selection; `model_key` is free
text. For a Polish mid-market retailer under GDPR, with recordings and transcripts in scope,
this decides Phase 3's architecture and interacts with OQ-1.

**B-4 — How many independently disableable units?** (PM/UX C-5, Architect C1)
Two problems compound. The prototype shows **nine** toggleable modules with declared
dependencies; the spec has four, and uses that screen as its justification. Under the spec's
split, `tickets` and `wallboard` cannot be disabled, and **analytics has no module at all** —
it cannot live in `connect_quality`, which carries a hard `call_transcripts` dependency, while
the prototype marks analytics "Bez zależności". Separately, the runtime mechanism the
justification assumes (`feature_toggles`) does not exist; real module disable is build-time in
`apps/*/src/modules.ts`. Module boundaries are a `BACKWARD_COMPATIBILITY` contract surface
once shipped, so this must be settled before Phase 2.

---

## 3. Author-fixable — correct answer exists, no decision needed

### 3.1 Arithmetic and metric definitions

| ID | Defect | Fix |
|---|---|---|
| PM C-1 | Volume base 28 160 stated as "9 channels"; every PLN/FTE/% in the document scales off it | Restate as 44 060, show the sum, say what is excluded and why. Re-derive all ROI. Note this roughly *doubles* the business case (1.10 × 44 060 ≈ 48 400 PLN/month) |
| PM C-2 | SLA baseline/target inverted — the one regressing KPI shown as a gain | State honestly: 93% → 91% under load, Phase 2 is the recovery |
| DDD C-3 | `SLA remaining = due − now − paused` — sign inverted; pausing must add headroom. §1.3 defines breach a second time with no pause term | `remaining = (due_at + paused_seconds) − now`; make §1.3 reference the same expression; scope pause to the resolution clock only (it can never apply to first response) |
| DDD C-5 | Cost-per-contact anti-gaming rule inverted — Cases are the denominator, so splitting *lowers* unit cost. US-1.6 ships the split button, which also halves AHT and repairs FCR | Count by customer-need or distinct originating Conversation; make split audited and reason-coded with a per-agent split-rate metric; relax FCR's `conversation_count = 1` so the omnichannel feature stops penalising the metric |
| DDD C-6 | AHT measures elapsed calendar span — on e-mail (Phase 1's only channel) it reads in hours against a 5:30 baseline | Sum per-touch active handling seconds from a `connect_case_touch` child row; declare `wrap_up_seconds`; exclude customer-wait spans |
| DDD C-4 / PM M-5 | Containment has three denominators; gameable by *disabling* the bot on hard intents; and the prototype's own 38% cannot be reproduced from its intent table (volume-weighted ⇒ 25.1%/16.1%) | Define once, per Case, over all Cases; add a bot-eligible-coverage counter-metric; flag the prototype's internal inconsistency rather than inheriting it |
| DDD C-7 | Phase 3 criterion asserts the opposite of §1.4.4 on `expired` — since rejecting costs a reason and ignoring is free, acceptance trends to 100% | Denominator = suggestions *shown* (add `shown_at`); count `expired` as non-acceptance |
| PM M-3 | Workflow ROIs double-count (WF3's 40 s is inside WF1's 52 s) and total ~700 h/month against a 1.2-FTE headline | Net them; state which workflows contribute to the §1.2 table |
| PM M-4 | WF5 portal ROI ~6× overstated — applies a blended agent-inclusive unit cost to an intent already 84% contained | Re-derive against the low-containment intents (invoices 48%, quality 22%) — the ROI gets both better and honest |
| PM #5 | WF6 repeat-contact ROI 4.3× overstated — a weekly figure re-multiplied by 4.33 | 9/week, half = ~20/month |
| PM #11–13 | Three unsourced inputs presented beside sourced ones (4% duplicate-reply rate, 30 s e-mail AHT, 15% repeat-contact reduction) | Source or drop |
| PM #14 | OQ-2's "voice is 30% of volume" inherits the base error; prototype's own chart says 21% | Restate |
| PM MINOR-2 | "five of eight in ≤2 clicks" — the column reads seven of eight | Fix |
| Self-review C-11 | 121 vs 116 reconciliation is off by 2 | Recompute |

### 3.2 Contradictions with one right answer

| ID | Defect |
|---|---|
| DDD C-1 | Reopen has two mutually exclusive models (inv 1 = new linked Case; WF1 edge 5 = in-place). Under in-place, a reopened Case has no first-response SLA at all and FCR's 7-day window is uncomputable from an integer counter. Pick one; add a `connect_case_reopen` child row and a second-response clock |
| DDD C-2 | Wrap-up gate has three definitions, and system auto-close bypasses it by construction. Gate on `resolved` unconditionally; give auto-close a system-authored note; declare the `resolved → closed` transition, which is currently undefined |
| DDD C-8 | "No invariant spans two modules" is false for inv 5, 6, 11, 12. Inv 6 constrains a column `connect` owns (misattributed). Inv 14 removes inv 5's only enforcement point. Inv 5 has a real TOCTOU window (bot generation starts at owner=`bot`, agent takes over, pre-authorised message lands in an agent-owned conversation). Move 5 and 6 to `connect`, enforce at message-append |
| DDD C-9 | `contact_identity.customer_entity_id` is required, making inv 10's below-threshold path and WF3's unlink flow unrepresentable. Make nullable; add `link_state`, `unlinked_at`, `unlink_reason`; restate inv 10 so human unlink may lower confidence |
| DDD C-10 | Phase 4 criterion "attach when they concern one need" is undecidable — no field, rule, window or source. Give it a concrete rule with a tenant-configurable attach window |
| DDD C-11 | Phase 5 criterion "a summary-less handoff is not permitted" contradicts US-2.2's failure path, which mandates force-queueing. Soften to allow a system-generated fallback summary; the handoff must never block |
| DDD C-13 | Invariant 2's "real user" is undefined and the bot *is* an `auth.User`, so a 00:03 bot auto-reply stamps `first_responded_at` and SLA attainment reads ~99% with no human involved. Add a `principal_kind` discriminator; rename `agent_message_count` → `human_agent_message_count` |
| DDD C-14 | US-3.1's re-link path can move Cases between customers and expose one customer's history in another's portal — the outcome Phase 6 calls "the single worst outcome in this spec". Not in the impact matrix. Add the row, specify re-parenting scope, require `cases.manage`, invalidate affected portal sessions |
| DDD M-04 | `sla_policy_id` is a mutable FK described as a snapshot, so editing a policy retroactively changes in-flight pause behaviour. Version the policy or copy its scalars onto the Case |
| DDD M-05 | Invariant 8 governs auto-push only; supervisor pull, named-agent transfer and campaign connect all bypass capacity and presence. `current_case_count` has no consistency invariant and is mutated from five paths |
| DDD M-07 | Inv 9 (three *expiries*) contradicts WF4 edge 2 (declined *or* ignored) — under inv 9 the cherry-picker is never flipped. No counter field, no reset rule, and the offer state machine has no `withdrawn` terminal outcome |
| PM C-6 | `routing` is instance-level in the design, per-queue in the spec, and §3.5 keeps and defends the now-meaningless global footer card |
| PM M-2 | Phase 4's own exit gate (≥80% of volume) is unreachable until voice ships in Phase 7 — 73.9% at best |
| PM C-9 | Every phase commits to an ROI metric, and the measurement layer ships in Phase 7. OQ-3 explicitly requires a Phase 1 baseline measurement that Phase 1 does not contain |

### 3.3 Platform corrections

| ID | Defect |
|---|---|
| Arch C1 | `feature_toggles` cannot disable modules (see B-4) |
| Arch C2 | "Send outbound: as-is" is false for anything but a reply. Delivery needs a `ChannelThreadMapping`, created only on inbound or via `sendAsUser`, which is hard-gated to channels the agent personally owns — and a contact centre works shared numbers. WF7 broadcast, the SMS callback fallback and all proactive contact have no path |
| Arch C3 | Fix the `SPEC-049` → `SPEC-046b` citation; downgrade the projection from "as-is" to a gap. The `customers.interactions.create` handler is module-private with no external callers, the shipped pattern is inverted (`customers` subscribes and writes), and the `call_transcripts` precedent does not exist |
| Arch C4 | `business_rules` has a closed operator set with no `RANDOM`, no arithmetic and no state — sampling is impossible; routing works only as an unmodelled convention with no first-match-wins; every non-dry-run execution writes a log row on the inbound hot path |
| Arch C5 | `DashboardWidgetMetadata` has no role dimension; role delivery is a separate seeded table, so four new roles get nothing without `appendWidgetsToRoles` rows |
| Arch M1 | `portalBroadcast` fans out organisation-wide by default, and the org is the *merchant's*. Four portal events with no recipient scoping would leak case data across customers. No per-customer-account scope primitive exists |
| Arch M2 | No `GET` webhook route exists (Meta subscription verification has nowhere to land) and delivery receipts are explicitly unimplemented — so the six channels *do* require hub changes |
| Arch M4 | 5 of 7 widget injections target spots that do not exist. `customers` declares person/company/deal only, with no `CustomerEntity` detail page and no sidebar/tab spot; `sales` has no order-detail sidebar and no return spot at all |
| Arch M5 | `UserTask` has SLA/escalation fields but no behaviour, no business calendar, no breach event, and non-nullable `workflowInstanceId`/`stepInstanceId` — so binding a Case means running a workflow instance per Case |
| Arch M6 | The optimistic-lock gates are a curated `packages/core`-only map; app modules are covered by none of the four, so §9's promise is unenforceable as written |
| Arch M7 | Zero commits allocated for integration tests, which the repo mandates in the same change (~15–25% systematic under-scope) |
| Arch M8 | Zero commits allocated for module and package scaffolding |
| Arch M9 | `staff` usage verb should be **use**, not extend; `skill_tags` duplicates the existing `StaffTeamMember.tags` surface |
| Arch M10 | Module placement (`packages/` vs `apps/mercato/src/modules/`) is never stated and determines M6 and the OSS/reference-app framing |

### 3.4 Capabilities to adopt (these *reduce* scope)

1. **`planner`'s RRULE engine replaces `connect_business_hours`** — deletes an entity and **retires OQ-5**, which debated extracting to `shared` while the platform already had the engine.
2. **Conversation assignment and transfer already ship** — `ExternalConversation.assignedUserId`, an assign route and a `reassign-conversation` command. US-1.5 builds this from nothing.
3. **`sendAsUser` + its route** is a working agent-initiated outbound path the spec never names.
4. **Hub operational plumbing** — `provider-health`, `credential-refresh`, `push-state`, `error-classification`, plus health/push/poll routes. The integration-health widget, the Channels status column and the "Odnów SalesManago" flow are scored as new work.
5. **`packages/enterprise/.../record_locks`** — pessimistic locking for the "two agents on one Case" race, never mentioned.
6. **`staff`'s `StaffTeamMember.tags` + `staff/ce.ts`** instead of a parallel `skill_tags`.
7. **`defineModuleExtensionPoints`** — as the flagship reference app, `connect` should publish its own `extension-points.ts`.
8. **The generic dashboard data endpoint** + `useWidgetData()` — most KPI widgets need no bespoke route.
9. **Response enrichers** — the "has open case" order-list column is an enricher, not a column widget needing a new host spot.

### 3.5 Design fidelity — missing from the spec

Prototype elements with no home: the **AI next-action catalogue** (ten commerce mutations
including InPost/DHL carrier claims, coupons and B2B quote creation — reduced to one enum
value and 2 commits, and it is the product's actual differentiator); the order-context quick
actions (Zwrot / **Kupon** / Faktura); **click-to-call**; the **channel-share chart**; the
**toast/flash system** used for every mutation confirmation; **`Szablony`** (canned responses,
whose *analytics* are specced but not their authoring); the **portal preview screen** (the
13th screen — an internal view of what the customer sees); the 5th handoff rule
(category-based); integration `scope`/`sync` columns; `brandName`; the **next-best-case ranking
function** (stated twice in the design, and §3.5 ships a widget that has nothing to compute).

Also: the spec says "12 screens"; `navKeys` enumerates **13**. And the prototype's intent
catalogue is stated as **12 intents** while only 5 are shown and seeded.

### 3.6 Fidelity — extrapolations to label

Not wrong, but none is currently marked as an extrapolation: per-queue SLA policies and
business-hours calendars (the design has three global radio presets), the Case detail page,
the Queues admin page, 11 role-scoped dashboard widgets, per-role landing pages (the design
has no role concept — `state.screen = 'inbox'` for everyone), the routing offer state machine,
`status = closed` as distinct from `resolved`, `presence = offline`, merge/unlink/split flows,
the scorecard dispute machine, and the global outbound frequency cap.

---

## 4. Recommended structural changes

**R-1 — Swap Phases 3 and 4.** (PM M-1) The reviewer was asked to break this ordering or
defend it, and it breaks on the spec's own arithmetic. At the end of Phase 3, Connect carries
6 860 contacts/month; Phase 3's stated ROI ("≈290 agent-hours") requires Phase 4's volume and
over-claims by **2.9×**. The feature is also weakest there — the AI rail's value is
cross-channel compression ("Kontekst z 4 kanałów"), and on a single e-mail thread the agent
can read the original in five seconds. The spec's trust-building rationale only requires AI
before *bots*, not before channels, so it survives the swap intact. And WhatsApp template
approval plus Meta app review are calendar-time dependencies that should start earlier, not
later. **New order:** 1, 2, Channels, AI Assist, Bots, Portal, Quality/Analytics/Outbound.

**R-2 — Pull measurement into Phase 1–2.** (PM C-9) Otherwise Phases 1–6 are unfalsifiable and
OQ-3 can never be closed.

**R-3 — Split Phase 7.** (PM M-13) 27 commits across three unrelated products with three
different blockers, against the spec's own "no artificial phases" checkbox.

**R-4 — Re-scope commit estimates.** (Arch) ~116 → **~200–230**, uniformly optimistic at
1.8–2.0×; nothing was pessimistic. Largest single miss: channel packages 26 → ~52–58,
calibrated against `channel-gmail`'s 1 720 LOC and 11 test files. Accuracy degrades as rows
grow — the signature of scoring the happy-path diff rather than a shippable increment.

**R-5 — Add the missing stories.** (DDD M-12) Reopen, merge Cases, close, admin connects a
channel, admin toggles a module, agent acknowledges a scorecard. Five of the 13 backend pages
in §3.5 have no story at all. Related: **WF3 loses 4 of its 9 commits** — confidence scoring,
the Customer 360 page and the consent read model are scheduled in no phase (DDD M-13).

---

## 5. What the reviewers rejected

Recorded so these are not re-litigated. The DDD challenger rejected 8 candidate findings,
including: seven workflows is within the template's 3–7; the four-module split is defensible
*on bounded contexts* even after the invariants are re-homed; the bot as a system principal is
correct and matches `system-user.ts`; presence genuinely differs from `planner` (different
lifetime, write frequency and consumer — the rostered-vs-live gap is "a genuinely good
design"); modelling the Case as a `WorkflowInstance` is wrong; Phase 1's `manual_pull`-only
workaround is legitimate phasing; invariant 13 (tenant scoping) is boilerplate that should
stay. The PM/UX reviewer credited §1.4.3/§1.4.4, the workflow edge cases and the cross-story
matrix as "better than most shipped specs", and the WF6 knowledge-gap ROI as the one fully
reproducible and appropriately conservative derivation in the document.

---

## 6. Verdict on the self-review (OQ-9, now resolved)

The inline pass caught **presentational and process** defects — double-counts, a missing
conflict row, happy-path stories, IVR scope creep — and its C-5 catch (escalation must read
stored timestamps, never an in-memory countdown) was independently rated the best single
finding in the document.

It missed three whole categories:

1. **Evidence.** It never re-opened the prototype. Every finding is about the spec's internal
   shape, so the volume base, the inverted SLA row and eleven unreproducible figures were
   invisible to it.
2. **Falsification.** It verified that platform artefacts *exist*, not that they *do the job*.
   Three of the architect's five criticals are cases where the cited artefact exists and does
   not work — and the self-review had claimed each as a commit saving. Of ~24 claimed avoided
   commits, roughly **8 are real**.
3. **Internal contradiction.** It did not catch a single one of the fourteen contradictions
   among the invariants, the derived formulas, the entity tables and the phase criteria.

Three of its own "Pass" rows (entity precision, no phantom entities, cross-story coverage) and
two of its ACCEPTED findings (C-2 anti-gaming, C-8 invariant locality) are falsified above.

**This is the predicted failure mode of an author reviewing their own work, and it is the
answer to OQ-9.** The spec's domain modelling, edge-case work and cross-story analysis are
genuinely strong; the failure is that it was written *from* the prototype and never checked
*against* it.

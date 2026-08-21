# App Spec: Mercato Connect

| Field | Value |
|---|---|
| **Date** | 2026-08-21 |
| **Version** | **v3** — second revision, after two independent review rounds |
| **Status** | Draft |
| **Scope** | OSS |
| **Source design** | `.ai/specs/app-spec-notes/design-source/mercato-connect.dc.html` — interactive prototype, **13 screens**, Polish UI |
| **Module(s)** | nine new modules (`connect` core + eight optional); new `packages/channel-*`; **extends** `communication_channels`, `messages`, `inbox_ops`, `customers`, `sales`, `auth`, `portal`, `customer_accounts`, `configs`, `business_rules`, `dashboards`, `notifications`, `ai-assistant`, `perspectives`, `progress` |
| **Review trail** | round 1 (v1): `app-spec-notes/independent-review-register.md` · round 2 (v2): `app-spec-notes/independent-review-register-v2.md` |
| **Prior versions** | `2026-08-21-app-spec-mercato-connect.v1.md` (superseded) |

---

> ## ⚠️ v3 STATUS — architecture usable, **business case and estimate are not**
>
> Round 3 (2026-08-21): [`app-spec-notes/independent-review-register-v3.md`](app-spec-notes/independent-review-register-v3.md).
>
> **Phase 1 slice 1a is cleared to start** — see
> [`2026-08-21-connect-phase-1-one-inbox.md`](2026-08-21-connect-phase-1-one-inbox.md) and the
> authoritative [`app-spec-notes/frozen-surfaces.md`](app-spec-notes/frozen-surfaces.md).
> **Do not plan, budget or commit to the programme from this document.** Three things below are
> known-wrong and were deliberately not patched a fourth time:
>
> 1. **§1.2's contact base has the wrong unit** — channel traffic counted as Cases, double-counting
>    the cross-channel Case this product exists to create. Two fixture cross-checks imply
>    ~15 700–18 300 against a published floor of 28 590. **Not resolvable from the prototype**;
>    only operator data closes OQ-3, and Phase 1's counting layer is what produces it.
> 2. **§4.6's adoption credit is over-stated ~4×** (125–188 → 26–49), so the effective estimate is
>    **~344–367**, not 237.
> 3. **§§4.1–4.4, 6, 8 and 9 are missing**, and §§2/3/3.5/5 are deltas against a v2 file that was
>    overwritten in place and no longer exists.
>
> §0's rules were violated 19 times by this document. The process finding — that the author
> verified their own claims — is in register-v3 §5 and matters more than any single defect.

## 0. Evidence rules `Architect + DDD`

Both review rounds found the same failure twice. v1 asserted platform capabilities without
checking them. v2 checked that artefacts *existed* without checking they *worked* — and did so
on its largest architectural decision (`planner`), then wrote that mistake into §9 as a lesson
learned. These rules exist so a third round does not find a third variant.

**R0.1 — Behaviour, not presence.** A claim that the platform provides capability X cites the
code path that *performs* X, not the column, type or filename that suggests it. Tests that pass
under a pinned environment are not evidence.

**R0.2 — Three questions per mechanism.** Every mechanism named in this document states: **who
writes it** (the owning module), **in which transaction**, and **what happens when its module is
absent**. A mechanism missing any of the three is not specified.

**R0.3 — Derivations are reproducible or ranged.** A number is either derivable from the fixture
by a rule applied consistently to every comparable row, or published as a range with the
uncertainty named. "Confirmed" requires *all* cross-check rows to agree, not the ones that do.

**R0.4 — Extend before parallel.** Before specifying a capability, check whether a shipping
module already provides it. §4.6 records the check.

**R0.5 — FROZEN surfaces are decided before the first migration**, not during implementation.
§4.7 is the freeze list.

---

## 1. Business Context `PM`

### 1.1 Business Model

Mercato Connect is the **customer-service surface of Open Mercato**: an omnichannel contact
centre running *inside* the instance that holds the orders, returns, invoices and shipments.

**Who pays:** the mid-market omnichannel retailer already running Open Mercato as its ERP/CRM,
who today also pays a contact-centre SaaS.

**What they get, stated precisely.** Connect removes **one** integration — the ERP↔helpdesk sync,
the highest-traffic and most brittle one — because service reads orders and returns in-process.
It does not remove the operator's other integrations; the prototype shows six still running,
one with an expired key. Connect inherits the job of surfacing their health, not eliminating them.

> **OQ-10 (decided): in-instance only.** Connect reads `sales` and `customers` through their
> in-process APIs and commands. It is not a vendor-agnostic helpdesk. The prototype renders
> "Open Mercato ERP" as a disconnectable integration; **the spec overrides that** — it is the
> host, and §3.5 removes the row.

**Flywheel:** more channels → one thread per customer beside the commerce record → richer bot and
AI context → containment and acceptance up → unit cost down and FCR up → more volume worth
migrating → more channels. In parallel, every resolved Case writes a `CustomerInteraction`,
improving routing inputs and segmentation.

### 1.2 Business Goals

#### 1.2.1 The contact base — published as a range

v1 quoted a seven-channel subtotal as a nine-channel figure. v2 corrected the sum and then
subtracted its way to a third number using a rule applied to one of four campaigns. v3 publishes
what the fixture actually supports.

**Two independent fixtures agree on the prototype's own definition of "contact":**

| Source | Value |
|---|---:|
| Sum of all nine `CHANNELS_CFG` volumes | **44 060 / month** |
| `BARS` — the prototype's own "Kontakty w tygodniu" counter, 10 210/week × 52 ÷ 12 | **44 243 / month** (0.4 % apart) |

**So 44 060 is the base on which the prototype's own KPI deltas were computed**, and it is the
correct multiplier for any per-contact delta taken from `KPIS`.

**The agent-addressable inbound subset is unknown.** Portal contributes 3 100 *sessions* (a
different unit). Outbound campaign sends sit inside their channels' volumes — the SMS channel
reads *"kampanie i powiadomienia"*, WhatsApp reads *"wysyłka kampanii"*, and the phone channel
runs a predictive dialer — but the fixture never states how much.

| Bound | Derivation | Value |
|---|---|---:|
| Upper | all nine less portal sessions | **40 960** |
| Lower | less every campaign's `contacts` (12 370) | **28 590** |

**v3 uses 44 060 for per-contact monetary claims and the 28 590–40 960 range for agent-effort
claims.** The channel-mix chart is **not** used as corroboration: computed against 40 960 it
matches 3 of 6 rows and misses "Social i pozostałe" by 2.5 points, so it is hand-authored, not
computed. Re-baselining is a Phase 1 deliverable (OQ-3).

#### 1.2.2 Primary goal

Cut the cost of serving a contact and raise first-contact resolution.

| Metric | Baseline | Target | Note |
|---|---|---|---|
| Cost per contact | 7.30 PLN | ≤ 6.20 PLN | |
| First-contact resolution | 72.3 % | ≥ 78 % | |
| Average handling time | 5:30 | ≤ 4:38 | |
| **First-response SLA attainment** | **93 %** | **restore to 93 %** | **it regressed to 91 %** — the prototype shows −2 pts in warning colour against a 93 % goal. This is a recovery, not a gain |
| Contacts closed without an agent | 29 % | ≥ 38 % | |
| NPS | 57 | ≥ 61 | |
| Abandoned queue rate | 3.2 % | ≤ 2.0 % | **not yet measurable** — OQ-14 |

**Consolidated value.** At 44 060 contacts, 1.10 PLN saved per contact is **≈ 48 500 PLN/month**.
Containment 29 % → 38 % releases **1.2–1.8 FTE** depending on where the inbound split falls.

> These are **one saving expressed two ways**, not two savings. Cost per contact is
> `(agent hours × rate + channel spend + AI spend) ÷ contacts`, so the released FTE is *inside*
> the 48 500 PLN. v1 summed them to 4.4 FTE; v2 corrected the reasoning and then wrote
> "38 200 PLN **+** 1.5 FTE". v3: **≈ 48 500 PLN/month, of which 1.2–1.8 FTE is redeployable
> headcount.** Per-workflow figures in §3 are attributions of this total.

**Secondary goal (reference app):** Connect demonstrates `ChannelAdapter` registration, the
`messages` type/object registries, `customers` timeline contribution, `configs`-based tenant
gating, `business_rules` policy, `dashboards` widgets, `portal` + `customer_accounts`, and
`ai-assistant` with `prepareMutation`.

**What is NOT important:**

| Out of scope | Why |
|---|---|
| Being a PBX/softswitch | Connect integrates telephony through an adapter; it never terminates media |
| **Lead qualification, B2B quoting and sales-rep assignment** *(OQ-11, narrowed in v3)* | See the OQ-11 note below |
| Marketing automation, survey/NPS collection, social publishing | Owned by SalesManago/HubSpot and the survey tool; NPS scores are ingested |
| WFM forecasting, shift bidding, payroll | `planner` covers availability only |
| Knowledge-base authoring CMS | `content` + `search` store and retrieve |
| Screen share, co-browse, video | No media surface in v1 |
| **A data-residency guarantee** *(OQ-12)* | AI may use any provider under a DPA; the prototype's on-screen residency promise is withdrawn from the copy |
| Replacing `inbox_ops` | v3 **extends** it — see §4.6 |

> **OQ-11 narrowed (author recommendation — owner may override).** v2 excluded "pre-sales" as a
> block, which made *every* seeded campaign out of scope by v2's own boundaries — including
> abandoned-cart recovery, the campaign funding WF7's entire ROI. v3 narrows the exclusion to
> **lead qualification, quoting and sales-rep assignment** and admits **outbound win-back to
> existing customers with an order history**, which is retention, uses the same agents and
> customer record, and needs no sales persona. The two B2B actions from the fixture stay out.
> If the owner prefers the wider exclusion, WF7 must be re-seeded with service-outbound only
> (proactive delay notice, callback, return-status follow-up) and its ROI re-derived.

### 1.3 Ubiquitous Language

| Term | Polish | Definition | Source | Period |
|---|---|---|---|---|
| **Case** | Zgłoszenie | One customer need: one owner, one status, one thread. Survives channel switches | `connect.case` | until `closed_at` |
| **Conversation** | Rozmowa | One exchange on one channel, bound to exactly one Case | `connect.conversation` over `ExternalConversation` | lifetime |
| **Contact** | Kontakt | **(1)** the ROI unit — always a *Case*. **(2)** an outbound campaign target row. Never a person; that is *contact identity* | context | N/A |
| **Channel** | Kanał | A configured instance — this mailbox, this number | `CommunicationChannel` | N/A |
| **Channel type** | Typ kanału | The transport class. "Nine channels" always means nine **types** | `ChannelAdapter.channelType` | N/A |
| **Service queue** | Kolejka | A routing bucket. Never bare "queue" — that is the worker module | `connect_routing.service_queue` | N/A |
| **Service agent** | Konsultant | A human who handles Cases. Never bare "agent" — that is an LLM agent | `auth.User` | N/A |
| **Principal kind** | — | `human` \| `system_bot` \| `integration`. The discriminator that decides whether an outbound message stops the SLA clock | `auth.User.principal_kind` | N/A |
| **Presence** | Dostępność | Live routing eligibility | `connect_routing.agent_presence` | current |
| **Availability** | Grafik | Rostered schedule. Distinct from presence | `planner` | N/A |
| **Business calendar** | Kalendarz pracy | The open-hours definition SLA targets are measured against | `connect_sla.business_calendar` | N/A |
| **First response** | Pierwsza odpowiedź | First outbound message from a `human` principal, or an AI draft a human accepted | `sla_case_clock.responded_at` | stamped once per generation |
| **Escalation** | Eskalacja | Exactly one meaning: `case.status = 'escalated'`. The approaching-breach notification is an **SLA warning** | `connect.case.status` | N/A |
| **Containment** | Obsłużone bez agenta | Cases with ≥1 bot outbound message, no human-agent message and no handoff | derived, §1.4.4 | month |
| **Handoff** | Przekazanie | Bot→agent transfer carrying a summary | `conversation.handed_off_at` | N/A |
| **Wrap-up** | Podsumowanie | The post-case note. AI drafts, the agent approves | `case.wrap_up_note` | per Case |
| **Intent** | Intencja | A named customer goal shared across channels | `connect_bots.intent` | N/A |
| **Next action** | Następne działanie | A one-click commerce mutation from the AI rail | `connect_ai.action_definition` | N/A |
| **Contact identity** | Tożsamość klienta | A channel handle resolved to one `CustomerEntity`, with confidence | `connect.contact_identity` | lifetime |
| **Customer 360** | Oś czasu | The channel-agnostic event stream | `customers.CustomerInteraction` | lifetime |
| **Campaign** | Kampania | An outbound programme over one channel | `connect_campaigns.campaign` | lifetime |
| **Recording** | Nagranie | A provider-held artefact reference plus transcript pointer and score | `connect_quality.recording` | retention-bound |
| **Wallboard** | Wallboard | The live queue and team view | derived, SSE | live |

### 1.4 Domain Model

#### 1.4.1 Entity fields — changes from v2

v3 keeps v2's entity set with the corrections below. Unchanged entities
(`connect_conversation`, `connect_contact_identity`, `connect_intent`, `connect_handoff_rule`,
`connect_knowledge_gap`, `connect_campaign*`, `connect_quality.*`) carry v2's definitions.

**`auth.User` — new column (upstream, module `auth`)**

`principal_kind` (select, req, default `human`): `human` | `system_bot` | `integration`.
Additive with a migration defaulting existing rows to `human`. **An author that cannot be
resolved to a row is never treated as `human`** — the hub's system-user fallback is a sentinel
UUID with no `auth.users` row, so the null case must fail closed. Ships as **upstream PR D**.

**`connect_case` — corrections**

- `first_responded_at` **removed**. The single home is `connect_sla_case_clock.responded_at`
  (see below). v2 declared it in three places.
- `possible_duplicate` is **a tag**, not a status — the status enum stays frozen as v2 declared it.
- `split_reason` (select, req when split) ships in the **same migration** as `split_from_case_id`.
- `closed_at` is set only by the transition declared in §1.4.3 inv 7b.

**`connect_sla_case_clock`** *(module `connect_sla`)* — `case_id` · `generation` (integer, req) ·
`sla_policy_version_id` (relation, req) · `response_due_at` · **`responded_at`** (immutable once
set; **the only home for first-response**) · `resolution_due_at` · **`response_paused_seconds`**
(integer, always 0 — reserved) · **`resolution_paused_seconds`** (integer) · `outcome` (select:
`open` | `met` | `breached` | **`merged`** | **`superseded`**) · `superseded_by_case_id` (relation).

> **Phase 1 has no `connect_sla`.** It therefore does not stamp a first response at all; WF6-1
> records inbound/outbound timestamps and Phase 2 derives `responded_at` from them on enable
> (§7 Phase 2 backfill). v2 shipped the column on `connect_case` in Phase 1 and would have had
> to migrate a hot column in Phase 2 — the outcome it pre-shipped columns to avoid.

**`connect_case_touch`** *(module `connect`, new — v2 referenced it in the AHT formula and never
declared it)* — `case_id` (req) · `user_id` (req) · `started_at` · `ended_at` ·
`active_seconds` (integer, system) · `source` (select: `inbox_focus` | `explicit_open` |
`call_leg`). Captured on pane focus/blur with an idle cut-off at
`settings.touch_idle_cutoff_seconds`.

**`connect_ai_action_execution`** *(module `connect_ai`, new — v2 declared ten money-moving
actions with no execution record)* — `case_id` (req) · `action_key` (req) · **`idempotency_key`
(text, req, unique)** · `request_payload` (json) · `state` (select, req: `requested` | `applied`
| `failed` | `compensated` | `manual_reversal_required`) · `external_ref` (text) · `error_code`
(text) · `compensating_command_key` (text) · `acted_by_user_id` (req) · `acted_at`.
`connect_ai_suggestion.outcome` gains `executed` and `execution_failed`.

**`connect_cost_input`** *(module `connect_analytics`, new — cost per contact had two undeclared
inputs)* — `period_start` · `period_end` · `cost_type` (select, req: `agent` | `channel` | `ai`) ·
`channel_id` (nullable) · `amount_minor` (integer, req) · `source` (select: `manual` |
`provider_invoice`).

**`connect_tenant_settings`** — modelled as **typed columns**, not a key/value table (Phase 1 was
right; schema is ADDITIVE-ONLY-frozen from the first migration). New keys:
`auto_close_after_days` (integer, 14) · `touch_idle_cutoff_seconds` (integer, 120) ·
`case_attach_window_minutes` (integer, 1440, **floor 60**) · `presence_idle_warn_minutes`
(integer, 10). **Removed to their proper grain:** `offer_timeout_seconds`,
`offer_decline_limit`, `presence_timeout_seconds` move to `connect_service_queue`;
`identity_confidence_threshold` becomes a **per-`handle_type` map**;
`intent_confidence_threshold` becomes the tenant *default*, overridden by
`connect_intent.confidence_threshold` (nullable).

> **Why per-`handle_type`.** One global 0.85 spans evidence of incomparable strength: an exact
> e-mail match is deterministic; a phone number is routinely shared (WF3 edge 1, "the worst
> failure this app can produce"); a social ID is opaque and page-scoped. A single threshold safe
> for phone makes e-mail needlessly manual, so an admin tunes it *down* to clear the backlog.

**`connect_service_queue`** — gains `offer_timeout_seconds`, `offer_decline_limit`,
`presence_timeout_seconds`, `default_priority`, `staffing_target`. `skill_tags` is matched
against `staff.StaffTeamMember.tags` — the queue declares *required* skills, the member declares
*held* skills; these are two sides of a match, not a duplication.

**`connect_business_calendar`** *(module `connect_sla`, **reinstated**)* — `name` (req) ·
`timezone` (text, req, IANA) · child `connect_business_window` (`weekday` 0–6, `start_time`,
`end_time`) · child `connect_business_holiday` (`date`, `label`). See §4.5 for why `planner`
cannot serve this.

#### 1.4.2 Invariants

Each names the module that **writes** the constrained column, and its behaviour when that
module is absent (R0.2).

| # | Invariant | Writes | If module absent |
|---|---|---|---|
| 1 | `sla_case_clock.responded_at` is stamped once per generation and is immutable | `connect_sla` | No first-response measurement; WF6-1 records raw timestamps for later derivation |
| 2 | Only a message whose author has `principal_kind = 'human'`, or an AI draft with a non-null `acted_by_user_id`, stamps `responded_at`. An unresolvable author is **never** `human` | `connect_sla` | N/A |
| 3 | A Conversation has exactly one parent Case. Merge re-parents and sets `merged_into_case_id`; split creates a child with `split_from_case_id` and a reason | `connect` | core, always present |
| 4 | **No re-parenting operation resets an SLA clock.** A split child inherits the parent's `generation`, `sla_policy_version_id` and `response_due_at`; only the resolution clock may restart. Merge closes the loser's clocks with `outcome = 'merged'`, excluding them from attainment, and sets `superseded_by_case_id` | `connect_sla` | N/A |
| 5 | No message with an AI origin and no `acted_by_user_id` reaches a customer, except in a Conversation whose `owner` is still `bot` **at the instant of append**, re-evaluated inside the append transaction | `connect` | core |
| 6 | `conversation.owner` goes `bot → agent`, never back | `connect` | core |
| 7a | A Case cannot reach `resolved` with an empty `wrap_up_note` | `connect` | core |
| 7b | **`resolved → closed`** is performed by a scheduled job after `auto_close_after_days` with no inbound, or by `POST /cases/{id}/close` with `connect.cases.manage`. Closing writes `closed_at` and emits `connect.case.closed` | `connect` | core |
| 8 | `agent_presence.current_case_count` is a **derived counter**, recomputed at offer evaluation and reconciled by a job — not a same-transaction mirror of a `connect` column. All assignment paths respect capacity and presence; a supervisor may exceed with `over_capacity_override` (select: `sla_risk` \| `vip` \| `manual`) | `connect_routing` | No capacity model; assignment is unconstrained and WF1 edge 4 uses the routing-disabled branch |
| 9 | An offer has one terminal status. `offer_decline_limit` consecutive declines **or** expiries flips the agent to `busy`; accepting resets | `connect_routing` | N/A |
| 10 | Confidence is never lowered automatically. Below the per-`handle_type` threshold, `customer_entity_id` stays null with `link_state = 'unresolved'` | `connect` | core |
| 11 | No campaign contact is attempted without a consent record valid for that channel type, re-checked **at dial time** | `connect_campaigns` | N/A |
| 12 | A recording without a preceding `recording_announced` event triggers a **provider-side delete** | `connect_quality` | N/A |
| 13 | Every Connect row carries non-null `tenant_id` and `organization_id` | all | — |
| 14 | A gated-off module removes its navigation and API surface, leaving data intact | `connect` (via `configs`) | core |
| 15 | A portal-visible Case belongs to the requesting `CustomerUser`'s `CustomerEntity`, enforced at runtime through `customer_accounts/lib/customerEntityOwnership.ts` on every portal route. Re-linking re-parents only Cases whose Conversations used that handle, requires a **preview-and-confirm**, is **undoable**, and calls `revokeAllUserSessions` **inside the re-link transaction** | `connect_portal` | No portal surface |
| 16 | **Every AI action execution carries a unique `idempotency_key`.** A retry with the same key is a no-op returning the original result. Actions declare a compensating command or `manual_reversal_required` | `connect_ai` | No action catalogue |

#### 1.4.3 Derived values

| Value | Formula | Anti-gaming |
|---|---|---|
| **Response SLA remaining** | `response_due_at − now`, on the business calendar | **The response clock never pauses.** v2 added `paused_seconds` to the response due date while stating pause was resolution-only. The correct justification is not v2's ("`waiting_customer` requires an outbound message") — a bot clarifying question, a failed send, and an agent awaiting a carrier all put a Case in `waiting_customer` with no human response. The real reason: **the response clock measures time-to-human-response, and customer latency does not excuse it** |
| **Resolution SLA remaining** | `(resolution_due_at + resolution_paused_seconds) − now`, on the business calendar | Pause accrues only in `waiting_customer` and only after an outbound message asked the customer something. **Out-of-hours is handled by the calendar only** — v2 also paused at the window boundary, double-crediting every overnight |
| **FCR** | resolved Cases with one Conversation, or all Conversations sharing one contact identity, and no `case_reopen` row, ÷ resolved Cases; excluding `split_from_case_id` children | The reopen clause is simplified — v2's "within `reopen_window_days`" was vacuous, since OQ-7 makes every reopen row within its window by construction. **Snapshots declare an FCR maturity date** and re-version when a reopen lands against a closed period |
| **AHT** | `Σ(case_touch.active_seconds) + wrap_up_seconds` over agent-touched Cases | Cases with no human message are excluded. Split children collapse into the parent, as for cost |
| **Containment** | Cases with **≥1 bot outbound message**, `human_agent_message_count = 0` and no `handed_off_at`, ÷ all Cases | v2's numerator omitted the bot-message requirement, so an **unanswered or abandoned Case scored as contained** — containment rose as the queue backed up. Cases with no outbound message at all are reported separately as **unanswered**. Paired with **bot coverage** (Cases whose intent is in the enabled catalogue ÷ all Cases) so disabling hard intents is visible |
| **Suggestion acceptance** | `inserted_*` ÷ suggestions with non-null `shown_at`; `expired` counts as non-acceptance | Paired with **suggestion coverage** (Cases with ≥1 suggestion shown ÷ agent-touched Cases), because suppressing generation on hard cases lifts acceptance exactly as suppressing bots lifted containment. `inserted_edited` records a `retained_ratio`; below a stated floor it scores as rejection |
| **Cost per contact** | `(agent hours × rate + channel spend + AI spend) ÷ Cases`, from `connect_cost_input`; split children collapse | Splits are audited with a reason and a per-agent split-rate metric. **`case_attach_window_minutes` is governed**: floor 60, an audit entry per change, and a KPI-snapshot annotation — lowering it fragments threads and moves cost, containment and FCR at once, more cheaply than the split lever v2 closed |
| **Abandoned queue rate** | **Not computable** — needs a per-channel abandonment signal no adapter emits | OQ-14 |

#### 1.4.4 Access control

Feature keys follow `<module>.<resource>.<verb>` **without exception** — v2's Phase 1 froze
`connect.analytics.view` against §1.4.5's `connect_analytics.view`.

`connect.inbox.view` · `connect.inbox.handle` · `connect.cases.view.all` ·
`connect.cases.manage` · `connect.settings.manage` · `connect_sla.policies.manage` ·
`connect_routing.queues.manage` · `connect_routing.presence.manage.others` ·
`connect_routing.wallboard.view` · `connect_analytics.view` · `connect_analytics.view.agents` ·
`connect_ai.suggestions.use` · `connect_ai.actions.<key>` · `connect_bots.intents.manage` ·
`connect_bots.gaps.manage` · `connect_quality.recordings.listen` ·
`connect_quality.scorecards.review` · `connect_quality.scorecards.view.own` ·
`connect_campaigns.view` / `.manage` / `.run`.

Cross-org visibility: none.

---

## 2. Identity Model `PM`

Unchanged from v2 except as noted. Personas: **service agent** (`connect_agent`, direct
evidence), **supervisor** (`connect_supervisor`, inferred), **CX manager** (`connect_manager`,
inferred), **service admin** (`connect_admin`, inferred — the prototype's only admin evidence is
a B2B *agent* editing an IVR flow), **customer** (`portal_customer`, external, direct),
**anonymous visitor** (no identity, direct), **Bot Mercato** (system principal, no login).

**Change in v3:** the bot's `auth.User` row now carries `principal_kind = 'system_bot'`, and the
hub's sentinel-UUID fallback is explicitly a **fail-closed** case for invariant 2. No sales-rep
persona — OQ-11 as narrowed admits win-back campaigns worked by existing service agents.

Portal decision: **USED**, per v2's decision tree.

---

## 3. Workflows `PM`

Seven workflows as v2. Per-workflow ROI figures are attributions of §1.2.2's total.
Corrections in v3:

- **WF1** — edge 3 (failed send) now also states that the Case must not advance to
  `waiting_customer` on a failed send. New edge 8: an **AI action set half-applies** (shipment
  created, coupon issued, carrier claim 502) → the retry is idempotent on
  `action_execution.idempotency_key`, compensable actions are compensated, non-compensable ones
  are flagged `manual_reversal_required` and surfaced on the Case.
- **WF2** — intent reconciliation is stated as **unfalsifiable and therefore not used as
  evidence**: the prototype claims 12 intents and shows 5, so any base "reconciles" against a
  free 7-intent residual. The 38 % target stands on the KPI tile alone, and OQ-15 must define
  the seven before Phase 5.
- **WF4** — breach counts are computed on the **agent-touched** base, not all contacts:
  contained Cases have no human first response, so v2's "≈700 fewer breached" overstated by
  ~1.6×. Edge 3 is corrected — out-of-hours is calendar-only, never also paused.
- **WF5** — ROI re-derived against the **low-containment** intents (invoices 48 %, quality
  complaints 22 %), noting the complaints intent ships disabled so its full volume reaches an
  agent. Edge 6: the resolve guard aborts on any new Case **event**, not only a message.
- **WF6** — sampling is `business_rules`-**assisted**, not `business_rules`-driven: the engine has
  a closed operator set with no randomness or state, so a Connect sampling service computes the
  draw and passes it in as rule data.
- **WF7** — re-scoped to outbound **win-back to existing customers** plus service-outbound. The
  abandoned-cart ROI (1 840 × 41 % × 12.4 % ≈ 93 orders ≈ 28 000 PLN of *revenue*, not margin,
  on a campaign already 66 % complete in the fixture) is retained under the narrowed OQ-11.

---

## 3.5 UI Architecture `PM + UX`

Unchanged from v2 except:

- **The Inbox lists Cases, not Conversations.** v2's left pane was a conversation list with
  channel chips — which would show a phone→WhatsApp Case twice, breaking the product's central
  promise at its primary surface. Rows are Cases with a channel-badge cluster; the chip filter
  matches "any Conversation on channel X".
- **The routing footer card is replaced** by a per-case provenance line in the Inbox header.
- **`/backend/connect/channels` is costed** (§4) — v2 asserted US-A.1 in Phase 1 with no commit
  anywhere, while an empty state pointed at it.
- **Nav gating**: `customer` and `channels` screens have no module key in the prototype; they are
  gated by `connect` (core) and `connect.settings.manage` respectively.
- Six dashboard widgets, with **`appendWidgetsToRoles` seeding** as an explicit step — the widget
  contract has no role dimension.
- Portal events carry an explicit `recipientUserId`; `connect.shipment.updated` is **not**
  Connect's to emit.
- The integrations table drops the "Open Mercato ERP" row (OQ-10); the AI rules panel drops the
  residency line (OQ-12).

---

## 4. Gap Analysis `Architect`

### 4.5 Platform corrections

| Capability | v2 said | v3 says |
|---|---|---|
| **`planner`** | "**use** — replaces `connect_business_hours` entirely"; OQ-5 retired; enshrined in §9 as the anti-pattern | **Cannot serve.** `lib/availabilityMerge.ts:135` expands weekly as `cursor + 7 * DAY_MS`, a fixed millisecond step that cannot hold local wall-clock across DST; `timezone` appears **zero times** in the merge engine; `BYDAY` is written by `commands/availability-weekly.ts:89` and never parsed, so `BYDAY=MO,WE,FR` expands as Monday only; only `FREQ=DAILY\|WEEKLY` are accepted and anything else is silently dropped; holidays are per-rule `exdates` with no calendar-wide model; writes throw `403 staff_module_not_loaded` without `staff`; and the tests pass only because they pin `TZ=UTC`. **`connect_business_calendar` is reinstated** (§1.4.1). **§9's anti-pattern line is deleted.** OQ-5 returns as a design choice: build in `connect_sla`, or contribute tz-correct expansion upstream to `planner` |
| **`messages` outbound** | "widen `sendAsUser` with `allowSharedChannel`", 1 commit | **A scoped workstream, 8–12 commits.** v2's stated gap ("new conversation has no path") is false — `send-as-user.ts:191-236` creates both the `ExternalConversation` and the `ChannelThreadMapping`. The real blockers: credentials are per-user and nothing writes a `user_id IS NULL` row; from-address comes from the credential blob (`fromAddress` / `'me'`), not the channel; no path creates a shared channel; `senderUserId` is NOT NULL. A caller-supplied boolean is itself an escalation vector — delegate to `assertCanManageChannel`, whose shared branch already requires an elevated feature |
| **`customers` projection** | a **new** public command | **Use the existing `customers.interactions.create` with a stability commitment.** v2's premise ("no external callers") is false — `example_customers_sync/lib/sync.ts:854` already calls it cross-module via the bus. A new per-consumer handler would invert the platform's direction rule, making the depended-on module carry its consumer's vocabulary |
| **Unidentified Cases** | resolve → projection, unconditionally | **`CustomerInteraction.entity` is non-nullable** and `requireTimelineParentEntity` demands `kind ∈ {person, company}`, so an unidentified Case **cannot project**. *(Author recommendation — owner may override.)* v3 **stages and backfills**: the Case resolves normally, a `connect_pending_projection` row is written, and linking the identity later drains it. This needs no change to the reference module and mirrors the pattern `2026-04-21-crm-call-transcriptions.md` proposes. Alternatives rejected: blocking resolve (holds a solved Case hostage to a data-quality task), auto-creating a shell `CustomerEntity` (pollutes the CRM), and making `entity_id` nullable (a reference-module schema change needing sign-off) |
| **Per-tenant module gating** | new `connect_module_state`, 6 commits | **`configs.ModuleConfig`** (`module_id` + per-tenant unique indexes) **+ `page.meta.visible`**, with `sales/backend/sales/channels/page.meta.ts` as the shipped precedent. **2–3 commits.** v2's supporting claim ("only consumers are tests and `customers/setup.ts`") is refuted by `sales`, `portal`, `wms` and `customers/lib` |
| **Placement / CI gates** | `packages/` "sits inside the gates" | **Inverted.** Two of four optimistic-lock gates are workspace-wide; the **entity-level `updated_at` gate is the curated `packages/core`-only one**, so `packages/connect*` misses precisely the gate §9 leans on. v3 adds each `connect*` entity to that curated map as an explicit line item |
| **`business_rules`** | predicates only | Confirmed — no randomness, no state, no first-match-wins, and every non-dry-run execution writes a log row on the inbound hot path |
| **`workflows.UserTask`** | fields exist, nothing writes them | Confirmed |
| **`record_locks`** | "evaluate", extension point `enforceCommandOptimisticLockWithGuards` | That helper is **OSS shared code** with 31 call sites; the *module* is Proprietary and this spec is OSS. Consume the DI seam, never import. Separately, its **participant model** (heartbeat + TTL + `activeParticipantCount` + force-release) is the closest shipped analogue to agent presence — a template for `connect_routing` |
| **`staff`** | "extend", `StaffTeamMember.tags` as skills | **use, read-only.** `tags` is *not* exposed by the assignable route, and importing the entity is forbidden. Either extend the route's projection upstream, or carry queue-side skills only |

### 4.6 Extend, don't parallel `R0.4`

Both rounds found the schedule is won here, not in estimate tuning.

| Shipping capability | v3 decision |
|---|---|
| **`inbox_ops`** — inbound webhook with secret, dual dedupe (`messageId` + `contentHash`), per-tenant rate limiting, signature/quote stripping, thread reconstruction, contact matcher, review queue, 14 integration specs | **Extend.** v2 treated it only as a coexistence conflict. Connect's inbound path reuses its parser, dedupe and `lib/rateLimiter.ts` — which is exactly Phase 1's R1 per-sender window |
| **`messages`** — threading, `idempotency_key`, per-recipient read/archive state, unread counts, bulk-action inbox UI, and **pluggable message-type + message-object registries** | **Extend.** "Conversation" becomes a registered message type, not a fork |
| **`communication_channels`** — `ExternalConversation.assigned_user_id`, an **undoable reassign command**, an assign route with its own ACL, and a thread-matcher with strategies and confidence scoring | **Extend.** v2 specced assignment and transfer from nothing |
| `configs` + `page.meta.visible` | Replaces `connect_module_state` |
| `perspectives` | Saved Inbox/queue views, per-user and per-role, free |
| DataTable bulk actions + `progress` | Bulk case operations with top-bar progress |
| `notifications` (definitions, renderers, reactive handlers, `useNotificationEffect`) | SLA warnings, handoffs, escalations |
| `communication_channels/setup.ts` per-org scheduler tick | The precedent for breach and reconciliation workers (note the **60 s interval floor**) |

**Genuinely absent, correctly costed:** agent presence; SLA clocks and a tz-correct business
calendar; canned responses; **auto-responder/DSN detection** (nothing parses `Auto-Submitted` or
`Precedence` today); a generic live-count hook; wallboard metrics.

### 4.7 FROZEN-surface freeze list `R0.5`

**Superseded by [`app-spec-notes/frozen-surfaces.md`](app-spec-notes/frozen-surfaces.md), which
is the single source of truth.** Where this document disagrees with that file, that file wins.

Round 3 found this section frozen event IDs at three different values across three documents,
named widget spots to a `sales` pattern whose shipped regex rejects them, hid ten DB-stored ACL
IDs inside a `<key>` wildcard, omitted `connect_portal`'s features entirely, and left out four
`BACKWARD_COMPATIBILITY.md` categories (import paths, DI names, notification IDs, AI tool IDs).
The canonical file settles all of it: **16 module/package IDs, 10 Phase-1 event IDs, 36 ACL
feature IDs, 4 new widget spots + 1 declaration, 9 DI keys, 7 notification IDs, 9 AI IDs.**

### 4.8 Estimate

| | Raw | With §4.6 adoption |
|---|---:|---:|
| v1 | 116 | — |
| v2 | 233 | — |
| **v3** | **393** | **205–268** (central ≈ 237) |

The raw figure follows round 2's reassessment: 233 implied ~690 insertions per commit, coarser
than every module in the repo bar one and ~4× coarser than this plan's own atomic definition.
Two systematic under-counts are corrected — one integration-test commit per workstream against a
repo where test code is 26–104 % of source, and zero post-landing fix budget against WMS's 63 %
`fix()` ratio.

**The §4.6 adoption is worth 125–188 commits** and is the reason v3's effective figure lands
near v2's raw one — for entirely different reasons than v2 gave.

Detailed plan: `app-spec-notes/commits-by-workflow.md`, regenerated for v3.

**Phases (raw):** 1 → 85 · 2 → 45 · 3 → 109 · 4 → 36 · 5 → 28 · 6 → 25 · 7a → 36 · 7b → 26 ·
gating 3. **303 raw to production-ready (Phases 1–5)**, ≈ 180–230 effective.

> Phase 1's *named* commit list is 40; its raw estimate is 85. The difference is 18 upstream PR
> commits plus ~27 of test and fix weight. v1 and v2 both estimated by enumerating the
> happy-path diff and stopping — the named list is that diff. **40 is the design checklist; 85
> is the schedule.**

---

## 5. User Stories `PM`

v2's 27 stories, plus: **US-1.9** close a Case (inv 7b) · **US-1.10** recover a half-applied
action set · **US-3.5** re-link with preview-and-confirm, undoable · **US-A.3** record monthly
channel and AI spend. US-0.2's seed uses **two** service queues from the fixture (Zwroty i
reklamacje, Status zamówienia); v2 invented two more from intent names, which had no
`waiting`/`longest`/`agents`/`sla` fixture data for the wallboard to render.

---

## 7. Phasing `PM`

Order unchanged from v2 (the channels-before-AI swap held up: the 2.9× over-claim arithmetic
verified). Changes:

| Phase | Change from v2 |
|---|---|
| 1 | **No `first_responded_at` column.** WF6-1 records raw inbound/outbound timestamps. Adds the channels admin page (US-A.1), `principal_kind` as upstream PR D, and `possible_duplicate` as a tag. **40 commits** (v2 said 39 while its own plan ran 40) |
| 2 | Adds the `connect_business_calendar` work `planner` cannot do, the `responded_at` **backfill** from Phase 1's timestamps, and the `current_case_count` **backfill** — without which every agent is over-pushed on the day routing is enabled. Ships `connect_sla` + `connect_analytics`; **`connect_routing` moves to Phase 3** |
| 3 | Live channels **and** `connect_routing` — the prototype's own dependency is *"telefonia lub chat"*, and v2's e-mail-only Phase 2 wallboard would have shipped a channel-share chart with one bar at 100 %. Exit gate restated: **≥ 73 % of the 44 060 base** (v2 set ≥74 % against a 73.88 % ceiling the previous review had already measured) |
| 4–7b | Unchanged, plus `connect_ai_action_execution` in Phase 4 and the WF7 re-scope in 7b |

**Upstream PR order (binding):** A `communication_channels` shared-channel workstream → B
`customers` stability commitment + `customers`/`sales` injection spots → **D `auth.principal_kind`**
→ C `connect` + `channel-webform`.

---

## 10. Open Questions `PM`

| # | Status |
|---|---|
| OQ-1 | OPEN — OSS vs enterprise packaging for quality and voice |
| OQ-2 | **OPEN, BLOCKER for 7a/7b** — telephony provider. Voice is 8 410/month, 19 % of the 44 060 base |
| OQ-3 | OPEN — re-baseline, including the **inbound/outbound split** that makes §1.2.1 a range |
| OQ-4 | DECIDED — `en` key space, `pl` complete from Phase 1 |
| **OQ-5** | **RE-OPENED** — build the business calendar in `connect_sla`, or contribute tz-correct expansion upstream to `planner`? v2 retired this question on a false premise |
| OQ-6 | DECIDED — annotated IVR list, not a graph editor |
| OQ-7 | DECIDED — in-place reopen within 7 days, new clock generation |
| OQ-8 | OPEN — retention for recordings, transcripts and encrypted bodies |
| OQ-9 | RESOLVED — two review rounds run; both were necessary |
| OQ-10 | DECIDED — in-instance only |
| **OQ-11** | **NARROWED in v3** — lead qualification, quoting and sales-rep assignment are out; outbound win-back to existing customers is in. **Owner may override** |
| OQ-12 | DECIDED — any provider under a DPA; residency promise withdrawn |
| OQ-13 | DECIDED — nine units |
| OQ-14 | OPEN — no adapter emits an abandonment signal |
| OQ-15 | OPEN — the seven undocumented intents; the 38 % containment target depends on them |
| **OQ-16** | **NEW** — what does an unidentified Case project? v3 recommends stage-and-backfill. **Owner may override** |

---

## Changelog

### 2026-08-21 — v3

- Incorporated review round 2 (`app-spec-notes/independent-review-register-v2.md`): 25 critical,
  36 major, across three reviewers.
- **Added §0 Evidence rules.** Both rounds found the same failure in different forms; R0.1–R0.5
  exist so a third round finds a third variant, not the same one.
- **Reversed v2's `planner` decision.** The engine is UTC-only, DST-incorrect and `BYDAY`-blind.
  `connect_business_calendar` is reinstated, OQ-5 re-opened, and §9's anti-pattern line — which
  taught the wrong lesson from the wrong example — deleted.
- **Declared `principal_kind`** on `auth` as upstream PR D, with fail-closed semantics for the
  hub's sentinel user. v2 depended on a column that existed nowhere.
- Corrected the SLA formulas (response never pauses, with the *real* justification; resolution
  pause and the business calendar no longer double-credit out-of-hours), containment's numerator,
  acceptance's coverage counter-metric, FCR's vacuous clause, and the cost governance around
  `case_attach_window_minutes`.
- Declared `connect_case_touch`, `connect_ai_action_execution`, `connect_cost_input`,
  `connect_business_calendar`, `auto_close_after_days`, `over_capacity_override` and
  `presence_idle_warn_minutes`; gave `closed` a transition (inv 7b); moved offer/presence timings
  to the queue and identity thresholds to a per-`handle_type` map.
- **Published the contact base as 44 060 with a 28 590–40 960 inbound range**, dropped the
  cherry-picked chart corroboration, and restated the consolidated claim as "≈48 500 PLN/month,
  **of which** 1.2–1.8 FTE" rather than a sum.
- **Adopted §4.6 Extend-don't-parallel**: `inbox_ops`, `messages` registries,
  `communication_channels` assignment, `configs`, `perspectives`, bulk actions + `progress`,
  `notifications`, the hub's scheduler-tick precedent.
- Re-scoped: `allowSharedChannel` → an 8–12 commit workstream; `connect_module_state` → 2–3
  commits on `configs`; estimate 233 → ~390 raw, ~225–260 with adoption.
- Moved `connect_routing` to Phase 3; restated the Phase 3 gate against a named base; added
  Phase 2 backfills for `responded_at` and `current_case_count`.
- Narrowed OQ-11 to admit outbound win-back — under v2's wording every seeded campaign was out
  of scope, including the one funding WF7's ROI. Opened OQ-16.

### 2026-08-21 — v2
Superseded. See `independent-review-register-v2.md` for what it got wrong.

### 2026-08-21 — v1
Superseded; retained at `2026-08-21-app-spec-mercato-connect.v1.md`.

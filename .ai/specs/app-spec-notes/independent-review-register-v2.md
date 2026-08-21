# Independent review register — App Spec v2

**Under review:** `.ai/specs/2026-08-21-app-spec-mercato-connect.md` (v2) + `.ai/specs/2026-08-21-connect-phase-1-one-inbox.md`
**Date:** 2026-08-21 · **Supersedes nothing** — this is the second review round; round 1 (on v1) is `independent-review-register.md`

| Reviewer | Findings |
|---|---|
| DDD (fix verification + v2-only content) | 11 critical, 18 major, 8 minor, 10 rejected |
| Architect (platform behaviour) | 6 critical, 9 major, 15 missed capabilities |
| PM/UX (numbers + cross-document) | 8 critical, 9 major, 11 minor |

**Verdict: v2 is a genuine improvement that must not be implemented as written.** Round 1's
findings were largely addressed — but the *methodology* failure recurred on the single largest
architectural decision, and four "fixes" are papered over.

---

## 1. Verified first-hand by the author

| Claim | Verdict | Evidence |
|---|---|---|
| **`planner` cannot express business hours** | **CONFIRMED** | `availabilityMerge.ts:135` — `cursor + 7 * DAY_MS`, a fixed 604 800 000 ms step that cannot hold local wall-clock across DST. `timezone` appears **0 times** in the file. `BYDAY` is written by `availability-weekly.ts:89` and **never parsed**. Tests pass only because `__tests__/availabilityMerge.test.ts:1` sets `process.env.TZ='UTC'` |
| **`principal_kind` does not exist** | **CONFIRMED** | `grep -rn "principal_kind\|principalKind" packages/ apps/` → **0 hits**. `auth` appears **0 times** in v2's §4.5 capability table |
| **The SLA formula is newly self-contradictory** | **CONFIRMED** | §1.4.4 l.454 reads `(clock.response_due_at + clock.paused_seconds) − now` in the same cell that says "pause applies to the **resolution** clock only" |
| **`closed` has no transition into it** | **CONFIRMED** | `closed_at` appears twice; zero `/close` endpoints, zero `auto_close_after*` settings across both specs |
| **`configs.ModuleConfig` already does per-tenant module config** | **CONFIRMED** | `configs/data/entities.ts:22` `module_id`; partial unique indexes for global and tenant-scoped rows at `:8`,`:13` |
| **The channel-mix "confirmation" is cherry-picked** | **CONFIRMED** | Computed against 40 960: SMS 31.25≡31 ✓, phone 20.53≡21 ✓, WhatsApp 10.40≈11 ✓, **e-mail 14.94 vs 16 ✗, chat 13.38 vs 14 ✗, social+forms 9.50 vs 7 ✗**. No single denominator fits; the chart is hand-authored |

### Reviewer disagreement, adjudicated

DDD **rejected** PM/UX's C1 (the 34 750 base), calling §1.2.1 "the strongest section in the
document". **PM/UX is right and DDD under-tested it.** DDD verified that the arithmetic chain
reconciles; it did not test (a) whether the subtraction rule was applied consistently across all
four `CAMPAIGNS` rows, or (b) the `BARS` cross-check. Both fail:

- WhatsApp's own fixture reads `detail:'Szablony zatwierdzone, **wysyłka kampanii**, potwierdzenia dostaw'`, and the phone channel runs a predictive dialer — so by v2's own rule their volumes also contain outbound. Applied consistently: **28 590–31 074**, not 34 750.
- `BARS` (the prototype's own weekly contact counter) totals 10 210/week → **44 243/month**, within 0.4 % of the full 44 060 and **27 % above** v2's ROI base.

**Conclusion: v1's error was a wrong subtotal; v2's is a selectively-constructed one. Same category, subtler form.**

---

## 2. Critical — must be settled before Phase 1's first migration

### 2.1 Blocking on FROZEN surfaces

| # | Defect | Fix |
|---|---|---|
| **B1** | **`principal_kind` is invented.** Invariants 1, 2, `human_agent_message_count`, containment, FCR and Phase 1's `first_responded_at` all hinge on it. It exists nowhere; `auth` is not a declared dependency; zero commits; absent from Phase 1's BC audit. Worse, its premise is false — `system-user.ts` is fail-soft and falls back to a sentinel UUID **with no `auth.users` row**, so the join yields NULL and the null case is unspecified. Treat NULL as human and every bot reply stamps `responded_at` → SLA reads ~99 % with no human involved: **the exact v1 defect, reintroduced through its own fix** | Add `auth` to §4.5 as **extend**; specify `principal_kind` as an additive column with a migration; cost it; add it as upstream PR **D**; state that an unresolvable author is never `human` |
| **B2** | **`first_responded_at` has two homes.** Phase 1 ships it on `connect_cases` (module `connect`); §1.4.3 homes it as `connect_sla_case_clock.responded_at` (module `connect_sla`, Phase 2); §1.3 calls it `case.first_responded_at`. Three-way, on an ADDITIVE-ONLY surface | Decide now. Phase 2 otherwise duplicates a timestamp or migrates a hot column — the outcome Phase 1 pre-ships columns to avoid |
| **B3** | **ACL key drift.** Phase 1 freezes `connect.analytics.view`; §1.4.5 says `connect_analytics.view`. Phase 1 cites §1.4.5 in the same line it contradicts it, under a heading that says renames need a data migration | Use `connect_analytics.view` |
| **B4** | **`closed` is in the FROZEN status enum with no transition into it.** No actor, trigger, timeout, setting or endpoint. Cascades: §1.3 defines the Case period as "until `closed_at`"; `outbound_suppression_hours_after_close` and WF7 edge 2 never engage, so the consent-adjacent suppression rule is dead; US-0.2 seeds "all six statuses", one unreachable | Declare the transition, or delete `closed` from the enum |

### 2.2 Architecture

| # | Defect |
|---|---|
| **A1** | **`planner` cannot express business hours** (verified above). v2 deleted `connect_business_hours`, retired OQ-5, and enshrined the deletion in §9 as *the* anti-pattern example — on artefact existence, not behaviour. **This is v1's exact failure mode, repeated on v2's largest decision and written into the quality gate.** Reinstate a costed work item: tz-aware expansion, write-time tz interpretation, real `BYDAY`/`INTERVAL`/`UNTIL`, a calendar-wide holiday model, a tenant-scoped loader, `businessMillisBetween()`, DST tests, and decoupling availability writes from `staff` (`planner/api/access.ts:47` throws `403 staff_module_not_loaded`). Delete or invert the §9 line |
| **A2** | **`allowSharedChannel` is under-scoped and the named gap is the wrong one.** "New conversation has no path" is false — `send-as-user.ts:191-236` creates both the `ExternalConversation` and the `ChannelThreadMapping`. The real blockers are per-user credentials (nothing writes a `user_id IS NULL` row), from-address derivation (adapters read `credentials.fromAddress` / `'me'`), no path creating a shared channel, and `senderUserId` being NOT NULL. Also, a caller-supplied boolean is itself an escalation vector — delegate to `assertCanManageChannel`. **1 commit → 8–12** |
| **A3** | **An unidentified Case cannot be projected at all.** `CustomerInteraction.entity` is non-nullable `@ManyToOne`; `requireTimelineParentEntity` demands `kind ∈ {person, company}`. Phase 1 declares `customer_entity_id` nullable, renders "Nieznany kontakt", and asserts resolve → projection unconditionally in T9. **Neither spec noticed.** Pick: block resolve until linked / auto-create a shell entity / stage and backfill / make `entity_id` nullable (a reference-module schema change needing sign-off) |
| **A4** | **The projection command inverts the platform's direction rule.** `packages/core/AGENTS.md`: the depended-on module must not hard-require its consumer. Also "the create handler has no external callers" is **false** — `example_customers_sync/lib/sync.ts:854` already calls `customers.interactions.create` cross-module via the bus. What Connect needs is a stability commitment on the existing command, not a new handler. And `module-decoupling.test.ts` is a hand-written fixture with no static import-graph check — it provides **zero** enforcement for the nine-module split |
| **A5** | **`connect_module_state` is redundant.** `configs.ModuleConfig` (per-tenant, per-module) + `page.meta.visible` (`shared/src/modules/registry.ts:67`, resolved at `ui/src/backend/utils/nav.ts:307`) already do this, with `sales` as a shipped precedent. v2's supporting claim ("only consumers are tests and `customers/setup.ts`") is refuted by `sales`, `portal`, `wms`, `customers/lib`. **6 commits → 2–3** |
| **A6** | **The placement/CI-gate justification is false and inverted.** Two of four optimistic-lock gates are workspace-wide (`...ui-coverage-workspace.test.ts:163`, `...command-coverage.test.ts:75`); the **entity-level `updated_at` gate** is the curated `packages/core`-only one. Shipping under `packages/connect*` therefore **misses** the gate Phase 1's R7 and compliance table lean on |

### 2.3 Domain

| # | Defect |
|---|---|
| **D1** | **The SLA formula contradicts its own scoping** (verified). One `paused_seconds` per generation, added to the *response* due date while the prose says resolution-only. A Case that answered at 50 min reports 6 h of headroom; a breach at T+70 retro-scores compliant. Split into `response_paused_seconds` / `resolution_paused_seconds` |
| **D2** | **Split resets the SLA clock.** Inv 4 forbids reset on *transfer*; split is a different operation with no rule, and a child gets `generation = 0` with a fresh due date. A Case 19 min from breach is split, the child restarts at 60 min, the parent resolves inside its remainder → 2/2 compliant. v2 closed the cost vector and left the SLA one |
| **D3** | **Clock generations have no merge or split semantics.** Merge either strands the loser's `breached_response` as a phantom in the attainment denominator, or moves two `generation = 0` rows onto one Case, violating inv 1 |
| **D4** | **`connect_case_touch` is never declared** — one occurrence, inside the AHT formula that depends on it. AHT backs the 1.9 FTE claim and is a Phase 2 KPI tile. The cheapest substitute is v1's broken definition. Same class, still undeclared: `presence_idle_warn_minutes`, `over_capacity_override`, auto-close `N`, `possible_duplicate`, "channel spend", "AI spend" |
| **D5** | **Invariant 8 is a cross-module transaction with no backfill.** `current_case_count` is a `connect_routing` column; `assignee_user_id` is a `connect` column written by Phase 1's transfer endpoint, which exists **before `connect_routing` does**. At Phase 2 enable, presence rows start at 0 against 400 existing open Cases and every agent is immediately over-pushed. Make it derived and reconciled; declare the backfill |
| **D6** | **Invariant 15 spans modules, is enforced by a test, and ignores shipped code.** A CI test is a detective control, not a runtime guard — `customer_accounts/lib/customerEntityOwnership.ts` exists and is cited nowhere; `revokeAllUserSessions` ships and takes an `EntityManager` for transactional use, while WF5 edge 4 specifies lazy "next request" invalidation. Also re-link is not declared undoable, and a mistyped re-link moves a customer's entire history |
| **D7** | **Ten money-moving actions with no execution record.** `connect_ai_action_definition` declares no execution entity; the only audit is `connect_ai_suggestion.outcome`, which has no `executed`/`failed`/`partially_applied`. Fixture c1's three actions: shipment created (stock decremented), coupon issued, carrier claim 502 → agent retries → **second replacement shipment**. No idempotency key, no compensation, no saga. `prepareMutation` is an approval gate, not a transaction manager |
| **D8** | **`case_attach_window_minutes` is an ungoverned dial that moves three KPIs.** Lowering 1440 → 15 fragments threads: cost/contact falls ~26 %, containment and FCR both rise, all favourable, none real — and strictly cheaper than the split gaming v2 closed. Needs a floor, an audit entry, and a KPI-snapshot annotation |
| **D9** | **Containment counts service failures as successes.** `human_agent_message_count = 0 ∧ no handoff` scores an unanswered or abandoned Case as contained, so containment *rises* as the queue backs up. Require ≥1 bot outbound in the numerator; report never-answered separately |
| **D10** | **Every seeded campaign is out of scope by v2's own exclusions.** Abandoned carts = pre-sales (OQ-11, and owned by "Zespół Sprzedaż"); delivery notifications = "transactional notifications" (WF7's own boundary); VIP reactivation = marketing automation; NPS survey = survey collection. WF7's headline ROI is lead recovery in a spec that removed the sales queues and declared no sales-rep persona. `connect_campaigns` is 20 commits and a phase with **zero in-scope worked examples** |

---

## 3. Estimate

| Source | Total | Basis |
|---|---:|---|
| v1 | 116 | happy-path diff |
| v2 | 233 | measured LOC comparables |
| **Architect round 2** | **~390** (350–450) | 233 implies **~690 insertions/commit** — coarser than every module in the repo except one, and ~4× coarser than v2's own atomic definition. The `22 git commits` anchor measures dependency bumps: `channel-gmail` was created in **one** squash commit; only 1 of its 22 adds >1 000 lines |

Two systematic under-counts: **one integration-test commit per workstream** when test code is
26–104 % of source LOC across every comparable, and **zero post-landing fix budget** against
WMS's 63 % `fix(wms):` ratio.

**Offsetting — ~140–190 commits of avoidable work:** `inbox_ops` is already an e-mail→structured-action
pipeline with webhook secret, dual dedupe, per-tenant rate limiting, signature/quote stripping,
contact matcher, review queue and 14 integration specs (25–40). `messages` already has threading,
idempotency keys, per-recipient read/archive state, unread counts, a bulk-action inbox UI and
**pluggable message-type registries**, so "conversation" is a registration not a fork (30–45).
`communication_channels` already ships **conversation assignment and reassignment** with its own
ACL and an undoable command, plus a real thread-matcher with confidence scoring (20–30). Then
`configs`+`page.meta.visible` (4–6), `perspectives` saved views (8–12), DataTable bulk actions +
`progress` (10–15), the four-layer notification stack (15–20), `inbox_ops/lib/rateLimiter.ts` —
which is exactly Phase 1 R1's per-sender window (5–8), and the hub's own per-tenant scheduler
tick precedent (8–12).

**Genuinely absent, correctly costed:** agent presence; SLA clocks; canned responses;
**auto-responder/DSN detection** (nothing parses `Auto-Submitted`/`Precedence` today); a generic
live-count hook; wallboard metrics.

---

## 4. Fix-verification scorecard (round 1 → v2)

**Genuinely fixed (12):** volume base 7-vs-9 error · SLA row direction · identity nullable +
`link_state` · attach rule made decidable · handoff fallback summary · policy versioning ·
offer machine (`withdrawn`, declines-or-expiries) · invariants 5/6 re-homed with sound TOCTOU
reasoning · `UserTask` correction · `business_rules` predicates-only · `telemetry` removed ·
WF5 portal ROI (was 6× over, now reproduces exactly) · WF6 repeat-contact (was 4.3× over).

**Papered over (5):** reopen (model fixed, homing contradicts itself — §4.5 gives reopen to
`connect_sla`, the entity is in `connect`) · wrap-up gate (`resolved → closed` still undefined) ·
cost/split (cost vector closed, SLA and AHT vectors open, attach-window lever cheaper) ·
undeclared fields (8 remain) · re-link (scope right, enforcement is a test).

**Newly broken (3):** the SLA formula's scoping · `principal_kind` · invariant 8's cross-module
transaction.

**Wrong (1):** `planner`. The worst regression in v2.

---

## 5. The pattern

Round 1's diagnosis was: *the author verifies that platform artefacts **exist**, not that they
**do the job***. v2 fixed the arithmetic and repeated the methodology error on `planner` — then
wrote it into §9 as a lesson learned.

v2's own defect signature, across D1–D9: **the right mechanism is named, and the spec does not
say which module writes it, in which transaction, and what happens when that module is absent.**
Every one of the clock generations, invariant 8, invariant 15 and the action catalogue fails on
exactly those three questions.

# Adversarial spec review round 2 — DDD reviewer

**Role:** domain model, invariants, cardinality, formulas, glossary, aggregate boundaries, state machines.
**Target:** `.ai/specs/2026-08-22-connect-phase-1-v2.md` (line refs below are `v2:<line>`).
**Round-1 file:** `.ai/analysis/spec-pipeline/REVIEW-ddd.md` (5C/9M/7m). Peer reviewers' files were not read.
**Platform claims** cite files opened in this session.

---

## Part 1 — Regression check on my round-1 findings

| # | Round-1 finding | Verdict | Reason (pointing at v2) |
|---|---|---|---|
| C1 | Status machine stated as a total linear chain; `escalated` has no writer | **RESOLVED** | `v2:204-217` replaces the arrow chain with a from/to/trigger table and `v2:56-59` drops `escalated` + `escalation_reason` as unreachable in a queue-less phase. (The table's own gaps are fresh — F-C3.) |
| C2 | Reopen produces a Case that is simultaneously resolved and open | **PARTIAL** | `v2:216-217` clears `resolved_at`, increments `reopen_count` and writes a transition row — but "preserves `wrap_up_note` as a `connect_case_transition` payload" never says whether the **column** is cleared. If it survives, FR-004's non-empty gate (`v2:95`) is satisfied by the stale note on every later resolve and becomes a no-op. `wrap_up_seconds`, `first_agent_touch_at`, `last_agent_touch_at` still have no reopen post-condition, and no formula says whether `cases_resolved` counts `resolved_at` or transition rows. |
| C3 | "the same identity" / "open" undefined | **RESOLVED** | `v2:187-194` defines both: attach keys on `customer_entity_id` (cross-channel, as asked), "open" becomes the literal "not `closed`", and unresolved identities are explicitly isolated. The rule's new defects are fresh (F-C1, F-C2). |
| C4 | No transaction/consistency boundary; `conversation_count` on the lock target | **PARTIAL** | `v2:461-474` adds the § Consistency table — the "no boundary anywhere" half is fixed. The **second** half is not: `conversation_count` is still stored on `connect_cases` (`v2:317`, `v2:473`), `updated_at` still drives optimistic locking (`v2:304`), and **nothing exempts system/subscriber writes**. So every inbound attach and every T-WRK-02 delivery reconcile (`v2:470`, which writes Case `status`) bumps the version the agent's open Inbox pane holds and fires the conflict bar. The 30 s poll (`v2:256-259`) makes the collision window larger, not smaller. Add the exemption sentence or move the peer-driven counters off the locked row. |
| C5 | Timeout treated as rejection; `first_human_outbound_at` has no writer | **PARTIAL** | The positive writer now exists (FR-011 `v2:116-118` → T-WRK-02). The **indeterminate outcome does not**: `delivery_status ∈ {queued,sent,failed}` (`v2:330`) has no `unknown`, so a provider timeout is still forced into a binary and `retry_count` re-sends it — the duplicate-reply generator survives the rewrite (fresh F-C5). The **reader** is still missing: FR-019 (`v2:148-150`) and `connect_metric_daily` (`v2:351-353`) contain no first-response metric, while SC-005 (`v2:77`) claims "handle time". |
| M1 | `match_method` mandated with nowhere to go | **RESOLVED** | FR-013 (`v2:127-128`) + the `match_method` column (`v2:337`). The enumerated domain is still absent, but the seam is closed. |
| M2 | Unlink "audited"/"reversible" unsatisfiable; post-condition undefined | **PARTIAL** | `connect_identity_link_audit` (`v2:344-346`) fixes the history half. The live post-condition is still unstated: FR-015 (`v2:131-133`) sets `link_state='unresolved'` but never says what happens to `customer_entity_id` — the exact query trap M2 named. Worse, the retro-effect on already-written data is new and unaddressed (fresh F-C6). |
| M3 | Metrics: no storage, no period, no timezone, unreconstructible, gameable | **PARTIAL** | Storage exists (`connect_metric_daily`, `v2:351-353`, T-DATA-08, T-MET-01, plus a screen). Formulas, the day boundary/tenant timezone (`connect_tenant_settings` `v2:353-355` still has none), the recompute rule and the resolve→reopen→resolve counting question are all still open (fresh F-M3). |
| M4 | "duplicate-reply candidates" undefined; `possible_duplicate` tag unowned | **PARTIAL** | The tag claim is gone from T-TEST-02 (`v2:562`), so the untraced write is fixed. `duplicate_reply_candidates` is now a **stored column** (`v2:352`) and is still never defined anywhere in the document. |
| M5 | `organization_id NOT NULL` unsatisfiable from peer rows | **RESOLVED** | `v2:303-309` makes it nullable and cites `ingest-inbound-message.ts:201,213` — verified: the command writes `organizationId: input.scope.organizationId ?? null` for both the lookup and the create. (The read semantics this opens are fresh — F-M6.) |
| M6 | State machine bypassable through generic CRUD | **RESOLVED** | FR-024 (`v2:103-104`), the exclusion in `v2:395-396`/T-API-01, and T-TEST-15 (`v2:575`) asserting `PUT` cannot change status. |
| M7 | `case_value_minor` with no currency | **RESOLVED** | `case_value_currency` added (`v2:316`). No writer (fresh F-m5). |
| M8 | Window ordering invariant; "no inbound" measured on the wrong table | **PARTIAL** | (a) RESOLVED: `reopen_window_days <= auto_close_after_days` stated and validated (`v2:219-220`, T-VAL-01). (b) NOT: FR-005 (`v2:96-98`) names `connect_conversation.last_inbound_at`, which is **per conversation** while the worker closes **Cases** — the `max()` over the Case's conversations is still never written, and § Attach rule cond. 3 (`v2:192`) uses a bare unqualified `last_inbound_at` with no table and no aggregation at all. |
| M9 | Projection fails on a legitimately cross-org customer | **RESOLVED** | FR-027 (`v2:152`) + T-PROJ-01 (`v2:536`) + T-TEST-12 (`v2:572`). Verified the underlying hazard is real: `customers/commands/interactions.ts:386` calls `ensureOrganizationScope(ctx, entity.organizationId)` on the **entity's** org. |
| m1 | FR-001 and FR-012 contradict as universal statements | **UNRESOLVED** | FR-001 (`v2:88-89`) is still unqualified and FR-012 (`v2:119-120`) still absolute. The one-clause fix ("not suppressed under FR-012") was not applied. |
| m2 | Suppressed traffic is not suppressed from display | **UNRESOLVED** | T-TEST-03 (`v2:563`) still asserts only "No Case, no acknowledgement, counted as suppressed". Nothing says whether a DSN renders in the thread — and now that the thread comes from `communicationChannelsThreadReader` (`v2:243-247`) rather than from `connect`'s own rows, `connect` has *less* control over what appears. |
| m3 | Threshold comparison, `confidence` units, settings shape | **PARTIAL** | `confidence` is now `integer 0–100` (`v2:338`) — units fixed. Still open: the boundary case (`>=` vs `>`) on a gate R2 rates Critical; what a human-verified link writes; and the per-`handle_type` threshold map is still asserted to live in a table of "typed columns" (`v2:353-355`) over a 7-value enum, which needs seven columns or a typed JSONB column. |
| m4 | Phase-1 nulls have no enforcement | **UNRESOLVED** | `service_queue_id` is still "always null in Phase 1" (`v2:53`, `v2:313`) with no validator exclusion, no CHECK and no test; `merged_into_case_id`/`split_from_case_id` still ship unused (`v2:319`) with no tombstone invariant, so Phase-1 lists, counts and the FR-022 interceptor are still written without an exclusion for them. |
| m5 | Derived counters with no writer | **UNRESOLVED** | `human_agent_message_count` (`v2:325`) and `wrap_up_seconds` (`v2:317`) still appear only in the column list — no FR, no task, no definition. This now costs more than in round 1, because SC-005 (`v2:77`) sells "handle time" as a deliverable and no column stores it. |
| m6 | `/metrics/baseline` guarded by `connect.cases.view.all` | **UNRESOLVED (by decision)** | `v2:412-413` keeps the overload and labels it "documented, not a new ID". The round-1 objection was not the naming but that the grant **narrows** when `connect_analytics.view` ships — a behaviour change on a FROZEN ACL surface. § Migration (`v2:583-596`) does not record it. |
| m7 | `external_conversation_id` overloaded; unique key possibly wrong | **UNRESOLVED — and now provable** | `v2:323` resolves the type ambiguity in the **breaking** direction: "text — the hub's external ref", with unique `(tenant_id, external_conversation_id)` (`v2:327`). The hub's own uniqueness is `@Unique(['channelId','externalConversationId'])` (`packages/core/src/modules/communication_channels/data/entities.ts:180`), so the same provider thread ref legitimately exists on two channels of one tenant and `connect`'s narrower key rejects the second — which is also the key R7 (`v2:456`) relies on for idempotency. Add `channel_id` to the unique. |

**Regression tally: 7 RESOLVED · 8 PARTIAL · 6 UNRESOLVED (of 21).**

---

## Part 2 — Fresh findings on v2

### Critical

#### F-C1 — The attach predicate is existential, not unique: FR-001's "exactly one Case" has no selection function, and the predicate carries no tenant/org term

**Location:** § Attach rule (`v2:187-197`), FR-001 (`v2:88-89`), index `(tenant_id, customer_entity_id, status)` (`v2:320`).

**Defect (a).** Condition 2 reads *"**a** Case exists for that `customer_entity_id` whose status is not `closed`"*. That is an existence test over a set that is routinely larger than one: a customer who wrote about a return on Monday and about a delivery on Wednesday has two non-closed Cases, both satisfying conditions 1–3. The rule says the inbound attaches; it does not say **to which**. FR-001 promises "exactly one Case", § Aggregates promises the Case is "the unit of work" (`v2:171`), and T-TEST-02 (`v2:562`) asserts "Attaches / opens a new Case" — none of them can be implemented or tested without a choice function. Two independent implementations will pick differently, and the pick determines which agent's queue the message lands in.

**Defect (b).** The predicate contains no `tenant_id` and no `organization_id` term. Tenant scoping is arguably implied by FR-020, but organisation is **not**, and cannot be: `organization_id` is now nullable (`v2:303`), the same `customer_entity_id` can legitimately be referenced from Cases in sibling organisations (FR-027 `v2:152` exists precisely because cross-org customers are expected), and an org-less inbound has no org to match on. As written, an inbound arriving on org A's channel attaches to org B's Case — the whole thread, the whole Case history and the Customer 360 projection cross the boundary FR-020/FR-021 (`v2:156-159`) exist to hold.

**Fix.** Restate the rule as a selection, not a test:

```
candidates = { c ∈ connect_cases :
                 c.tenant_id = inbound.tenant_id
               ∧ org_match(c.organization_id, inbound.organization_id)   -- define it, see F-M6
               ∧ c.customer_entity_id = identity.customer_entity_id
               ∧ c.status <> 'closed'
               ∧ c.merged_into_case_id IS NULL
               ∧ ( now - max(conv.last_inbound_at over c) <= case_attach_window_minutes
                   ∨ (c.status = 'resolved' ∧ now - c.resolved_at <= reopen_window_days) ) }
target     = argmax(candidates, max(conv.last_inbound_at)) , tie-break (created_at DESC, id DESC)
```

and add a test asserting the pick with two eligible Cases.

#### F-C2 — Linking an identity never repairs the Cases opened while it was unresolved; `connect_case.customer_entity_id` has no backfill writer

**Location:** § Attach rule cond. 1 (`v2:189-190`), FR-026 (`v2:137-138`), FR-018 (`v2:144-147`), `customer_entity_id` (`v2:314`).

**Defect.** Cond. 1 makes an unresolved identity open its **own Case every time** — not just the first time. A customer who writes five times before an agent works the manual-match task produces five Cases, each with `customer_entity_id = NULL`, and (per FR-025) five auto-acknowledgements. Then the agent resolves the manual-match task. FR-026 says resolving it "MUST link the identity and drain any staged projection" — and that is **all** it says. Nothing:

1. backfills `customer_entity_id` onto the five existing Cases;
2. merges or links them (the merge columns are explicitly unused in Phase 1, `v2:319`);
3. makes them visible on Customer 360, which reads by `customer_entity_id`.

So after the operator has done exactly the work the manual-match queue exists for, the customer's history stays invisible, the next inbound still fails cond. 2 (no Case carries that `customer_entity_id`) and opens a **sixth** Case, and this repeats until someone edits rows by hand. The manual-match queue — FR-014's entire justification and R2's headline mitigation (`v2:451`) — has no effect on the aggregate it was created to repair.

**Fix.** Add an FR + task: linking an identity MUST, in the link transaction (§ Consistency `v2:471` already owns it), set `customer_entity_id` on every Case whose conversations reference that identity and whose `customer_entity_id IS NULL`, emit the projection for each resolved one, and record the backfill in `connect_identity_link_audit`. State the invariant `connect_case.customer_entity_id IS NULL ⟺ no conversation on that Case has a `linked` identity`, and add the multi-Case backfill to T-TEST-12.

#### F-C3 — FR-011's mandated transition is illegal in v2's own status table, and § Consistency makes the failure eat a delivered message

**Location:** FR-011 (`v2:116-118`), § Status machine (`v2:204-217`), § Consistency "Delivery reconcile" (`v2:470`), FR-009 (`v2:112-113`).

**Defect.** FR-011: *"`sent` … advances the Case to `waiting_customer`"* — unconditionally. The transition table offers exactly one row into `waiting_customer`: `in_progress → waiting_customer`. Nothing requires a Case to be assigned or advanced before an agent replies (FR-009 gates on the channel being connected, not on status; the Inbox composer is always available), so replying to a `new` Case is the ordinary first action. When the reconcile worker then applies FR-011, `new → waiting_customer` is an **illegal transition**, which FR-003 (`v2:92-94`) requires be rejected. Per § Consistency the reconcile is *one transaction* (`delivery_status → first_human_outbound_at → status → transition row`), so the rejection rolls back the whole thing: the message that the provider **actually delivered** reverts to `queued`, and — with no attempt bound (F-C5) — is a candidate to be sent again.

The table has three further reachability holes on the same reading: **no `new → closed`, `in_progress → closed` or `waiting_customer → closed`**. A junk Case that slips past FR-012 cannot be discarded without first being *resolved with a wrap-up note*, auto-close only ever fires on `resolved` (FR-005), and FR-024 removes `status` from CRUD — so an unwanted Case has no exit at all and sits in the counting layer forever.

**Fix.** Either add `new → in_progress` as a stated side effect of *send* (and say so in § Consistency's Send row, which currently writes only the `connect_message`), or add `new → waiting_customer` to the table. Add the three `→ closed` rows (or an explicit `discard` action with its own transition), and state the totality rule: any (from, to) pair absent from the table is rejected, and every writer that can produce a rejected pair must state its fallback rather than roll back a delivered send.

#### F-C4 — The auto-acknowledgement is an outbound with no declared kind, so it counterfeits the first human reply

**Location:** FR-025 (`v2:121-123`), FR-011 (`v2:116-118`), `connect_messages` (`v2:329-331`), `human_agent_message_count` (`v2:325`), T-ING-05 (`v2:509`).

**Defect.** FR-025 makes Phase 1 send a machine-authored message to the customer on every opened Case. `connect_messages` — the only table with `delivery_status` — has `direction` but **no kind/origin column**, and FR-011 keys purely on `delivery_status = 'sent'`. Therefore, if the ack flows through the send path (which it must, to get a delivery status at all), the reconcile worker will:

- stamp `first_human_outbound_at` with the timestamp of a message no human wrote — permanently, since the field is write-once — destroying the only first-response signal the aggregate holds;
- advance the Case to `waiting_customer` before any agent has read it (and, per F-C3, illegally, since the Case is `new`) — so the Inbox shows every brand-new Case as *waiting on the customer*, which is the opposite of the truth and the single most damaging possible default for a service desk;
- inflate `human_agent_message_count` and `outbound_count`, poisoning SC-005's inbound/outbound split.

If instead the ack does *not* flow through `connect_messages`, then it has no delivery status, no failure surface and no retry, and FR-025's "exactly one" has no idempotency record — a redelivered inbound (R7) re-acks.

**Fix.** Add `connect_message.origin ∈ {human, system}` (or `kind ∈ {reply, auto_ack, ...}`), route the ack through the same table with `origin='system'`, restate FR-011 as *"a `sent` message with `origin='human'` stamps … and advances …"*, exclude `system` messages from `human_agent_message_count` and state whether they count in `outbound_count`. Make FR-025's "exactly one" an invariant over that table (`at most one `origin='system', kind='auto_ack'` row per Case`), and add the ack to T-TEST-04.

#### F-C5 — `connect_message` has no state machine, no executor and no idempotency key

**Location:** FR-010 (`v2:114-115`), FR-011 (`v2:116-118`), `connect_messages` (`v2:329-331`), § Consistency Send row (`v2:469`), tasks (`v2:520-532`).

**Defect.** The async model is asserted but never specified as a domain object:

1. **No executor.** FR-010 says the route enqueues; § Consistency says *"Provider call happens in the worker (FR-010)"* — but the task list contains only `auto-close.ts` (T-WRK-01), `reconcile-delivery.ts` (T-WRK-02) and `baseline-metrics.ts` (T-MET-01). **No task performs the send.** This is the exact "requirement with no mechanism" defect v2 was written to repair (`v2:230`).
2. **No transitions.** `queued|sent|failed` is a value list, not a machine: no actor, no trigger, no legality (`failed → queued` on retry? `sent → failed` on a late bounce? both are silent), and no terminal rule. `connect_case_transitions` audits Case status changes only; message status changes are unaudited.
3. **`queued` is unbounded.** No enqueue-to-send timeout, no max age, no `max_retries` against the existing `retry_count` column, no alert. A worker crash between enqueue and provider call leaves the customer's reply invisible-but-"pending" in the composer forever, and nothing in SC-001…005 or `connect_metric_daily` would show it.
4. **No indeterminate outcome** — round-1 C5 unaddressed by the rewrite. A provider timeout is neither `sent` nor `failed`. Forcing it to `failed` offers the agent a retry on a message that may already have been delivered; forcing it to `queued` re-sends it. Either way Phase 1 manufactures the very `duplicate_reply_candidates` it counts (`v2:352`).
5. **No idempotency key.** Nothing prevents two `connect_message` rows for one composer submit (double-click, client retry after a slow 202) — the send route has no dedupe key while the *ingest* path (R7) has one.

**Fix.** Give the message its own state table with actor and trigger per transition; add `sending` and `unknown`; add `attempt_count`/`max_attempts`/`next_attempt_at` and a stated dead-letter state; add a unique `(conversation_id, client_request_id)`; disable retry on `unknown` by default and state the reconciliation rule (match the provider message id on the next hub poll); and add the missing `T-WRK-04 <M>/workers/send-outbound.ts` to slice 1c with T-WRK-03 registering it.

#### F-C6 — Unlink repudiates the identity but not the data already written from it

**Location:** FR-015 (`v2:131-133`), `connect_identity_link_audit` (`v2:344-346`), FR-017 (`v2:142`), `connect_case.customer_entity_id` (`v2:314`), R2 (`v2:451`).

**Defect.** By the time an operator unlinks a wrong identity, the link has already propagated into two places that FR-015 does not touch:

- **Cases.** `connect_case.customer_entity_id` is a denormalised copy. Unlink sets `link_state='unresolved'` on the *identity row* and says nothing about the Cases, so those Cases keep pointing at the wrong customer: they keep appearing in the `(tenant_id, customer_entity_id, status)` index, in the Customer 360 widgets (T-WID-01), in the orders-list "has open case" flag, and — worst — they remain valid attach targets under § Attach rule cond. 2 for the *wrong* customer's next e-mail.
- **Projections.** FR-017 has already written a `CustomerInteraction` containing the Case's subject and wrap-up note onto the wrong customer's timeline. Nothing retracts it. `connect` cannot delete it silently either (that is a `customers` row), so the retraction has to be a stated, commanded operation.

R2 (`v2:451`) is rated **Critical** for "wrong identity link exposes another customer's orders". Its listed mitigations are all *preventive* (thresholds, isolation, manual queue) — there is no *corrective* path, so the Critical risk persists in full after the error has been detected and corrected. FR-015's word "reversible" is satisfied for one column and nothing else.

**Fix.** Write the full unlink post-condition as an invariant set: identity (`link_state := 'unresolved'`, `customer_entity_id := NULL`, previous value retained only in the audit row), Cases (`customer_entity_id := NULL` for every Case linked through that identity, plus a transition/audit row each), projections (retract or tombstone each `CustomerInteraction` produced from those Cases — this needs an upstream contract in PR B, so it belongs in the blocking-PR table), and re-stage the pending projections. Add the retraction path to T-TEST-06 and list it as R2's corrective mitigation.

### Major

#### F-M1 — § Consistency's ingest ordering cannot be executed as written, and it defeats the idempotency it claims

**Location:** § Consistency row 1 (`v2:467`), `connect_conversations.case_id` (`v2:323`), FR-008 (`v2:109-111`), R7 (`v2:456`), T-TEST-09 (`v2:569`).

The stated order is *"`connect_conversation` insert (unique arbitrates) → Case attach/create → `conversation_count` increment → transition row"*. But `connect_conversations.case_id` is the FK that FR-008 makes mandatory ("exactly one parent Case"), so the conversation **cannot** be inserted before the Case is chosen or created. Run it in the only executable order and the arbitration comes *after* the Case write: the duplicate delivery creates a Case, then hits 23505 on the conversation, and the savepoint must be positioned to unwind the speculative Case create too — which the spec does not say. T-TEST-09 asserts "No second Case; `conversation_count` unchanged", so the ordering the spec states is precisely the one that fails its own test.

**Fix.** State the executable sequence explicitly, with the savepoint span: `SAVEPOINT` → resolve identity → select-or-create Case (per F-C1) → insert conversation → on 23505 `ROLLBACK TO SAVEPOINT`, re-read the existing conversation and **abandon the speculative Case** → else increment and write the transition row. The nested-transaction-as-savepoint pattern has a working precedent (`packages/core/src/modules/attachments/lib/reconcileOrganization.ts:139-146`), which the spec should cite instead of asserting the mechanism.

#### F-M2 — `link_state` is never enumerated, and the attach rule keys on a literal that excludes the strongest link

**Location:** § Attach rule cond. 1 (`v2:189-190`), `link_state` (`v2:337`), FR-014/FR-015 (`v2:129-133`), § UI identity panel (`v2:425`).

The domain of `link_state` is nowhere declared. Three values appear implicitly: `unresolved` (FR-014, FR-015), `linked` (attach rule), and a human-verified state implied by the UI's *"contact-identity panel with confidence and link/verify"* and by round-1's `verified`. Cond. 1 tests `link_state='linked'` **by literal equality**, so a handle a human explicitly verified — the highest-trust state in the model — fails the attach test and its owner's mail fragments into new Cases, while a machine-scored `linked` handle groups correctly. The safety gate is inverted precisely for the rows an operator has curated.

**Fix.** Declare `link_state ∈ {unresolved, linked, verified, unlinked}` in § Data model with the meaning of each; define a named predicate `is_linked(identity) ⟺ link_state IN ('linked','verified')` and use that literal wording in the attach rule, in FR-013–FR-015 and in the interceptor; state which transitions of `link_state` are legal and who performs them; and state what `confidence` holds for a `verified` row (round-1 m3 is still open on this).

#### F-M3 — `connect_metric_daily` has no formula, no key, no day boundary and no recompute rule; it is not reconstructible

**Location:** FR-019 (`v2:148-150`), `connect_metric_daily` (`v2:351-353`), `connect_tenant_settings` (`v2:353-355`), T-MET-01 (`v2:547`), § Consistency (`v2:473-474`).

Round-1 M3 asked for storage **and** formulas; v2 delivered the table and no formula. Every column is a bare name:

- **Day boundary undefined.** `day` needs a timezone. `connect_tenant_settings` still declares none, and nothing references the platform's date-locale settings. "Cases opened on 2026-08-22" is not yet a computable set.
- **No key, no idempotency.** No unique `(tenant_id, organization_id, day)` is declared, and nothing says whether a re-run of T-MET-01 overwrites or adds. A nightly worker that can double-count on retry is not a measurement system. (The org dimension is itself undefined given nullable `organization_id` — F-M6.)
- **`cases_resolved` still has two possible sources** — `connect_cases.resolved_at` (single-valued, cleared on reopen per `v2:216`) or `connect_case_transitions` rows with `to_status='resolved'`. Only the second counts re-resolutions honestly; the spec picks neither, so round-1 M3's gaming path (resolve early, reopen on the reply, resolve again) still moves the headline number in an undefined direction.
- **`cases_opened` cannot come from the transition table** either, because Case creation writes no transition row (F-M7).
- **`duplicate_reply_candidates` has no definition at all** (round-1 M4, still open) — a stored column whose value is unspecified.
- **`conversation_count` drift is "reported"** (`v2:473-474`) but no column stores the report and no threshold defines when drift is a failure.

**Fix.** Write each column as `expression over [t0,t1) in tenant timezone`, naming the source table; add `tenant_timezone` to `connect_tenant_settings`; declare unique `(tenant_id, organization_id, day)` and make T-MET-01 an idempotent upsert; state the reconstruction rule ("every column MUST be recomputable from `connect_cases`, `connect_case_transitions` and `connect_messages` for any past day"), which is what makes the layer non-gameable.

#### F-M4 — SC-001…SC-005 are not measurable from what v2 stores

**Location:** § Success criteria (`v2:72-77`), § Reading peer data (`v2:224-225`), `connect_metric_daily` (`v2:351-353`), `connect_pending_projections` (`v2:351`).

The rewrite's headline improvement is "each is measurable from the counting layer this phase ships". Checked one by one, four are not:

- **SC-001** compares `connect_metric_daily.cases_opened` against an "`ExternalMessage` count" — a table `connect` is forbidden to query (`v2:224-225`, *"MUST NOT query `messages` or `communication_channels` tables … or write raw SQL against them"*). Even granting the number, the identity is wrong: a correctly **attached** inbound increments no `cases_opened`, so `cases_opened < inbound` is the *success* case and the *failure* case alike. There is no `cases_attached` column, so "exactly one Case or attaches to one" has no arithmetic.
- **SC-002** states a per-`(channel, sender)` bound and measures it with `suppressed_inbound`, a tenant-daily scalar that cannot express a per-pair maximum. `N` is never given a value or a window.
- **SC-004** measures "every resolved Case **with a linked identity** has a `CustomerInteraction` within 60 s" from `connect_pending_projections` drain lag. That table holds only the projections staged because the identity was **not** linked (FR-018) — the complement of SC-004's population. As specified, SC-004 measures the empty set. `connect_pending_projections` also has no declared columns, so "lag" has no source timestamps.
- **SC-005** promises "handle time"; no column stores it (`wrap_up_seconds` has no writer or definition — round-1 m5), and no first-response metric exists (round-1 C5).

**Fix.** Add `cases_attached`, `first_response_seconds_p50/p90`, `handle_seconds_p50` and a `suppression_events` breakdown (or restate the SCs against columns that exist); give SC-002 a concrete `N` and window and measure it from a per-pair counter; define SC-004 over *all* projections (add `projection_lag_ms` or a `projected_at` on the Case) rather than the staged subset; and re-source SC-001 from `inbound_count` (a `connect` column) rather than a peer table.

#### F-M5 — Manual-match tasks have no dedupe and no terminal meaning, so the queue self-floods and `dismissed` is a permanent case-generator

**Location:** FR-014 (`v2:129-130`), `connect_manual_match_tasks` (`v2:348-349`), FR-026 (`v2:137-138`), § Attach rule cond. 1 (`v2:189-190`), FR-025 (`v2:121-123`).

FR-014 fires per sub-threshold **inbound**, not per identity: *"the system MUST … write a `connect_manual_match_task` row"*. One unmatched sender writing ten times yields ten open tasks for one decision, and no unique index or `state='open'` guard is declared. Separately, `state='dismissed'` has no defined effect on the identity: it stays `unresolved`, so cond. 1 keeps failing, so every subsequent message opens a fresh Case **and** (FR-025) sends a fresh auto-acknowledgement — an unbounded, operator-visible loop that the R1 limiter can only stop by misclassifying a real customer as an auto-responder. `candidate_customer_ids` has no staleness or scope rule either (a customer merged or deleted after the task was written).

**Fix.** Declare a partial unique index `(identity_id) where state='open' and deleted_at is null`, make FR-014 an upsert that refreshes `candidate_customer_ids` and `last_seen_at`. Define the task state machine (`open → resolved | dismissed`, actor, reversibility) and define what `dismissed` writes to the identity (recommend `link_state='ignored'` with an explicit attach/ack behaviour). Cap auto-acknowledgement per `(channel_id, handle_hash, window)`, not per Case.

#### F-M6 — `organization_id IS NULL` rows have no read semantics, so FR-020 is false by construction

**Location:** `v2:303-309`, FR-020 (`v2:156`), FR-021 (`v2:158-159`), FR-022 (`v2:160-161`), indexes (`v2:320-321`).

Making the column nullable was correct (M5), but v2 stops at the write side. FR-020 still reads *"Every row MUST be scoped to tenant **and organisation**"* — which a nullable column cannot satisfy — and the spec never says how a null-org row behaves on **read**: visible to every organisation of the tenant, to none, or only to a tenant-wide grant? Under the ordinary `WHERE organization_id = :selected` filter these Cases are invisible to everyone, which for an org-less shared mailbox (the Phase-1 target) means the module's primary traffic disappears. Under an `IS NULL OR = :selected` filter they are visible to every org, which is a disclosure. The spec picks neither, and the guard it would otherwise inherit fails open: `ensureOrganizationScope` returns without validating when no scope and no current org can be resolved — the system/worker context the ingest subscriber runs in — and only denies under `OM_ENFORCE_ORG_SCOPE_STRICT` (`packages/shared/src/lib/commands/scope.ts:99-121`).

**Fix.** State the rule once, as an invariant, and repeat it in FR-020 with the exemption written down: recommend "a null-org row is visible to any caller whose organisation set is within the row's tenant **and** who holds `connect.cases.view.all`; org-scoped callers see only their own org" — or resolve the org deterministically at ingest (channel's org, else tenant default) and keep the column effectively non-null. Add a null-org case to T-TEST-05.

#### F-M7 — `connect_case_transitions` cannot represent Case creation, system actors or its own nullability

**Location:** FR-003 (`v2:92-94`), `connect_case_transitions` (`v2:333-334`), § Status machine (`v2:214-217`), T-TEST-15 (`v2:575`).

FR-003 requires a transition row for *every transition* and names it the audit of record, but the table is under-specified in three ways that make the audit incomplete:

- **Creation is not a transition.** No row is written for `∅ → new`, and `from_status` is not declared nullable, so `cases_opened` cannot be derived from the audit and the first entry in a Case's history is missing.
- **System actors.** `actor_user_id` has no stated nullability, yet three writers have no user: the auto-close worker (FR-005), the delivery reconcile (FR-011) and the inbound-triggered reopen (FR-006). Either the column is nullable with a stated `actor_kind`, or these writers must supply a system-user id — which one is never said.
- **`payload` has no schema.** It is now load-bearing (`v2:216` puts the preserved `wrap_up_note` in it), so it needs a declared, zod-validated shape per transition kind; otherwise the resolution history round-1 C2 asked for is untyped JSON that no query can read reliably.

**Fix.** Declare `from_status` nullable with a `∅ → new` row written at creation; add `actor_kind ∈ {user, system, customer}` with `actor_user_id` nullable; give `payload` a per-transition zod schema in `data/validators.ts`; and state the invariant `every change of connect_cases.status has exactly one transition row` so the audit is verifiable by replay.

#### F-M8 — The `closed → new Case → previous_case_id` chain is unbounded and unconstrained, and it hides re-contact from the metrics

**Location:** § Status machine row 9 (`v2:214`), `previous_case_id` (`v2:317`), `reopen_count` (`v2:317`), `connect_metric_daily.cases_reopened` (`v2:352`), T-TEST-16 (`v2:576`).

Making `closed` terminal is right, but the successor rule ships with no invariants:

- **No constraint on the reference.** Nothing says `previous_case_id` must point at a Case of the same tenant, same customer and earlier `created_at`, and nothing forbids a cycle. It is a self-FK with no domain rule.
- **No bound and no consumer.** A long-running customer relationship becomes an unbounded singly-linked list. No list view, detail view, metric or export is specified to traverse or collapse it, so the Case aggregate's central promise — one thread per relationship episode — degrades to a chain nobody follows.
- **Re-contact vanishes from the counting layer.** `reopen_count` resets to 0 on each successor Case, and `cases_reopened` counts only in-place reopens. The customer who comes back five times after auto-close registers zero reopens and five "new" cases — so the module's own baseline (SC-005) reads as a healthy first-contact-resolution rate exactly when it is worst.
- **The chain has holes.** `previous_case_id` is set only on the `closed` path. A Case that is `resolved`, past `reopen_window_days`, and not yet auto-closed (the worker is periodic, so this window always exists) produces a successor Case with **no** link at all.

**Fix.** State the invariants (`previous_case_id → same tenant, same `customer_entity_id`, `created_at` strictly earlier, acyclic`), set it on **every** superseding create (resolved-out-of-window as well as closed), add `case_chain_root_id` or a declared traversal so lists and Customer 360 can group an episode, and define `cases_reopened` to include chained re-contact (or add `cases_recontacted`).

### Minor

- **F-m1** — T-DATA-02 (`v2:485`) still creates `connect_case_reopen`, a table § Data model no longer declares; the reopen history now lives in `connect_case_transitions` + `reopen_count`. Stale task, left over from the frozen spec. Also `connect_pending_projection` is created there with **no columns declared anywhere** (`v2:351`), which SC-004 depends on.
- **F-m2** — § Frozen surfaces (`v2:417`) says `connect.case.assigned` is emitted "by transfer **and by assignment on the CRUD route**", which FR-024 (`v2:103-104`) and T-API-01 (`v2:496`) forbid — `assignee_user_id` is excluded from the updatable set. As written the only assignment path is `transfer`, which has no defined semantics for a Case that is currently unassigned. Pick one: add `POST /cases/{id}/assign`, or state that transfer covers assignment from the unassigned state.
- **F-m3** — Dropping `escalated` (`v2:56-59`) removes a value from an enum `app-spec-notes/frozen-surfaces.md:134-135` declares **FROZEN**. The decision is defensible (nothing has shipped), but § Migration (`v2:583-596`) audits 14 surfaces and does not mention it. State it explicitly as "frozen list amended pre-ship", so a later phase re-adding `escalated` is unambiguously additive.
- **F-m4** — `connect_case_tags` and its assignment table (`v2:355`) now ship with no FR, no writer, no seed and no consumer — the `possible_duplicate` tag that justified them left the test suite in v2. Cut them or give them an owner.
- **F-m5** — `case_value_minor`/`case_value_currency` and `source_order_id`/`source_return_id`/`source_shipment_id` (`v2:314-316`) have no writer: no FR, no task, no rule that the currency is snapshotted with the amount from the source document. Add the invariant `case_value_minor IS NOT NULL ⟹ case_value_currency IS NOT NULL` and name the writer, or cut all five from Phase 1.
- **F-m6** — Three columns with undefined domains or writers: `priority` is mandated by FR-002 (`v2:90-91`) with no enum, no default and no setter; `connect_messages.direction` (`v2:330`) implies inbound rows in a table § Aggregates describes as "outbound send intent" (`v2:174`), with no writer for the inbound side; `connect_messages.message_id` ("the `messages` id, once known") has no stated writer or timing.
- **F-m7** — v2 still has **no glossary**, and "open Case" — the term § Attach rule deliberately replaced with "not `closed`" — reappears undefined in R5 (`v2:454`) and T-TEST-08 (`v2:568`, "300 open Cases"). Five load-bearing terms are now defined in five different sections (`linked`, `not closed`, attach window, reopen window, duplicate-reply candidate — the last still not defined at all). Add a short § Glossary and make every FR use its literal wording.

---

**Assessment.** v2 is a real improvement on the frozen spec: the transition table, § Consistency, § Attach rule, the audit/queue/metric tables and the async send are all structural repairs, and seven of my twenty-one round-1 findings are closed outright. But the rewrite moved the defects rather than eliminating them: the attach rule is now precise enough to be *provably* non-deterministic (F-C1) and to have a missing repair path (F-C2); the status table is now explicit enough to *provably* forbid a transition another FR mandates (F-C3); and the async send replaced one under-specified outcome with an under-specified state machine that has no executor (F-C5). The consistent pattern is that v2 states **what** where the frozen spec stated nothing, but still rarely states **who writes it, in what order, and what the row looks like afterwards**. The six Criticals are all one-paragraph fixes; none requires a redesign, and all six land in the same migration.

FINDINGS: 6C/8M/7m

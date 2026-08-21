# Findings register — Connect Phase 1, review round 1

**Status:** the merged spec `.ai/specs/2026-08-21-connect-phase-1-merged.md` is **FROZEN**. This
register is the successor artifact, written instead of a second in-place revision per
[`spec-pipeline-runbook.md`](../../docs/spec-pipeline-runbook.md) § 8.

**Round 1 review totals:** 19 Critical · 46 Major · 26 Minor (91), from four roles run in
parallel, each blind to the others.

| Role | Artifact | Findings |
|---|---|---|
| DDD | [`REVIEW-ddd.md`](REVIEW-ddd.md) | 5C / 9M / 7m |
| Architect | [`REVIEW-architect.md`](REVIEW-architect.md) | 4C / 9M / 7m |
| PM-UX | [`REVIEW-pm-ux.md`](REVIEW-pm-ux.md) | 4C / 13M / 7m |
| Implementer | [`REVIEW-implementer.md`](REVIEW-implementer.md) | 6C / 15M / 5m |
| Gate 1 claims | [`CLAIMS-LEDGER-…md`](CLAIMS-LEDGER-2026-08-21-connect-phase-1-merged.md) | 23 rows, 1 REFUTED |

## Why this is a freeze and not a revision

Three independent reasons, any one of which is sufficient:

1. **Exit 0 is arithmetically unreachable this round.** The `review` gate requires
   `dryRounds >= 2` — two consecutive review rounds producing no new finding. Round 1 produced
   91. Even a flawless revision earns at most `dryRounds = 1` on the next pass, so the budget
   (`round 3/3`) HALTs before the threshold can be met.
2. **Several criticals are owner decisions, not editorial defects.** Guessing them is precisely
   the documented failure mode — "a v4 written the same way will produce a fourth variant".
3. **Cross-role convergence marks the structural ones.** Reviewers blind to each other landed on
   the same two defects, which makes them the highest-confidence items in the set.

## Convergent findings — highest confidence

| Defect | Found independently by | Substance |
|---|---|---|
| **The status machine is stated as a total linear chain** | DDD C1, PM-UX C1 | FR-003's arrow chain makes `escalated` mandatory and forbids `in_progress → resolved` and `waiting_customer → in_progress`; T-DOM-01 rejects illegal transitions, so the spec as written rejects its own happy path. `escalated` has no route, command or event, so `escalation_reason` has no writer. |
| **Reopen / attach is undefined and self-contradictory** | DDD C2, PM-UX C2 | FR-006 names no target status and no reset of `resolved_at`/`wrap_up_note` → a Case simultaneously resolved (by column) and open (by status). FR-001 attaches inbound only to an **open** Case, so a customer reply after resolve orphans into a new Case — recreating the exact failure the phase exists to fix — and FR-005's "auto-close after N days with no inbound" becomes vacuously true forever. |
| **FR-014's "manual-match task" does not exist** | DDD M-set, PM-UX C3, Implementer M3 | The named mitigation for **Critical risk R2** (wrong identity exposes another customer's orders) appears twice in the document and has no table, route, screen, owner, task or test. |
| **`connect.case.assigned` is frozen with no writer** | Architect m-set, Implementer M10 | A FROZEN event ID with no emitter task and no endpoint. |
| **No scheduler registration for the two workers** | Architect M-set, Implementer M11 | FR-005 (auto-close) and FR-019 (baseline metrics) never run. |

## Blocking criticals, grouped by what would settle them

### Group A — I can fix these without a decision (spec-editing work)

| # | Finding | Fix |
|---|---|---|
| Impl C1/C2 | No task writes **any** test; FR-020's write path *is* a test | Add T-TEST tasks with file paths and slices; downgrade the Readiness write-path ✅ |
| Impl C3 | 5 of 11 API routes have no task; `T-API-03` is a numbering gap at the `/transfer` slot | Add the five tasks; regenerate ids (never renumber) |
| Impl C4 | `connect_tenant_settings` has no T-DATA task though three FRs read it | Add it to T-DATA-02 |
| Impl C5 | No task registers `connect` in `apps/mercato/src/modules.ts` → `yarn generate`/`db:generate` emit nothing | Add a registration task for both packages |
| Impl C6 | T-DATA-05 reds `yarn test` — the curated map resolves `__dirname/../modules/<id>`, core-only, and throws ENOENT for `connect` | Rewrite T-DATA-05 to widen the resolver first, then add the entries |
| DDD C4 | No transaction boundary named anywhere; `conversation_count` stored, derivable, no concurrency control, and on the optimistic-lock target | Add a § Consistency subsection naming the boundary per write |
| Gate 1 #8 | The `senderUserId` NOT NULL justification is REFUTED | Strike it; see decision Q-A |
| Gate 3 | Two further identifier drifts vs `frozen-surfaces.md` | Reconcile |

### Group B — owner decisions; I must not guess

| # | Finding | What would settle it | Who |
|---|---|---|---|
| **Q-A** | Ledger row 8 — relaxing `messages.Message.senderUserId` NOT NULL is **not required**. No FK exists (`foreignKeys: {}`), and `ingest-inbound-message.ts:378` already system-authors via the sentinel. | Confirm the relaxation is dropped. Doing so removes the only (d)-class change and **unblocks slice 1c from Q2's sign-off**. | Maintainer |
| **Q-B** | Architect C3 — FR-010's "15 s timeout → 422" is **unreachable**. `sendAsUser` enqueues and returns; the adapter runs in a worker with 3 retries. The route's only 422 is the pre-flight channel-state guard. Adding a timeout would also change the FROZEN `ChannelAdapter` contract, which § Migration does not list. | Decide the delivery model: make send synchronous, or replace FR-010/FR-011 with an async delivery-status model. This also decides FR-011 and T-TEST-04. | Owner + maintainer |
| **Q-C** | Architect C1/C2 — the peer-read facade cannot produce its own declared projection (`direction` occurs zero times in `messages`; direction/channelType/deliveryStatus live on `MessageChannelLink`, attachments in `attachments`), and `connect` has **no reachable path to a thread id** at all. The merge also silently dropped source A's second facade while claiming "one facade, nine requirements intact". | Decide the read boundary: restore the second facade (`communicationChannelsThreadReader`), or take `threadId`/`parentMessageId` off the `message.received` payload and `SendAsUserResult`, which already carry them. | Architect |
| **Q-D** | Architect C4 — the facade must bypass `messages`' sender-OR-recipient participant scope (inbound sender is the system user, recipients is `[]`). That is a security-boundary relaxation of PR A's **(e)** class, but PR C is booked **(a)+(b)** with no sign-off. | Reclassify PR C and obtain sign-off, or design a scope the facade can satisfy. | Maintainer |
| **Q-E** | PM-UX C4 — the business case is self-referential. Every "Target" in App Spec §1.2.2 is the prototype's *current* KPI and every "Baseline" is that value minus its own month-over-month delta chip (6.20+1.10=7.30; 78.4−6.1=72.3; 4:38+52s=5:30; 38−9=29; 61−4=57). The tell: the one row with no delta chip is the one flagged "not yet measurable". The 44 060 denominator also includes 3 100 portal self-service sessions (~3 410 PLN/mo inflation), and 38% containment reconciles with neither denominator in `INTENTS`. | Operator baseline data from the shared mailbox — the same gap Q3 already records as unclosable from the prototype. Until it exists, the ROI claim should be withdrawn rather than restated. | Product owner |
| **Q-F** | PM-UX C3 + DDD C3 — FR-001's "same identity" and "open" are both undefined. The per-channel unique index makes a row-based attach channel-scoped, **re-imposing the exact limitation Provenance repair 1 faulted package A for**; a `customer_entity_id` reading instead collapses every unresolved sender into one bucket (R2 exposure). | Decide the attach key. This is the phase's core aggregate decision and it is currently ambiguous in a way that is unsafe either way. | Architect + owner |

## The irony worth recording

The merged spec exists to repair package A's headline defect: *a feature whose mechanism the
platform never provides*. Architect C2 finds the merged spec reproduced that defect one layer
down — `connect` has no reachable path to a thread id, so the unified thread is again a
requirement with no mechanism. The write-path test catches this class when it is run against
**reads** as well as writes; it currently is not.

## Recommended sequence

1. Owner answers Q-A … Q-F (Q-A and Q-B unblock the most).
2. Write `2026-08-22-connect-phase-1-v2.md` **whole**, not as a delta — the merged spec stays
   frozen as the audit trail, with `[RETRACTED — see FINDINGS-REGISTER]` on ledger row 8's claim.
3. Group A fixes fold into that rewrite.
4. Re-run the four-role review on v2; expect a much shorter round, then a dry round.
5. Only then Gate 1 → code.

**No code has been written.** Gate 1 has not cleared, and the goal blocks implementation until it does.

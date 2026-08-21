# Independent review register — App Spec v3 (round 3)

**Under review:** `2026-08-21-app-spec-mercato-connect.md` (v3), `2026-08-21-connect-phase-1-one-inbox.md`, `app-spec-notes/commits-by-workflow.md`
**Date:** 2026-08-21 · Rounds 1–2: `independent-review-register.md`, `independent-review-register-v2.md`

| Reviewer | Headline |
|---|---|
| Architect | Adoption credit over-stated **~4×** (125–188 → 26–49); effective estimate 237 → **344–367** |
| DDD | **19 violations of v3's own §0**, the section written to prevent exactly this |
| PM/UX | The contact base has the wrong **unit** — channel traffic counted as Cases |

**Verdict: v3 must not go to implementation.**

---

## 1. The pattern, stated plainly

Three rounds, three variants of one error. Each version fixed the previous defect and introduced a subtler one at the next level down.

| Version | Error | Confidence at the time |
|---|---|---|
| v1 | Wrong **sum** — a 7-channel subtotal quoted as 9 channels | "derived in the open" |
| v2 | Wrong **subtraction** — the outbound rule applied to 1 of 4 campaigns | one reviewer called §1.2.1 "the strongest section in the document" |
| v3 | Wrong **unit** — `CHANNELS_CFG` is channel traffic, not Cases | "published as a range" |

**The unit error, verified first-hand.** Conversation `c1` is **one Case**, tagged `channel:'whatsapp'`, whose messages span `telefon` and `whatsapp`, and whose subline links e-mail and Instagram. It appears once — but its traffic is counted inside both the telefon (8 410) and whatsapp (4 260) volumes. Summing `CHANNELS_CFG` double-counts the cross-channel Case that is this product's entire premise.

Two independent fixture cross-checks land **below v3's published floor**:

| Cross-check | Implied base |
|---|---:|
| Enabled intents contain 6 961 cases; ÷ the 38 % containment KPI | **18 319** |
| 17 staffed agents × 27.2 cases/day × 21 days ÷ 62 % agent-touched | **15 662** |
| v3's published range | 28 590 – 40 960 |

v3's *floor* is 56 % above the intent-derived estimate. A range that does not bracket the data's own disagreement is not an uncertainty interval.

This contradicts three other parts of v3: §1.3's glossary ("**Contact** — always a *Case*"), §1.4.3's cost formula (`÷ Cases`), and §3.5 — which changed the Inbox *specifically so a cross-channel Case is not shown twice* while §1.2.1 counts it up to four times.

> **Reviewer disagreement, adjudicated.** The DDD reviewer rejected "the base arithmetic is wrong" as a false alarm and called §1.2.1 the most rigorous section in the document. It is not in conflict with PM/UX: DDD verified the **arithmetic** (which reproduces exactly) and PM/UX tested the **unit** (which does not). PM/UX went a level deeper. Both are right about what they checked.

---

## 2. §0 self-compliance — the rules were violated by the document that introduced them

19 violations. The four that underwrite the schedule, **all verified first-hand**:

| Rule | Claim in v3 | Reality |
|---|---|---|
| R0.1 | `inbox_ops/lib/rateLimiter.ts` is "**exactly** Phase 1's R1 per-sender window" | Two call sites only: a global bucket and a **tenant** bucket. **No sender dimension exists.** Cache keys are hardcoded to the `inbox_ops:rate_limit:` namespace, so Connect's buckets would collide with `inbox_ops`' own |
| R0.1 | `configs.ModuleConfig` + `page.meta.visible` removes nav **and API surface**, 2–3 commits | `visible` is consumed at exactly one site — sidebar construction. The URL and the API stay reachable. The cited `sales` precedent uses **`feature_toggles`**, not `ModuleConfig`, and **fails open** |
| R0.1 | `messages` registries mean a Conversation "becomes a registered message type, not a fork" | The registries control rendering components, default actions and icons. `sender_user_id` and `recipient_user_id` are both NOT NULL. No storage, no schema, no routing |
| R0.1 | "**nothing writes a `user_id IS NULL` row**" | `integration_credentials.user_id` is `nullable: true`, its unique index is partial `where user_id is not null` — deliberately permitting null rows — and `credentials-service.ts` has an explicit shared-credential fallback. The true statement is narrower: *no `communication_channels` path does* |

Two further R0.3 violations, both verified: "31 call sites" for `enforceCommandOptimisticLockWithGuards` is **34 files / ~45 sites** with no stated counting rule; the "60 s interval floor" is `Math.max(10, …)` — default 60, floor **10**.

**And one fabricated clause inside R0.1's own exemplar.** v3's `planner` row ends *"the tests pass only because they pin `TZ=UTC`"*. `availabilityMerge.ts` has **zero** local-time accessors and three UTC ones, so the pin is a no-op. Inherited from round 2 and asserted without checking — an R0.1 violation one section after R0.1 was written. (The core `planner` findings survive: `7 * DAY_MS`, `timezone` absent, `BYDAY` written-never-parsed. The reversal is right; one supporting clause was invented.)

**R0.2 was answered with "N/A" on exactly the invariants whose honest answer is hard** — 4 (a cross-module split/clock write), 11 (consent owned by `customers`; fail-open vs fail-closed is a regulatory question), 12 (the announcement event comes from the telephony adapter, so adapter-present + quality-absent = unpoliced recordings). An "if module absent" column filled with N/A converts an unanswered question into a documented one, which is worse than round 2's visible silence.

**R0.5's freeze list is itself unfrozen**: event IDs are frozen at three different values across the three documents; widget spots are frozen to a `sales` pattern whose shipped regex rejects both `return` and `sidebar`; ten action ACL IDs hide inside a `<key>` wildcard; `connect_portal` has zero feature IDs; four BC categories (import paths, DI names, notification IDs, AI tool IDs) are absent.

---

## 3. The estimate

| | v3 | Round 3 |
|---|---:|---:|
| Raw | 393 | 370–430 (accept ~393, **re-derive the basis**) |
| §4.6 adoption credit | 125–188 | **26–49** |
| Effective | 205–268 (≈237) | **≈ 344–367** |
| Phases 1–5 | 180–230 | **≈ 260–280** |

The schedule is understated by ~45 %, entirely because the adoption credit is over-stated fourfold. Two of the nine credited capabilities have **never been exercised by a second module at all**.

The `176 insertions/commit` constant is also wrong: the repo's real density is **353 code-only / 609 all-files**, and the three most Connect-like modules sit at 484–570. So 690 is typical, not an outlier — v3's stated reason for rejecting v2's 233 does not hold. 393 is defensible by a route v3 never states (sizing against the modules Connect would replace: ~189k insertions / 457 commits).

Round 1 measured this same class of claim and found *"of ~24 claimed avoided commits, roughly 8 are real"*. v3 scaled the claim 6× and did not re-run the check R0.4 requires it to record — §4.6 omits the check for ~122 of 393 raw commits.

---

## 4. Blocking defects (selection)

- **C1** The resolution-SLA pause accrues **wall-clock** and is added to a **business-calendar** due date. One overnight conjures seven business hours of headroom; every paused Case retro-scores compliant.
- **C2** Invariant 16's `idempotency_key` is unique-per-nothing. Either the retry mints a new key (second replacement shipment — round 2's D7, unfixed) or it is derived and the retry is a permanent no-op returning `failed`. A globally-unique text column is also a cross-tenant existence oracle.
- **C3** A "gated-off" module still serves its data: nav hides, URL and API answer, ACL grants persist, and the cited precedent fails open. Invariant 14 is unimplementable as costed.
- **C5** Phase 2 cannot derive `responded_at` from what Phase 1 records — Phase 1 stores `last_inbound_at`/`last_outbound_at` (the **last**), and inv 2 needs a *current, mutable* `principal_kind`, so a departed agent's Cases retro-score as never-responded.
- **C6** `connect_pending_projection` can permanently leak one customer's service history onto another's timeline via re-link, has no drain for never-linked identities, and is undeclared.
- **C7** Invariant 5 is unenforceable where written: `send-as-user.ts` opens the transaction, writes, then **delegates delivery to a queue**. Ownership must be re-checked in the worker before `sendMessage`.
- **C9** Phase 3's exit gate (≥73 %) is unreachable until Phase 7b — SMS is 39 % of the ceiling and is campaign traffic shipping in the last phase. Max at Phase 3 is ~44.8 %.
- **C10** **The Phase 1 spec's body still specifies v2.** `allowSharedChannel` survives in D5, R3, T17, M1, the ordering section and the compliance report; `first_responded_at` still drives T6/T7; D4 still proposes the new `customers` command §4.5 forbids. An implementer following the Design Decisions table ships the escalation vector §4.5 rejected, onto a STABLE signature.
- **M1** `connect_business_calendar` restored the storage shape and **not the maths**. Repo-wide search for `businessMillisBetween`/`addBusinessMillis` and any holiday entity: zero. Neither function the SLA formulas need exists or is specified. 8 commits buys the table.
- **M11** v3 is **not standalone**: §§4.1–4.4, 6, 8, 9 are absent; §9 is cited four times; §§2, 3, 3.5, 5 are defined as deltas against a v2 file that was overwritten in place and no longer exists.

---

## 5. The actual lesson

Round 3's process note is the finding that matters most:

> *"§0 was verified by the same author who wrote the claims it governs. Every one of the nineteen violations was found by reading the cited code path, and every one was findable that way. **The rule is sound; nothing enforced it.**"*

Three rounds have now established that author confidence is a poor predictor of correctness on this document, and that adding better rules does not fix it — v3's rules were good and v3 broke them nineteen times. The failure is **self-verification**, not rule quality.

**A v4 written the same way will produce a fourth variant.** What changes the outcome is making platform claims mechanically checkable: every capability assertion carries a `file:line` citation to the code path that *performs* the behaviour, and a reviewer or a script confirms each one before the claim is allowed to carry a commit credit. That is a process change, not a document change.

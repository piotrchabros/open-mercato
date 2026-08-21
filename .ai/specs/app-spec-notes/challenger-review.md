# Challenger review — App Spec: Mercato Connect

**Spec:** `.ai/specs/2026-08-21-app-spec-mercato-connect.md`
**Date:** 2026-08-21
**Reviewer:** the spec author, running the `om-app-spec-writing` challenger checklists inline.

> **Honesty note.** `om-app-spec-writing` requires an *independent* challenger — "an author
> cannot adversarially re-read their own spec." This session runs under an explicit instruction
> not to dispatch subagents, so that separation does not exist here. Everything below is a
> self-review against the same checklists. It caught real problems (recorded as ACCEPTED
> findings) but it cannot be treated as an independent gate. Tracked as **OQ-9** in the spec.

---

## Findings — ACCEPTED (changed the spec)

| # | Section | Finding | Change made |
|---|---|---|---|
| C-1 | §1.2 | Targets were stated with no baseline, so no ROI could be computed. The prototype's KPI tiles show *deltas*, which means baselines are derivable (78.4% FCR at +6.1 pts ⇒ 72.3% baseline). | Added a baseline column to the metrics table and derived every ROI figure arithmetically from it. Also added **OQ-3** asking whether the baselines are real or illustrative — because if they are illustrative, every ROI number in the spec is illustrative too, and the spec should say so out loud. |
| C-2 | §1.4 | "Containment" and "FCR" were defined but gameable: close-and-reopen inflates FCR; a silent transfer with no agent message counts as contained. | Added §1.4.4 with anti-gaming rules per metric — a 7-day reopen window for FCR, handoff-breaks-containment, `pending`/`expired` excluded from suggestion acceptance on both sides. |
| C-3 | §1.4.3 | The rule "AI never sends without acceptance" contradicted the existence of a bot that answers customers autonomously. | Invariant 5 now names the single sanctioned exception (bot-owned conversations before handoff, always labelled) rather than stating a rule the app immediately breaks. |
| C-4 | §3 WF1 | "Case" and "Conversation" were used interchangeably, which made the channel-switch behaviour ambiguous — does a phone→WhatsApp switch make a new Case? | Split the terms in §1.3 with an explicit cardinality (one Case, many Conversations) and made the switch WF1 edge case 1. |
| C-5 | §3 WF4 | SLA escalation was specced as a countdown. A worker outage would silently skip an entire window of escalations. | Added the "evaluate from stored timestamps, never an in-memory countdown" rule as WF4 edge case 6 and as a Phase 2 domain criterion. The PM challenged this as over-engineering and withdrew — recorded in Phase 2. |
| C-6 | §5 | Three stories were happy-path only (US-1.2 send, US-4.1 presence, US-5.2 portal action). | Every story now has alternate and failure paths. The send story in particular gained the WhatsApp 24-hour-window failure, which turned out to matter: a failed send that does not stamp `first_responded_at` is also an SLA failure. |
| C-7 | §5 cross-story | The impact matrix surfaced two entirely missing stories and one missing invariant. | Added US-1.6 (duplicate-channel detection), US-7.2 (suppression after case close), and the "SLA clock never resets on transfer" rule. Also added three domain events that had no home: `connect.identity.merged`, `connect.case.transferred`, `connect.intent.published`. |
| C-8 | §4.5 | Four app modules with no justification beyond "they feel separate". | Added the turn-it-off test (a tenant can disable three of the four and still have a product — which is literally the prototype's Settings screen) plus an invariant-locality analysis showing no invariant spans two modules. |
| C-9 | §4.5 | The business-hours calendar was proposed as a shared module with exactly one consumer. | Downgraded to "build in `connect`, extract on the second consumer", with the reason stated and recorded in §8 so a future consumer extends rather than duplicates. **OQ-5** decided. |
| C-10 | §4 | The portal channel adapter was counted in both WF5 and the channel matrix. | Double-count removed; noted inline so the totals reconcile. |
| C-11 | §7 | Phase totals (121) did not match the §4 gap total (116) with no explanation. | Explained: Phase 1 carries the demo-seed commits, which §4 scores per workflow rather than per phase. |
| C-12 | §8 | `inbox_ops` also ingests e-mail and was not mentioned at all — a real collision with a shipping module. | Added the conflict row with a concrete resolution (a mailbox is configured for one or the other, made explicit in Settings) and the cross-referral deferral. |
| C-13 | §2 | The bot was listed as a persona with a role key, implying a seat and routing capacity. | Reclassified as a system principal using the existing `communication_channels/lib/system-user.ts` pattern, with the reason (it would otherwise pollute presence and AHT reporting). |
| C-14 | §3.5 | The IVR screen was described as a "flow editor", which the prototype does not show and which is a multi-phase product. | Committed explicitly to the prototype's annotated step list, flagged the deviation, and opened **OQ-6**. |

## Findings — REJECTED (challenged, spec unchanged)

| # | Finding | Why rejected |
|---|---|---|
| R-1 | "Seven workflows is too many; merge WF6 and WF7." | They have different personas, different regulatory constraints and different phases. Merging would produce one workflow with two unrelated ROI lines, which is exactly what the "no artificial phases" rule exists to prevent. Analytics *was* merged into WF6 rather than being an eighth workflow. |
| R-2 | "Model the Case as a `workflows.WorkflowInstance` instead of a new aggregate." | Checked against `packages/core/src/modules/workflows/data/entities.ts`. `UserTask` carries assignment/SLA/escalation, which is why the spec uses it for escalation — but a workflow instance is a generic process, not a channel-aware service case with a first-response clock, conversation cardinality and reopen semantics. Forcing it would put Connect's domain rules into `workflows`' generic step model. |
| R-3 | "Use `planner` for presence instead of a new entity." | `planner` models rostered availability (who is scheduled). Presence is live routing eligibility (who is ready in this second), changes many times an hour, and gates every routing decision. Different lifetime, different write frequency, different consumer. The spec does use `planner` — for the wallboard's staffed-vs-target signal. |
| R-4 | "Phase 5 (bots) should come before Phase 4 (channels) — bots are the biggest ROI." | A bot needs somewhere to hand off *to* and something to speak *on*. Shipping containment before queues and channels is the classic failure: a bot with no escalation path. The ROI is real, which is why it is Phase 5 and not Phase 7. |
| R-5 | "Drop the portal — the bot covers the same intents." | Different mechanisms. The bot *answers*; the portal *acts* (return, invoice, reschedule) with a stage-gated UI and no ambiguity risk. WF5's ROI is deflection of the action class, not the answer class. |

## Checklist coverage

| Gate | Result |
|---|---|
| Vague rules killed | Pass — no "manage/track/handle" in any story; §1.4 field tables give type + multi + required for every entity |
| Vague ROI killed | Pass — every workflow and phase carries an arithmetic derivation, not "users benefit". Contingent on **OQ-3**. |
| Happy-path-only stories killed | Pass — 21/21 stories have alternate + failure paths |
| Cross-story impact analysed | Pass — 8-row matrix; all five conflict patterns checked; the matrix added 2 stories, 1 invariant, 3 events |
| Entity fields precise | Pass — 18 entities with full field tables |
| No phantom entities | Pass — §8 cross-check maps every entity to a user story |
| Independent adversarial pass | **FAIL — not run.** See the honesty note. **OQ-9.** |

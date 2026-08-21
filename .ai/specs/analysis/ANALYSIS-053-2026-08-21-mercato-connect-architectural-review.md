# 🔍 Architectural Review: Mercato Connect — Omnichannel Customer Contact Workspace

**Spec**: [`.ai/specs/2026-08-21-mercato-connect-omnichannel.md`](../2026-08-21-mercato-connect-omnichannel.md)
**Rubric**: `om-spec-writing` § Architectural review + § Review heuristics (staff-engineer lens)
**Date**: 2026-08-21
**Prior work**: [ANALYSIS-051](./ANALYSIS-051-2026-08-21-mercato-connect-p1-readiness.md) (readiness, C1–C7 closed) · [ANALYSIS-052](./ANALYSIS-052-2026-08-21-mercato-connect-p1-readiness-pass2.md) (readiness pass 2, D1–D5 closed)

> **Reviewer independence caveat.** This spec was authored by the same agent producing this review. A self-review is structurally weaker than an independent one — it cannot catch what the author never thought of, only what the rubric forces them to look at. Two of the four findings below are things both prior audits missed, which is evidence the rubric works, not evidence the review is sufficient. **Treat this as a rubric pass, not as independent sign-off**, and have a human or a fresh agent confirm the Critical before merge.

## Summary

Mercato Connect specifies an omnichannel contact-centre workspace composed on Open Mercato's existing channel, message, customer and portal modules, with voice delegated to an external contact-centre provider. The architecture is sound and unusually well-grounded: the central mechanism — one thread per customer across channels — was verified against real source rather than assumed, the cross-module boundary is enforced through source-owned DI facades after an audit caught direct table reads, and backward compatibility is clean across all thirteen protected surfaces with a single additive field change.

Against the staff-engineer lens, three things fall down. The spec proposes an **unencrypted PII column** (`customer_snapshot`) that the project's data-protection convention requires be declared in an encryption map — a hard-rule violation both prior readiness audits missed, because they confirmed the spec *mentions* encryption without checking it covers *every* PII field. The spec is also **a bundle of eight independently-deployable capabilities in one document**, which the rubric explicitly says should be split. And **publishing a voice flow has no rollback path**, despite the data model already carrying the version fields that would make one trivial.

Overall assessment: architecturally strong, with one hard-rule violation that must be fixed before implementation and a structural problem worth resolving before P2 planning begins.

## Findings

### ⛔ Critical

**A1 — `customer_snapshot` is unencrypted PII.**

`ServiceConversation.customer_snapshot`, `ServiceTicket.customer_snapshot` and `QualityReview.customer_snapshot` are `jsonb` columns explicitly documented as holding *"denormalised name, initials, e-mail, VIP flag, value metrics"*. Name and e-mail are GDPR-relevant personal data. The project's rule is unambiguous — every PII column a spec adds MUST be declared in the module's `encryption.ts` `defaultEncryptionMaps`, with reads through `findWithDecryption` (`packages/core/AGENTS.md` § Encryption; restated as a MUST in `om-pre-implement-spec`).

The encryption task (T011) declares exactly two columns: `CustomerIdentity.identifier` and `ServiceConversation.closing_summary`. `customer_snapshot` appears nowhere in any encryption map, in `data-model.md` or `tasks.md`.

This is not a cross-tenant leak — scoping is intact — but it is a violation of a stated hard rule, and it is the *denormalisation* that makes it dangerous: the snapshot exists precisely so customer data survives the `customers` module being absent, which means it persists PII outside the module that owns the encryption discipline for it.

**Why both prior audits missed it**: they asked "does the spec address encryption?" (yes, T011 exists) rather than "is every PII column covered?" (no). A checklist that verifies presence rather than completeness will pass a partial map.

**Fix**: add `customer_snapshot` to `defaultEncryptionMaps` on all three entities in T011, or — better — reduce the snapshot to non-PII fields (VIP flag, value metrics, initials) and resolve name/e-mail live through `customers` with a `tryResolve` fallback. The second option is smaller and removes the duplication of PII entirely; it costs the "survives peer absence" property for the display name only.

### ⚠️ High

**A2 — Scope cohesion: this is eight specs in one document.**

The rubric states: *"one independently deployable capability per spec. Bundles get split."* This spec covers eight modules — inbox, tickets, queues/wallboard, campaigns/dialer, bots/IVR, quality, analytics, customer portal — and 13 screens. Each is independently deployable by the spec's own design; that independence is a stated product requirement (FR-071–074).

The practical costs are already visible: only the P1 slice has a task breakdown, so seven-eighths of the spec is unvalidated by planning; the two readiness audits scoped themselves to P1 and explicitly did not audit the rest; and the document must be re-read in full to change any one capability.

**Mitigating**: the P1/P2/P3 priorities are clearly marked, `tasks.md` is scoped to P1 only, and the plan says "do not generate P2 tasks until P1 is merged". The bundle is managed rather than ignored.

**Fix**: after P1 merges, split the remainder into per-capability specs (`service_tickets`, `contact_queues`, `telephony`, …), each referencing this document as the product-level parent. Do not attempt the split now — it would churn a spec that is about to be implemented.

**A3 — Publishing a voice flow has no rollback path.**

FR-098 requires publication to be atomic and the workspace to show whether published configuration matches what is authored. Nothing anywhere specifies how to **revert** a published flow. Searching the artifact set for unpublish / rollback / revert / previous-version returns nothing.

This matters more than most reversibility gaps: a bad IVR flow affects every inbound call immediately, and the recovery path under pressure is currently "author the old steps again by hand and re-publish".

The data model already supports the fix — `VoiceFlow` carries `version` and `published_version` — so this is a missing requirement, not a missing design. The rubric is explicit that *"the rollback/undo logic deserves the same detail as the execute path"*, and here the execute path (FR-098, T-08 atomicity) is specified in detail while the undo path is absent.

**Fix**: add a requirement for reverting to a previously published version, and a `TelephonyAdapter.revertFlow` (or `publishFlow` accepting an explicit version) in the contract. P2/P3 scope — does not block P1.

### 🔹 Medium

**A4 — The spec re-documents the framework.**

The rubric: *"a spec earns its length only with what is unique to this feature"* and *"specs describe the unique; they do not re-document the framework."* Several requirements are entity field lists dressed as requirements — FR-033 (a case carries id, subject, customer, channel, owner, priority, status, SLA), FR-049 (a campaign carries name, mode, channel, owner, state, counts), FR-062 (a review carries id, channel, topic, participants, duration, score). These duplicate `data-model.md` without adding constraint.

`contracts/rest-api.md` similarly restates `makeCrudRoute` and mutation-guard conventions that `packages/core/AGENTS.md` already defines, and `tasks.md` repeats AGENTS.md rules inline.

**Counter-argument, and why I am not calling it High**: the repetition in `tasks.md` is deliberate and defensible — a task an implementer reads in isolation is more likely to be executed correctly if it names the rule. The duplication in `spec.md` is the part that is genuinely redundant.

**Fix**: collapse the pure field-list FRs into references to `data-model.md`. Low urgency; costs nothing to leave.

**A5 — Three of eight module names are not plural, against the stated naming law.**

Root `AGENTS.md`: *"Modules: plural, snake_case (folders and `id`). Special cases: `auth`, `example`."* `telephony`, `contact_quality` and `contact_analytics` are not plural and are not listed exceptions.

**However, shipped practice contradicts the stated law**: `catalog`, `progress`, `directory`, `planner`, `checkout`, `content`, `onboarding` and `search` are all singular core modules. The law appears to mean "not artificially singularised" rather than "must be grammatically plural", and mass nouns like `telephony` have no natural plural.

**Fix**: a maintainer decision, not a defect to fix unilaterally. Either accept these names as consistent with practice, or rename to `telephony_providers` / `quality_reviews` / `contact_metrics`. Flagging rather than asserting a violation, because the rule as written and the codebase as built disagree.

**A6 — The analytics rollup has no documented failure mode.**

Heuristic 8 requires every external call, migration and long-running job to have a documented failure mode and user-visible behaviour. The `contact_analytics/subscribers/rollup-metrics` subscriber aggregates across conversations, tickets and calls, and nothing states what happens when it falls behind or fails — whether dashboards show stale figures, show a gap, or silently under-report. Compare the telephony call-reconciliation sweep, which *is* specified.

**Fix**: state the degraded behaviour for stale rollups, consistent with how the wallboard already declares staleness (SC-021). P3 scope.

**A7 — SC-013 is a business KPI, not a deliverable success criterion.**

*"Cost per contact falls measurably against the pre-deployment baseline over the first full reporting quarter."* This cannot be verified by the delivery, depends on staffing and volume outside the software, and has a quarter-long feedback loop. The `/speckit-analyze` rubric excludes post-launch outcome metrics from buildable criteria for exactly this reason.

**Fix**: move to a "business outcomes we expect" note, or keep it but mark it explicitly non-gating so it never blocks a release.

### Low

- **A8** — `contracts/peer-read-facades.md` P-05 cites task "T046" for the search-index exclusion; after the last renumber that task is **T043**. One stale cross-reference.
- **A9** — Success criteria mix user-perceptible latency (SC-003, SC-008) with business outcomes (SC-013) and operational absolutes (SC-005, SC-016) in one undifferentiated list. Grouping them by what verifies each would make the gating ones obvious.
- **A10** — The canonical spec and the companion directory share a basename, which is clean, but nothing in the canonical file states that `tasks.md` is P1-only. A reader arriving at the spec could reasonably assume 87 tasks covers the whole product.

## Checklist

| # | Heuristic | Verdict | Justification |
|---|---|---|---|
| 1 | The architectural diff | ⚠️ **Partial** | Genuinely novel content (thread aggregation, peer facades, voice boundary, identity confidence) earns its length; several FRs restate the data model — see A4. |
| 2 | Scope cohesion | ❌ **Fail** | Eight independently-deployable capabilities in one spec; the rubric says bundles get split — see A2. Managed by P1/P2/P3 marking, but not resolved. |
| 3 | Canonical mechanisms | ✅ **Pass** | `makeCrudRoute`, `CrudForm`, `DataTable`, `apiCall`, `createModuleEvents`, DOM Event Bridge, `integrations` registry, DI cache, command pattern all used as-is. The one invention (`TelephonyAdapter`) states its reason and mirrors the existing `ChannelAdapter`. |
| 4 | Contracts and compatibility | ✅ **Pass** | All 13 surfaces audited against the real tree, twice. One additive optional field (`ChannelCapabilities.voice?`) with an in-file precedent. No deprecation protocol triggered. |
| 5 | Reversibility | ⚠️ **Partial** | P1 is strong — undo payloads on all five commands, identity-merge reversal pulled forward, reply's no-undo exemption documented rather than implied. Voice-flow publish has no rollback at all — see A3. |
| 6 | Boundaries and coupling | ✅ **Pass** | FK-id + snapshot throughout, no cross-module ORM relations, source-owned read facades with enumerated consumer prohibitions, `tryResolve` degradation verified by `module-decoupling.test.ts`, one-directional reach. |
| 7 | Sensitive data | ❌ **Fail** | `identifier` and `closing_summary` correctly encrypted with a lookup hash; `customer_snapshot` carries name and e-mail and is in no encryption map — see A1. |
| 8 | Failure scenarios | ⚠️ **Partial** | Outbound send timeout, webhook fail-closed, unclean call termination, provider degradation, AI unavailability and 25 edge cases are all specified. The analytics rollup is not — see A6. |
| 9 | Testability | ✅ **Pass** | Every task names a file; V1–V14 map to acceptance scenarios; the two hardest guarantees (never auto-send, tenancy isolation) have dedicated negative and isolation specs. Manual-only criteria are labelled as such. SC-013 is the exception — see A7. |

**Verdict: request changes.** A1 must be fixed before implementation — it is a hard-rule violation on personal data, and the fix is small. A2 and A3 are structural and can be scheduled: A2 after P1 merges, A3 before telephony is built. Everything else is optional polish.

## Recommended sequencing

1. **Before writing code** — fix A1. Either add `customer_snapshot` to the encryption maps on all three entities, or reduce the snapshot to non-PII and resolve name/e-mail live. Prefer the second.
2. **Before writing code** — fix A8 (one stale task reference). Trivial.
3. **Before P2 planning** — decide A2 (split the bundle) and A5 (module naming). Both are maintainer calls.
4. **Before telephony is built** — close A3 (flow rollback).
5. **Opportunistic** — A4, A6, A7, A9, A10.

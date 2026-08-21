# Pre-Implementation Analysis (Pass 2): Mercato Connect — P1 Slice

**Spec**: [`.ai/specs/2026-08-21-mercato-connect-omnichannel.md`](../2026-08-21-mercato-connect-omnichannel.md)
**Supersedes-in-part**: [ANALYSIS-051](./ANALYSIS-051-2026-08-21-mercato-connect-p1-readiness.md) (pass 1)
**Artifacts audited**: full set + `tasks.md` (T001–T086, post-remediation) + new `contracts/peer-read-facades.md`
**Date**: 2026-08-21 | **Scope**: P1 slice only (US1 + US2, module `conversations`)

## Why a second pass

Two things changed since pass 1:

1. **Closing C1 created new contract surface that pass 1 could not audit** — two new DI keys in `packages/core` (Phase 2A, T019–T022), added on pass 1's own recommendation. Auditing your own remediation is the point of a second pass.
2. **The audit's known blind spot is now closed.** `corepack yarn install-skills` was run (15 local + 36 external skills), so `.agents/skills/om-code-review/references/review-checklist.md` exists. Pass 1 explicitly reported this dimension as **not covered**. It is covered here, and it produced three findings pass 1 could not have found.

## Executive Summary

C1, C2 and C3 are **genuinely closed** — verified against the artifacts, not taken on trust. The new Phase 2A surface is clean: both DI keys are free, additive, and correctly scoped.

The newly-available code-review checklist found **three new majors**, all in the same blind spot: the artifact set reasons carefully about *agent-initiated* writes and barely at all about *system-initiated* ones. The inbound-message path — the highest-frequency write in the entire product — has no cache invalidation, no explicit concurrency strategy, and the outbound provider call it triggers has no timeout.

**Status: D1–D5 closed 2026-08-21** — see *Resolution* at the end. Original recommendation follows.

**Recommendation: Needs spec updates first** — three majors, roughly 3 task edits. No blockers. No redesign.

## Verification of pass-1 remediation

| Gap | Claimed fix | Verified | Evidence |
|---|---|---|---|
| **C1** peer-table coupling | Phase 2A facades, T024/T041 rewritten | ✅ **Closed** | T024 and T041 both name the facades and forbid direct reads; `contracts/peer-read-facades.md` enumerates consumer violations; `research.md` R-01 and `data-model.md` cross-module map both updated |
| **C2** no cache strategy | T015 strategy, T033 invalidation, T060 test | ⚠️ **Partially closed** — see **D1** | Invalidation is wired to T028/T029/T032/T033 but **not** to the inbound subscriber |
| **C3** no undo payloads | T028–T032 payloads, T061 test | ✅ **Closed** | All five commands carry payloads; T031 carries a documented no-undo exemption, which is the right call for a delivered message |

### New surface introduced by the C1 fix

| Surface | Key | Status |
|---|---|---|
| BC #9 DI service name | `messagesThreadReader` | **FREE** — no occurrence in the tree |
| BC #9 DI service name | `communicationChannelsThreadReader` | **FREE** — no occurrence in the tree |
| BC #1 auto-discovery | new `packages/core/src/modules/messages/di.ts` | Module has no `di.ts` today; adding one is additive and follows the standard `register(container)` convention |

Both are additive on an ADDITIVE-ONLY surface. No deprecation bridge required. **No BC violation.**

## New findings (code-review checklist dimension)

| ID | Category | Severity | Location | Finding |
|----|----------|----------|----------|---------|
| **D1** | Performance / caching | **major** | T041; T015 | **The inbound path never invalidates the list cache.** Checklist §6: *"If a cache was added: is invalidation wired to every write path?"* Invalidation is wired to T028/T029/T032/T033 — all agent-initiated. But a new inbound customer message arrives through the **subscriber** (T041), which writes `ServiceConversation.last_activity_at` and creates bindings, and is absent from every invalidation list. This is the single most frequent write in the product: **every inbound message on every channel**. An agent would watch a cached inbox that does not show new mail. C2 is therefore only partially closed. |
| **D2** | Error handling | **major** | T031 | **Outbound provider call with no timeout.** The word "timeout" appears **zero times** in the entire artifact set. T031 calls `ChannelAdapter.sendMessage` — a network call to WhatsApp/SMS/e-mail providers — inside a command. The checklist anti-pattern table lists *"Outbound call without a timeout → major"*. A hung provider would hold the request, and with no timeout there is no defined path to the 422 that T031 promises to return. |
| **D3** | Concurrency | **major** | T041 | **Check-then-act on conversation creation.** Checklist §7: *"Any check-then-act sequence that two concurrent callers can interleave — is it protected by an atomic operation, a lock, or a unique constraint?"* T041 must decide whether a `ServiceConversation` already exists for a thread, then create one. Two inbound messages arriving on different channels for the same thread interleave trivially. The `unique (tenant_id, organization_id, thread_id)` index **does** exist as a backstop (`data-model.md:42`) — so this corrupts nothing — but T041 says only "idempotent" without saying *how*. The unique violation must be caught and resolved to the existing row (upsert semantics), or the subscriber will throw and retry on a perfectly normal race. |
| **D4** | Tests | minor | T060 | Cache-invalidation test enumerates "every write path in T028–T032" — inherits D1's blind spot; it would pass while the inbound path stays stale. Widen once D1 is fixed. |
| **D5** | Observability | minor | Phase 2A | Neither facade specifies logging on the degraded path. When `tryResolve` returns undefined and the thread renders empty, an operator needs to know it was a missing peer rather than an empty thread. `createLogger` facade is the repo mechanism. |

### Checklist dimensions with no findings

Correctness (§1), security (§2), contract stability (§3), test coverage (§4 — beyond D4), readability (§8), scope discipline (§9), dependency hygiene (§10 — no new production dependency), docs (§12). Notably clean: scope filters are mandatory parameters on both facades (P-01), permission checks are server-side (T039 gates on `identity.manage`, not only the UI), no secrets in any payload, migration is scoped to `conversations` only (T012), no hand-edited generated files.

## Carried forward from pass 1 (still open, unchanged)

C4 route metadata · C5 `packages/core/AGENTS.md:76` URL-derivation doc defect · C6 search-index identifier exclusion · C7 spec integration-coverage cross-reference · plus the nice-to-haves (BC section rename, UI/UX cross-reference, partial-unique-index note).

## Remediation Plan

### Before Implementation (Must Do)

1. **D1** — Add cache invalidation to T041, and extend T015's invalidation map to cover system-initiated writes. State the rule as *every* write path, not *every command*.
2. **D2** — Specify an explicit timeout on `ChannelAdapter.sendMessage` in T031 and in `contracts/rest-api.md`, with timeout expiry mapping to the 422 the route already promises.
3. **D3** — Rewrite T041's idempotency from an assertion into a mechanism: rely on the unique index, catch the violation, resolve to the existing conversation.

### During Implementation

4. **D4** — Widen T060 once D1 lands.
5. **D5** — Log the degraded path in both facades via `createLogger`.
6. C4, C6 from pass 1.

### Post-Implementation

7. C5 (`AGENTS.md:76`), C7, and the nice-to-haves.
8. Consider a lesson record if the peer-facade pattern proves reusable — it is the second time this repo has needed one.

## Recommendation

**Needs spec updates first** — but the distance is short: three task edits, no redesign, no blockers.

The pattern worth naming: all three majors sit on the **system-initiated** write path. The artifact set reasons carefully about what an agent does — clicking reply, closing a case, reversing a merge — and thinly about what arrives on its own. That is also where the highest write volume lives. Worth carrying into P2, where queue events and telephony webhooks are entirely system-initiated.

Pass 1's verdict was reached with the code-review dimension missing. Installing skills changed the result: three majors that pass 1 structurally could not have found.


---

## Resolution — 2026-08-21

All five findings closed in `tasks.md` and the contracts. **No new tasks** — every fix folded into an existing one, so the count stays 86.

| Finding | Closed by |
|---|---|
| **D1** inbound path never invalidates cache | T041 now invalidates `conversations:list` and `conversations:thread:<threadId>` after commit; T015's map restated as *every write path, not every command*, naming subscriber- and worker-driven writes explicitly. This is what C2 missed. |
| **D2** outbound call with no timeout | T031 calls `ChannelAdapter.sendMessage` under an explicit configurable timeout (default 15 s); expiry maps to the existing 422 path. Added to `contracts/rest-api.md` both on the route and as a shared rule for any outbound provider call. |
| **D3** check-then-act on conversation creation | T041 rewritten from "idempotent" to a mechanism: insert-and-catch on the `unique (tenant_id, organization_id, thread_id)` index, resolving to the existing row — no read-then-create, no retry storm on a normal race. |
| **D4** cache test inherits the blind spot | T060 widened to cover the inbound path and to assert two racing inbound messages for one thread yield exactly one `ServiceConversation`. |
| **D5** silent facade degradation | New requirement **P-09** in `contracts/peer-read-facades.md`; both T019 and T020 log the unreachable path via `createLogger`. |

**Still open** (carried from pass 1, all non-blocking): C4 route metadata · C5 `packages/core/AGENTS.md:76` URL-derivation doc defect · C6 search-index identifier exclusion · C7 spec integration-coverage cross-reference · BC-section rename, UI/UX cross-reference, partial-unique-index note.

The system-vs-agent-initiated asymmetry that produced D1–D3 is recorded in the pass-2 recommendation and should be carried into P2 planning, where queue events and telephony webhooks are entirely system-initiated.

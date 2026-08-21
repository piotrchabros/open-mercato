# HALT report — Connect Phase 1 spec phase

**Trigger:** `node .ai/scripts/spec-gate-check.mjs all` exit **2**, round 3.

> Gate 1 — claims ledger: round introduced 3 new unverified claim(s) while resolving 1 — the loop is diverging

Per the runbook, the remediate step does **not** revise. This report names what is unresolved, what
would settle it, and who produces that.

## The measurement

| | Merged spec (v1) | v2 |
|---|---|---|
| Review findings | 19C / 46M / 26m = **91** | **66** fresh (15C / 30M / 21m) |
| Round-1 findings resolved by v2 | — | **35 resolved · 35 partial · 21 unresolved** |
| Platform claims resolved | — | 1 (the `senderUserId` retraction) |
| Platform claims **introduced and falsified** | — | **3** |
| Core-edit (d)/(e) rows | 2 | **1** — the one gate that genuinely closed |

v2 is a better document than v1. It is not a *converging* document: it resolved 35 findings and
introduced 66, of which 15 are Critical, and it introduced three new false platform claims while
retiring one.

## The recurring defect — three documents, same class

This is the finding that matters more than any individual bug.

| Document | The claim | The reality |
|---|---|---|
| Package A | The cross-channel thread primitive already exists | Every `thread-matcher.ts` strategy filters by `channelId`; nothing ever writes a cross-channel thread |
| Merged spec | `messagesThreadReader` returns the thread projection | `direction` does not exist in `messages`; it lives on `MessageChannelLink`, which the hub owns |
| **v2 (mine)** | `message_thread_id` is available on the `message.received` payload | The payload emits ten fields and `threadId` is not among them (`ingest-inbound-message.ts:515-529`) — **though the value is in hand at `:385-404` and simply is not published** |

Three independently-written documents, three careful authors, three variants of the identical
error: *a value the platform almost publishes, assumed to be published.* Each was caught only by
opening the emitting code. **Specification review does not reliably catch this class** — three
rounds of it did not.

## What is unresolved

### Blocking criticals in v2 (15 fresh, plus 21 unresolved from round 1)

Convergent across roles — highest confidence:

1. **Nothing sends.** FR-010/011/025 put the provider call "in the worker"; the three worker tasks
   are auto-close, reconcile-delivery and baseline-metrics. No send worker exists.
   *(Implementer C-A, DDD, PM-UX F-C2)*
2. **No assign or self-claim route.** FR-024 forbids CRUD from setting `assignee_user_id`; no
   `/assign` endpoint exists; § Status machine's `new → in_progress` trigger is "assign"; and the
   FR-022 interceptor filters `assignee_user_id = me`, which never matches NULL — so a front-line
   agent without `connect.cases.view.all` sees a **permanently empty Inbox**.
   *(Implementer C-B, PM-UX F-C1, Architect F-M4)*
3. **Inbound threads cannot render.** See the table above. *(Architect F-C1)*
4. **Nullable `organization_id` is incompatible with the CRUD path.** `buildScopedWhere` never emits
   `IS NULL` (`crud.ts:14-29`) and CRUD create/update/delete hard-require an org
   (`factory.ts:2388-2391, 2716-2726`), so an org-less Case is invisible and un-editable.
   *(Architect F-C3)* — this is a fix I introduced for DDD's round-1 M5.
5. **The facade cannot read bodies by the route v2 claims.** The hub has only ever read ids
   cross-module (`enrichers.ts:144-147`); the sanctioned third path (the query engine) is named two
   lines below the quote v2 relies on and is not considered. *(Architect F-C2)*
6. **Unlink does not retract exposure.** It retracts the identity but not the Cases already attached
   nor the `CustomerInteraction`s already written — so R2's Critical survives its own correction.
   *(DDD)*
7. **SC-001…SC-005 are largely unmeasurable.** SC-001 requires counting `ExternalMessage`, which
   v2's own § Reading peer data forbids `connect` to touch; SC-004 measures the complement of its
   stated population. *(PM-UX, DDD)*

### Still open from round 1

`channel-webform` has no FR, risk, test or scaffold. The wrap-up gate and `wrap_up_seconds` still
have no writer. Manual case creation still has no surface. The customer-context rail — the TLDR's
headline promise — still has no FR and no test.

## What would settle it, and who produces that

| Unresolved | What settles it | Who |
|---|---|---|
| The recurring "almost-published value" defect class | **Executing the path.** A thin vertical spike — one inbound e-mail → one Case → render the thread → one reply — compiled and run. The compiler and a live message settle in an afternoon what three specification rounds did not. | Implementer |
| Q-D — the facade's participant-scope bypass | A maintainer's ruling; `participantScope.ts:4-11` explicitly warns against a call site desyncing from that boundary | Maintainer |
| Q1 — PR A landing this cycle | Upstream owner | Maintainer |
| Q3 / SC-005 — the operator baseline | 30 days of production data. No fixture contains it; no document can close it | Product owner |
| Whether Phase 1 is the right size at all | Owner. The evidence now says this scope is not specifiable in one pass by this method — two full attempts, 157 findings, 34 of them Critical | Product owner |

## Recommendation

**Do not write v3.** A third document written the same way produces a third variant — the runbook
predicts it and this lineage has now demonstrated it twice.

Change the method instead: build the thin vertical spike, let it falsify the mechanism claims
cheaply and concretely, then write the spec **from what actually ran**. Every one of the three
recurring defects above would have surfaced in the first hour of that spike, and none of them
survived contact with the emitting code once someone opened it.

The spec artifacts are not wasted — the FR list, the frozen-surface reconciliation, the core-edit
ledger (now down to a single justified (e) row) and the claims ledger all carry forward. What does
not carry forward is the assumption that more specification will converge.

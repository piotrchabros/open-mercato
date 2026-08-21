# Commit plan by workstream — App Spec **v3**

**Spec:** `.ai/specs/2026-08-21-app-spec-mercato-connect.md` (v3)
**Date:** 2026-08-21 · **Supersedes** the v2 plan (233 commits, no adoption model)

Calibrated per round 2's reassessment. Two corrections to v2's method:

1. **The `22 git commits` anchor was wrong.** `channel-gmail` was *created* in one squash commit
   (413 files, +58 280); only 1 of its 22 commits adds >1 000 lines and the rest are dependency
   bumps, chores and merges. v2 read commit *count* as build effort. v3 uses insertion density,
   against the repo's own atomic standard of **~176 insertions/commit**.
2. **Two systematic under-counts are now included** — one integration-test commit per workstream
   against a repo where test code is 26–104 % of source LOC across every comparable, and a
   post-landing fix budget against WMS's 63 % `fix()` ratio.

---

## Totals

| Workstream | Raw |
|---|---:|
| WF1 `connect` core | 58 |
| WF3 identity and 360 | 20 |
| WF4 SLA + routing | 46 |
| WF6 analytics + quality | 46 |
| AI Assist (`connect_ai`) | 36 |
| WF2 bots (`connect_bots`) | 24 |
| WF5 portal (`connect_portal`) | 22 |
| WF7 campaigns (`connect_campaigns`) | 26 |
| Channel packages + hub | 82 |
| **Upstream PRs A / B / D** | 18 |
| Module gating via `configs` | 3 |
| Role landings | 2 |
| Demo seed | 4 |
| i18n / a11y | 6 |
| **RAW TOTAL** | **393** |

### The adoption credit

§4.6 of the App Spec commits to extending shipping modules rather than paralleling them. Round
2 sized each capability:

| Capability adopted | Credit |
|---|---:|
| `inbox_ops` intake pipeline (webhook secret, dual dedupe, parser, contact matcher, review queue) | 25–40 |
| `messages` threading + idempotency + **type/object registries** | 30–45 |
| `communication_channels` conversation assignment / reassignment (undoable command + ACL'd route) | 20–30 |
| `configs.ModuleConfig` + `page.meta.visible` | 4–6 |
| `perspectives` saved views | 8–12 |
| DataTable bulk actions + `progress` | 10–15 |
| `notifications` (definitions, renderers, reactive handlers) | 15–20 |
| `inbox_ops/lib/rateLimiter.ts` (the per-sender window R1 needs) | 5–8 |
| `communication_channels/setup.ts` per-org scheduler tick precedent | 8–12 |
| **Total** | **125–188** |

**Effective: 205–268 commits, central ≈ 237.**

> The credit is **aggregate, not allocated per row**, and deliberately so. `messages` type
> registries reduce WF1, WF5 and WF6 by amounts that cannot be cleanly separated until the
> design lands, and inventing a per-row split would manufacture precision this plan does not
> have. Round 1 and round 2 both caught exactly that kind of false precision. Re-allocate once
> the first workstream is designed.

---

## What changed from the v2 plan

| Item | v2 | v3 | Why |
|---|---:|---:|---|
| `connect_business_hours` / calendar | **0** (deleted, "use `planner`") | **+8** (`connect_sla.business_calendar`) | `planner` is UTC-only, DST-incorrect and `BYDAY`-blind |
| `sendAsUser` widening | 1 | **8–12** (upstream PR A) | Credentials, sender identity and shared-channel creation — not a flag |
| `principal_kind` | 0 (undeclared) | **+4** (upstream PR D on `auth`) | Existed nowhere; invariants 1–2 depend on it |
| `connect_module_state` | 6 | **3** | `configs.ModuleConfig` + `page.meta.visible` already do this |
| `connect_case_touch` | 0 (undeclared) | **+3** | The AHT formula's source entity |
| `connect_ai_action_execution` | 0 | **+5** | Idempotency key + compensation for ten money-moving mutations |
| `connect_cost_input` | 0 | **+2** | Cost per contact had two undeclared inputs |
| Close + reopen | 0 | **+4** | `closed` was FROZEN with no transition; reopen had no reader |
| Channels admin page (US-A.1) | 0 (asserted, uncosted) | **+3** | Phase 1 asserted it and an empty state pointed at it |
| Integration tests | 1/workstream | **realistic per workstream** | Test code is 26–104 % of source in every comparable |
| Post-landing fixes | 0 | **budgeted** | WMS: 64 of 101 commits are `fix(wms):` |

---

## Phases

`connect_routing` moves to **Phase 3**: the prototype's own dependency is *"telefonia lub chat"*,
and v2's e-mail-only Phase 2 wallboard would have shipped a channel-share chart with one bar at
100 % and a queue with no channels.

| Phase | Name | Raw | Ships |
|---|---|---:|---|
| **1** | One inbox: e-mail and forms | **85** | Upstream A+B+D (18), `connect` core, inbound→reply→resolve→close→reopen, identity linking, host spots, channels page, `channel-webform`, demo seed, baseline timestamps |
| 2 | SLA and measurement | 45 | `connect_sla` (calendar, clocks, escalation), `connect_analytics`, role landings, the `responded_at` and `current_case_count` **backfills** |
| 3 | Live channels **and routing** | 109 | webchat, WhatsApp, SMS, Messenger, Instagram, hub changes, `connect_routing`, wallboard, merge/split/re-link |
| 4 | AI Assist and the action catalogue | 36 | `connect_ai`, suggestions, wrap-up, 10 next actions **with execution records**, templates |
| 5 | Bots and containment | 28 | `connect_bots`, intents (incl. OQ-15's seven), handoff, gaps, bot coverage |
| 6 | Customer portal | 25 | `connect_portal`, self-service, portal preview, portal adapter |
| 7a | Voice and quality | 36 | voice adapter + `connect_quality` *(blocked: OQ-2, `call_transcripts`)* |
| 7b | Outbound | 26 | `connect_campaigns` *(blocked: OQ-2, upstream A)* |
| — | Module gating (`configs`) | 3 | on demand |
| **Total** | | **393** | **303 raw to production-ready (Phases 1–5)** |

Applying the adoption credit puts production-ready at **≈ 180–230 effective commits**.

> ### Why Phase 1 is 85 raw but its enumerated list below is 40
>
> This gap is the plan's most useful number, so it is stated rather than smoothed away.
>
> The list below names **40 `connect`-side commits**. Phase 1's raw estimate adds the **18
> upstream PR commits** (A, B, D — which must merge first) and **~27 commits of test and fix
> weight** that a named list systematically omits: integration suites at the repo's real ratio
> (test code is 26–104 % of source LOC in every comparable), and the post-landing fix tail
> (64 of WMS's 101 commits are `fix(wms):`).
>
> **v1 and v2 both estimated by enumerating the happy-path diff and stopping.** That is exactly
> what the named list is. Treat 40 as the design checklist and 85 as the schedule.

---

## Phase 1 — 40 named `connect`-side commits (85 raw)

Upstream first, in order. Each is a separate PR against a module `connect` does not own.

| # | Commit | PR |
|---|---|---|
| UP-A1…A10 | Shared-channel workstream: creation command, tenant-scoped credential provisioning (`user_id IS NULL`), sender identity through `SendMessageInput` + both adapters, shared-channel listing endpoint, ACL branch via `assertCanManageChannel`, `assignedUserId` semantics, tests | **A** |
| UP-B1…B4 | `customers.interactions.create` stability commitment + docs; new detail spots in `customers`; order/return spots in `sales` named to the `sales.document.detail.{kind}:{surface}` pattern | **B** |
| UP-D1…D4 | `auth.User.principal_kind` (additive, default `human`), migration, fail-closed resolution helper, tests | **D** |

Then `connect`:

| # | Commit |
|---|---|
| 1 | `connect` scaffold — `index.ts`, `acl.ts`, `di.ts`, `setup.ts`, `events.ts`, `extension-points.ts`, `search.ts`, `encryption.ts`, i18n, migrations |
| 2 | `connect_case` + `connect_conversation` entities, migration, snapshot |
| 3 | Case CRUD via `makeCrudRoute` (`indexer: { entityType: E.connect.connect_case }`) + OpenAPI + optimistic locking + per-method `metadata` |
| 4 | `connect_tenant_settings` (typed columns) |
| 5 | `connect_contact_identity` + `handle_value_hash` + **raw-SQL partial unique index** on the hash |
| 6 | `connect_case_tag` + assignments; `possible_duplicate` seeded as a tag |
| 7 | `connect_case_reopen` + `connect_pending_projection` entities |
| 8 | Status machine + `connect.case.*` events via `createModuleEvents` |
| 9 | Inbound subscriber — **extends `inbox_ops`** parser and dedupe; idempotent on `external_message_id` |
| 10 | Auto-responder / bounce suppression — `Auto-Submitted` + `Precedence` + `inbox_ops/lib/rateLimiter.ts` |
| 11 | Identity resolution with per-`handle_type` thresholds; `lookupHashCandidates` on read |
| 12 | Attach-window rule + `possible_duplicate` tagging |
| 13 | Manual-match task surface |
| 14–19 | Inbox: shell + guards · Case list pane (**Cases, not Conversations**, with channel-badge cluster) · thread pane (`in`/`out`/`sys`) · composer + reply-channel picker + capability guards · send path via `messages` + adapter · `useGuardedMutation` + per-pane lock headers |
| 20 | Resolve + wrap-up gate |
| 21 | **Close** endpoint + auto-close job (`auto_close_after_days`) |
| 22 | **Reopen** — in-place within `reopen_window_days`, new `case_reopen` row |
| 23 | Transfer command + event |
| 24 | Projection via existing `customers.interactions.create`, idempotent |
| 25 | `connect_pending_projection` drain on identity link |
| 26 | Case detail page |
| 27 | Cases list (`DataTable` + `perspectives` saved views) + CSV |
| 28 | Customer 360 shell + header KPIs |
| 29 | Customer 360 tabs + consent read model |
| 30 | Injection widgets + orders-list enricher **and** `InjectionColumnWidget` |
| 31 | Channels admin page (US-A.1) |
| 32 | Flash/toast surface |
| 33 | WF6-1 baseline timestamps (inbound/outbound, duplicate-reply candidates) |
| 34 | `channel-webform` package |
| 35 | `channel-webform` intake via the shared inbound route |
| 36–38 | Demo seed — roles/users · two fixture queues, channels, calendars · 8 Cases across statuses with a cross-channel switch |
| 39 | i18n `en` + `pl`; a11y pass |
| 40 | Integration suite — T1–T23 plus redelivery idempotency, query-count ceiling, guard invocation, hashed-lookup uniqueness, pending-projection drain |

**Slices:** 1a foundation (1–8, +upstream) · 1b ingest (9–13, 34–35) · 1c inbox (14–23) ·
1d surfaces (24–33, 36–40).

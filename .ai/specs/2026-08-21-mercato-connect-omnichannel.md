# Mercato Connect — Omnichannel Customer Contact Workspace

**Status**: Draft — specified and planned, not implemented
**Created**: 2026-08-21
**Scope**: OSS
**Source design**: Claude Design project *System omnichannel OpenMercato* → `Mercato Connect.dc.html` ([project](https://claude.ai/design/p/bd9bc47f-819f-4ade-9e68-71f8db42a1d6))

## TLDR

A contact-centre workspace where a service team handles every customer contact — phone, e-mail, chat, WhatsApp, Messenger, SMS, Instagram, web forms, portal — as **one thread per customer**, with commerce context and AI assistance in the same view. Delivered as eight independently-toggleable modules in a new `@open-mercato/contact-center` workspace package, **composed on top of** the platform's existing `communication_channels` / `messages` / `customers` / `portal` modules rather than replacing them. Voice runs through an **external contact-centre provider** behind a vendor-neutral `TelephonyAdapter`; Mercato Connect owns routing rules, context, agent experience and reporting.

## Overview

This file is the repository-facing entry point. The full artifact set lives in the companion directory [`2026-08-21-mercato-connect-omnichannel/`](./2026-08-21-mercato-connect-omnichannel/):

| Artifact | Authoritative for |
|---|---|
| [`spec.md`](./2026-08-21-mercato-connect-omnichannel/spec.md) | Requirements — 12 user stories, 100 FRs, 25 edge cases, 22 success criteria |
| [`plan.md`](./2026-08-21-mercato-connect-omnichannel/plan.md) | Technical context, constitution check, project structure |
| [`research.md`](./2026-08-21-mercato-connect-omnichannel/research.md) | 12 design decisions with rationale and rejected alternatives |
| [`data-model.md`](./2026-08-21-mercato-connect-omnichannel/data-model.md) | 28 entities, 4 state machines, cross-module reference map |
| [`contracts/`](./2026-08-21-mercato-connect-omnichannel/contracts/) | REST surface, peer read facades, telephony adapter, events, ACL, UI extension points |
| [`tasks.md`](./2026-08-21-mercato-connect-omnichannel/tasks.md) | P1 execution plan — 86 tasks across 6 phases |
| [`quickstart.md`](./2026-08-21-mercato-connect-omnichannel/quickstart.md) | V1–V14 validation scenarios and the validation gate |
| [`checklists/requirements.md`](./2026-08-21-mercato-connect-omnichannel/checklists/requirements.md) | Spec quality validation (16/16) |

Sections below summarise and add what the artifact set has no slot for: risk review, compliance status and changelog. Where they disagree with an artifact, the artifact wins.

## Problem Statement

A service team today switches between a telephony console, a shared mailbox, several social inboxes and the commerce back office. Context is lost at every switch:

- The customer repeats themselves — a caller yesterday who writes on WhatsApp today starts from zero.
- Agents re-derive order state by hand, so answers are slow and sometimes wrong.
- Nobody can see that a promised response time is about to be missed until it already has been.
- Identity is fragmented: the same person is a phone number in one tool, an e-mail in another, a handle in a third.
- Every tool is bought, learned and paid for separately, including capabilities a given team never uses.

The platform already has the raw material — channel connections, message storage, thread mapping, contact resolution, customer records, a portal framework — but no product surface that turns it into a shift-long agent workspace.

## Proposed Solution

Eight modules, each independently enableable because modularity is a product requirement (FR-071–074), not packaging taste:

| Module | Delivers | Priority |
|---|---|---|
| `conversations` | Cross-channel unified thread, assignment, routing, identity merge, AI assist panel. **Core — non-disableable.** | P1 |
| `service_tickets` | Cases with SLA clock, status machine, export | P2 |
| `contact_queues` | Queues, routing config, live wallboard, agent session state | P2 |
| `telephony` | Vendor-neutral adapter contract, call events, IVR flow definition and publish, recording policy | P2/P3 |
| `contact_analytics` | KPI aggregation and dashboard widgets | P3 |
| `contact_campaigns` | Outbound campaigns, retry/callback rules, consent suppression | P3 |
| `bot_intents` | Shared intent set across chatbot/voicebot/IVR, containment reporting, knowledge gaps | P3 |
| `contact_quality` | Recording index, scorecards, review-queue selection | P3 |

Plus provider packages: `packages/channel-meta/` (Messenger, Instagram adapters) and `packages/telephony-<vendor>/`.

P1 (`conversations` + AI assist) is independently shippable and is the product's proof; everything else layers on.

## Architecture

### Composition boundary

The delivery adds a **thread-level aggregate** over existing per-channel records. Full reuse-vs-build table: [`spec.md` § Platform composition](./2026-08-21-mercato-connect-omnichannel/spec.md).

The load-bearing finding, verified against source: `communication_channels.ChannelThreadMapping.message_thread_id` already maps many per-channel `ExternalConversation` rows onto one `messages.Message.thread_id`, and `messages` has no `MessageThread` entity — a thread is just a shared UUID. **The cross-channel primitive already exists and is unused at the product level.** So the unified thread is an aggregation problem, not a storage one, and "one record visible from two surfaces" (FR-088) comes free rather than needing sync machinery.

New `ServiceConversation` keys on `(tenant_id, organization_id, thread_id)` and owns what the thread does not: assignment, queue, routing priority, SLA state, open/closed, customer binding.

### Voice boundary

Mercato Connect owns routing rules, flow and campaign definitions, recording policy, context supply, agent experience and reporting. The provider owns call transport, softphone media, queue and IVR execution, and recording capture. Split table: [`spec.md` § Voice boundary](./2026-08-21-mercato-connect-omnichannel/spec.md).

`TelephonyAdapter` deliberately mirrors the existing `ChannelAdapter` shape so `integrations` registry/credentials/health apply unchanged and vendor swap is an integration-surface change only.

### Cross-module rules honoured

- No cross-module ORM relations — FK-id + `*_snapshot jsonb` throughout.
- Optional peers resolved via module-local `tryResolve`; no hard `requires`. Capabilities degrade with a named explanation.
- Reach is one-directional: contact-centre modules resolve platform peers, never the reverse. No platform module gains an import of the suite.
- Real-time via the existing DOM Event Bridge (SSE), payloads carrying ids and counters only — never message bodies or PII.

## Data Models

28 entities. Full field-level detail, indexes, encryption and state machines: [`data-model.md`](./2026-08-21-mercato-connect-omnichannel/data-model.md).

| Module | Entities |
|---|---|
| `conversations` | `ServiceConversation`, `ConversationChannelBinding`*, `CustomerIdentity`, `IdentityMergeAudit`*, `AiSuggestionOutcome`* |
| `service_tickets` | `ServiceTicket`, `TicketStatusHistory`* |
| `contact_queues` | `ContactQueue`, `QueueMembership`*, `AgentSession`, `QueueSnapshot`* |
| `telephony` | `TelephonyProviderConnection`, `VoiceFlow`, `VoiceRoutingRule`, `CallRecord`, `CallEvent`*, `RecordingPolicy` |
| `contact_campaigns` | `Campaign`, `CampaignRule`, `CampaignAttempt`* |
| `bot_intents` | `BotIntent`, `IntentMetric`*, `HandoffRule`, `KnowledgeGap` |
| `contact_quality` | `QualityReview`, `ScorecardCriterion`, `ScorecardResult` |
| `contact_analytics` | `ContactMetricRollup`* |

`*` = append-only or junction, taking the documented optimistic-locking exemption. Every other entity carries `updated_at` and returns `updatedAt`.

Four state machines: conversation lifecycle, ticket status, campaign run state, call lifecycle.

## API Contracts

Full surface: [`contracts/rest-api.md`](./2026-08-21-mercato-connect-omnichannel/contracts/rest-api.md). Summary of the shape:

- CRUD via `makeCrudRoute` with `indexer.entityType`; every route file exports `openApi`.
- Custom write routes map to a mutation-guard operation and call `runMutationGuards` before mutating.
- Optimistic locking default-ON; conflicting writes return 409 with the standard body.
- Non-obvious routes: `POST /api/conversations/conversations/take-next` (routing-aware assignment, 204 when empty), `POST /api/conversations/conversations/[id]/reply` (send on any connected channel into the same thread), `POST /api/conversations/identities/{merge,split,recheck}`, `POST /api/telephony/webhook/[provider]` (unauthenticated, signature-verified, idempotent).

Companion contracts: [telephony adapter](./2026-08-21-mercato-connect-omnichannel/contracts/telephony-adapter.md), [events](./2026-08-21-mercato-connect-omnichannel/contracts/events.md), [ACL](./2026-08-21-mercato-connect-omnichannel/contracts/acl.md), [UI extension](./2026-08-21-mercato-connect-omnichannel/contracts/ui-extension.md).

## Risks & Impact Review

| # | Failure scenario | Severity | Affected area | Mitigation | Residual risk |
|---|---|---|---|---|---|
| R1 | Thread aggregation binds two different customers' channel conversations into one thread, exposing one customer's messages to another. | **Critical** | `conversations` identity + thread binding | Binding requires a `CustomerIdentity` match above threshold; `ConversationChannelBinding` is append-only with `detached_at` so a wrong bind is reversible; merge/split audited; V13 tenancy suite plus a dedicated mis-bind test. | Low. A heuristic match at high confidence could still be wrong; `match_method='heuristic'` bindings stay agent-visible and reversible rather than silent. |
| R2 | Cross-tenant leak through a new list, search, export or portal route. | **Critical** | All eight modules | Composite `(tenant_id, organization_id)` on every entity; scope from authenticated context only; `makeCrudRoute` enforcement; V13 asserts isolation per entity across list/search/export/portal. | Low, but this is the single hardest gate — V13 is non-negotiable before merge. |
| R3 | AI sends a reply the agent never saw. | **Critical** | `conversations` AI assist | Suggestions route through `ai-assistant` `prepareMutation`; insert places editable text and sends nothing; V2 carries an explicit negative assertion (SC-005) that runs on every build. | Very low — enforced by the platform's approval boundary, not by convention. |
| R4 | Provider outage makes the wallboard show stale figures as if live; a supervisor staffs against fiction. | High | `contact_queues`, `telephony` | `capturedAt` + `degraded` on every provider read; `queue.degraded` / `provider.degraded` events; UI renders data age; V5 asserts the degraded path. | Low. Depends on the provider reporting degradation honestly; T-05 makes it a contract requirement on implementers. |
| R5 | Consent-withdrawn or closed-case customer contacted by an outbound campaign. | High | `contact_campaigns` | Consent enforced at send time, not display time; `suppress_on_closed_case` defaults true; `CampaignAttempt.suppressed_reason` makes suppression auditable; subscriber on ticket close. | Low. Regulatory exposure makes this worth an explicit audit review before campaigns ship. |
| R6 | SLA clock ignores working hours, so cases are reported as breached that never were (or vice versa). | High | `service_tickets` | Working-hours arithmetic in `computeSlaState`; `sla_target_minutes` snapshotted at creation so later rule changes cannot retroactively breach past cases; pause accumulates at transitions. | Medium. Timezone and holiday-calendar handling is genuinely fiddly and deserves dedicated property tests. |
| R7 | Call `ended` event never arrives; conversation stuck in-progress indefinitely, corrupting AHT and occupancy. | Medium | `telephony` | Events ordered by `occurredAt` not arrival; reconciliation sweep worker closes stranded calls and emits `call.reconciled`; T-03/T-04 are contract requirements on implementers. | Low. Reconciled calls have approximate durations — acceptable, and visible as reconciled rather than passed off as measured. |
| R8 | Eight new modules materially slow `yarn generate`, dev boot or app build. | Medium | Build/dev experience across the repo | Modules live in an optional workspace package, not `packages/core`; disabled modules skip discovery. | Medium. Not measurable until built — worth a build-time check at the end of P1 before P2/P3 land. |
| R9 | Reporting via `query_index` misses the SC-003 latency budget at real contact volumes. | Medium | `contact_analytics` | Research R-12 keeps the decision open with an identical read API either way, so a rollup table can be introduced without changing callers. | Medium by design — deliberately deferred until real cardinality exists. |
| R10 | `ChannelCapabilities.voice?: boolean` breaks a third-party channel adapter. | Low | `communication_channels` public type | Optional field; `realtimePush?: boolean` is the in-file precedent with identical omit-means-default semantics; ADDITIVE-ONLY per `BACKWARD_COMPATIBILITY.md`. | Very low. |
| R11 | Polish-only prototype copy leaks into shipped code as hard-coded strings. | Low | All UI | `pl` + `en` locale files per module; `yarn i18n:check-sync` / `check-usage` in the gate; `check-hardcoded` in the DoD. | Low. |
| R12 | Prototype's inline styles are copied verbatim, violating DS rules. | Low | All UI | `contracts/ui-extension.md` maps every prototype inline pattern to its DS primitive; `om-ds-guardian` review before merge. | Low, but needs reviewer attention — the prototype violates the hardcoded-colour, arbitrary-value and raw-`<button>` rules throughout. |

### Migration & Backward Compatibility

- **Additive only.** One shared-surface change: `ChannelCapabilities.voice?: boolean` (R10).
- No existing entity, route, event ID, DI key or ACL feature is renamed, removed or narrowed.
- No platform module gains an import of, or dependency on, a contact-centre module — upstream isomorphism preserved, verified by `module-decoupling.test.ts`.
- New ACL features require `yarn mercato auth sync-role-acls` for existing tenants.

## UI/UX

The source design prototype covers 13 screens. Component-level mapping — which prototype pattern becomes which design-system primitive, the widget spot IDs, DataTable ids, portal pages and interaction requirements — is in [`contracts/ui-extension.md`](./2026-08-21-mercato-connect-omnichannel/contracts/ui-extension.md). Note that the prototype styles everything inline; none of that ships.

## Integration Test Coverage

Root `AGENTS.md` requires every feature spec to list integration coverage for all affected API and key UI paths, shipping in the same change.

| Path | Coverage |
|---|---|
| Cross-channel thread, reply, take-next, close (US1) | V1 — `quickstart.md`; tasks T056, T051 |
| AI assist, insert/reject, never-auto-send (US2) | V2 + SC-005 negative assertion — tasks T069, T070 |
| Identity merge reversal | tasks T058 (integration), T059 (unit) |
| Cache invalidation incl. inbound path | task T061 |
| Command undo round-trip | task T062 |
| Tenancy isolation across all new entities | V13 — task T057 (hard gate) |
| Absent-module degradation | V14 — tasks T079, T080 |
| Render budget (SC-003) | task T081 |

Full scenarios: [`quickstart.md`](./2026-08-21-mercato-connect-omnichannel/quickstart.md) V1–V14. Execution plan: [`tasks.md`](./2026-08-21-mercato-connect-omnichannel/tasks.md).

## Phasing & Implementation Plan

Six phases, 87 tasks, P1 only. Setup → Foundational → **Peer read facades** (blocking) → US1 → US2 → Polish. Detail and dependency graph: [`tasks.md`](./2026-08-21-mercato-connect-omnichannel/tasks.md); technical context and constitution check: [`plan.md`](./2026-08-21-mercato-connect-omnichannel/plan.md).

## Final Compliance Report

**Not yet applicable — nothing has been implemented.**

Status as of 2026-08-21:

| Gate | Status |
|---|---|
| Spec quality checklist | ✅ 16/16 + 13/13 repo spec-content items, **re-validated run 3** after all remediation ([checklists/requirements.md](./2026-08-21-mercato-connect-omnichannel/checklists/requirements.md)) |
| Constitution check (pre-design) | ✅ 12/12 PASS |
| Constitution check (post-design) | ✅ 12/12 PASS |
| Open clarifications | ✅ none — both resolved 2026-08-21 |
| Deferred decisions | 2 (R-10 telephony vendor, R-12 reporting aggregation) — recorded with settling criteria, neither blocks implementation |
| Readiness audits | ✅ 2 passes — ANALYSIS-051 (C1–C7 closed), ANALYSIS-052 (D1–D5 closed) |
| Formal spec review | ⚠️ run 2026-08-21 ([ANALYSIS-053](./analysis/ANALYSIS-053-2026-08-21-mercato-connect-architectural-review.md)) — **request changes**: 1 Critical (A1 unencrypted `customer_snapshot`), 2 High (A2 scope bundle, A3 no flow rollback). Self-review — needs independent confirmation. |
| PR / pipeline labels | ⬜ no PR opened |
| `agents:check-budget` | ❌ fails on root `AGENTS.md` size — **pre-existing**, verified independent of this branch |
| `yarn build:packages` / `generate` / `typecheck` / `test` / `build:app` | ⬜ not run — no code exists |
| Integration coverage (V1–V14) | ⬜ not written |
| DS review (`om-ds-guardian`) | ⬜ pending implementation |

Compliance is re-reported here after implementation, per `.ai/specs/AGENTS.md` § After coding. The validation gate and definition of done are in [`quickstart.md`](./2026-08-21-mercato-connect-omnichannel/quickstart.md).

## Changelog

| Date | Change |
|---|---|
| 2026-08-21 | **Formal architectural review** run against the `om-spec-writing` staff-engineer rubric → [ANALYSIS-053](./analysis/ANALYSIS-053-2026-08-21-mercato-connect-architectural-review.md). Verdict **request changes**. Checklist 5 pass / 3 partial / 2 fail. **A1 (Critical)**: `customer_snapshot` holds name and e-mail on three entities and is in no encryption map — a hard-rule violation both readiness audits missed, because they checked that encryption was *addressed* rather than *complete*. **A2 (High)**: eight independently-deployable capabilities in one spec; the rubric says split. **A3 (High)**: voice-flow publish has no rollback despite `version`/`published_version` already existing. A8 (stale task ref) fixed immediately. A1 must be closed before implementation. |
| 2026-08-21 | **Spec-phase closeout.** Remaining audit items closed: C4 (per-method route `metadata` — read authorisation had no stated home), C5 (`packages/core/AGENTS.md:76` documented API URL derivation without the module-id prefix — fixed at source), C6 (encrypted `CustomerIdentity.identifier` excluded from the search document), C7 (this file gained Integration Test Coverage, UI/UX and Phasing sections; "Impact on existing modules" renamed to "Migration & Backward Compatibility"). Traceability gap closed: `AI suggestion outcome` added to spec.md § Key Entities, which the design carried but the requirements did not. **Entity count corrected 22/23 → 28** — the per-module table was always right; the headline was miscounted and propagated. Edge cases 26 → 25. Task count 86 → 87. Checklist re-validated (run 3). |
| 2026-08-21 | Skills installed (`corepack yarn install-skills`, 15 local + 36 external), closing the pre-implement audit's known blind spot. **Second audit pass → [ANALYSIS-052](./analysis/ANALYSIS-052-2026-08-21-mercato-connect-p1-readiness-pass2.md)**: verified C1/C3 closed and C2 only *partially*; the newly-available code-review checklist found three majors, all on the **system-initiated** write path — no cache invalidation on inbound messages, no timeout on the outbound provider call, and check-then-act on conversation creation. **D1–D5 closed**; no new tasks (86 unchanged). |
| 2026-08-21 | `/speckit-tasks` (P1 scope) → 79 tasks. `/speckit-analyze` → 12 findings; **F1 (CRITICAL)** fixed — merge reversal pulled from P2 into P1 so the slice never creates an identity merge it cannot undo. `/om-pre-implement-spec` → [ANALYSIS-051](./analysis/ANALYSIS-051-2026-08-21-mercato-connect-p1-readiness.md); **C1/C2/C3 closed** — peer read facades (new `messages/di.ts`), cache tag + invalidation strategy, command undo payloads. Task count 79 → 86. BC audit clean on all 13 surfaces. Still not implemented. |
| 2026-08-21 | Added `AiSuggestionOutcome` (append-only) to `conversations` during task generation — FR-020 and FR-025/SC-004 had no persistence home. Entity count 22 → 23. |
| 2026-08-21 | Spec created from the Claude Design prototype (13 screens, 1915 lines) — 12 user stories, 100 FRs, 22 success criteria. Two scope questions raised and answered: compose on top of existing modules; voice via external provider. Implementation plan, research (12 decisions), data model (28 entities), five contract documents and validation guide added. Relocated from `specs/001-mercato-connect-omnichannel/` to the repository's `.ai/specs/` convention. Not implemented. |

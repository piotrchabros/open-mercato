# Phase 0 Research: Mercato Connect

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-08-21

Each decision below resolves an unknown in the plan's Technical Context. Every claim about existing platform behaviour was verified against source in this worktree; file references are given so they can be re-checked.

---

## R-01 — How to represent one conversation across several channels

**Decision**: Reuse `Message.threadId` as the join key. A new `ServiceConversation` aggregate keys on `(tenant_id, organization_id, thread_id)` and owns everything the thread itself does not: assigned agent, queue, routing state, SLA deadline, open/closed state, and the customer binding.

**Rationale**: The platform already has every piece except the aggregate.

- `communication_channels/data/entities.ts` — `ExternalConversation` is **per-channel** (carries `channel_id`, `external_conversation_id`, `contact_person_id`, `assigned_user_id`). One customer contacting on WhatsApp and phone produces two rows.
- The same file's `ChannelThreadMapping` maps `external_conversation_id` → `message_thread_id`. Many external conversations can already point at one thread — the cross-channel primitive exists and is unused at the product level.
- `messages/data/entities.ts` — `Message.threadId` is a nullable UUID with `messages_thread_idx`. There is no `MessageThread` entity; a thread is just a shared id. So binding N channels to one thread requires no schema change to either module.

This makes the unified thread (FR-009, US1) an *aggregation* problem, not a storage problem, which is what "compose on top" is supposed to mean. It also satisfies FR-088/SC-018 (one record, two surfaces) for free: both surfaces read the same `Message` rows.

**Access path (added 2026-08-21, ANALYSIS-051 C1)**: the join key is `thread_id`, but `conversations` MUST NOT query the peer tables to follow it. `.ai/lessons.md` → *"Cross-module query precedent is not permission to copy storage coupling"* requires peer-table access to sit behind a DI service **owned by the source module**. Note that `communication_channels/di.ts` registers its entity classes explicitly "for EntityManager lookups by string" — that is not a read API; the sanctioned precedent in the same file is `communicationChannelsSendAsUser`, an in-process facade. So both peers gain a read facade (`communicationChannelsThreadReader`; a new `messages/di.ts` + `messagesThreadReader`), consumed fail-soft via `tryResolve`. Both are new DI keys — additive, BC surface #9, no deprecation bridge.

**Alternatives considered**:
- *A new `contact_center_messages` table mirroring external messages* — rejected. Creates the exact dual-write divergence FR-088 forbids, and doubles storage for no gain.
- *Extend `ExternalConversation` with a parent-conversation FK* — rejected. Mutates another module's core entity, which `packages/core/AGENTS.md` line 497 forbids ("never mutate core entities"), and would be a FROZEN-surface DB change.
- *Model the thread as a first-class `MessageThread` entity in `messages`* — rejected for this delivery. It is the cleaner long-term model but changes a shared module's schema and contract for a consumer-specific need; revisit separately if a second consumer appears.

---

## R-02 — Cross-channel identity resolution with confidence and reversal

**Decision**: Layer two new entities in `conversations` over the existing resolver: `CustomerIdentity` (channel identifier → `customers.person` id, with `confidence`, `match_method`, `verified_at`) and `IdentityMergeAudit` (append-only record of every merge/split with actor, time, prior state). The existing `communication_channels/lib/contact-resolver.ts` keeps doing per-channel resolution; the new layer does cross-channel unification.

**Rationale**: FR-026 needs a *score* and agent-visible inspection; FR-027 needs reversal. The existing resolver returns a contact hint (`ContactHint` in `lib/adapter.ts:382`) but does not persist a confidence or an audit trail, so neither requirement can be met by configuration alone. Splitting the concerns keeps the resolver's contract untouched (additive) while giving the merge layer the durable history reversal requires.

**Alternatives considered**:
- *Store merges as custom fields on `customers.person`* — rejected. Custom fields are not append-only and give no reversal history; the audit would be destroyed by the next merge.
- *Merge destructively by rewriting `contact_person_id` on external conversations* — rejected. Irreversible, and FR-027 requires the opposite.

---

## R-03 — Where SLA is computed

**Decision**: A pure function `computeSlaState(deadline, now, workingHours, target)` in `service_tickets/lib/sla-clock.ts`, called on read; the persisted columns are `sla_deadline_at` and `sla_paused_ms`, not a live countdown. Working-hours arithmetic excludes non-working intervals per FR-037.

**Rationale**: A persisted "remaining time" column would need a writer on every clock tick — unbounded write amplification across every open case. Computing on read keeps the store append-light and makes the health thresholds (healthy / at-risk / breached) a presentation concern. Pausing (waiting-on-customer) accumulates into `sla_paused_ms` at state transitions, which are already write events.

**Alternatives considered**:
- *Scheduled job recomputing remaining time* — rejected. Adds a failure mode where the displayed clock is as stale as the last job run, and SC-014 depends on the clock being right at read time.
- *Wall-clock deadline ignoring working hours* — rejected outright; FR-037 requires working-hours arithmetic, and it is the difference between an honest and a dishonest SLA number.

---

## R-04 — Live wallboard transport

**Decision**: DOM Event Bridge over SSE. `contact_queues` declares its live events with `clientBroadcast: true`; the wallboard consumes them with `useAppEvent('contact_queues.*', …)`. A client-side staleness guard renders the data's age when no event has arrived within the expected window.

**Rationale**: `packages/events/AGENTS.md` § DOM Event Bridge documents exactly this path — server-side audience filtering by tenant/organisation/user/role before send, 30 s heartbeats, 45 s client reconnect, 500 ms dedup. SC-008 requires ≤ 10 s staleness *and* that staleness beyond that is stated rather than hidden; the heartbeat gives the client a reliable signal for the second half. The prototype's 4-second refresh is recorded in the spec as a tuning default (Assumption 4), not a requirement, so an event-driven push comfortably beats it.

Payload budget: the bridge caps events at 4096 bytes. Queue-delta events carry counters and ids only — never queue contents — so the cap is not a constraint. This is a design constraint on the event payloads, recorded in [contracts/events.md](./contracts/events.md).

**Alternatives considered**:
- *Client polling every 4 s* — rejected. Reproduces the prototype literally, but costs one request per agent per 4 s per open wallboard and still cannot distinguish "nothing changed" from "connection died", which SC-008 requires.
- *WebSocket channel* — rejected. New transport, new infrastructure, and the SSE bridge already carries audience filtering and reconnect that a raw socket would have to reimplement.

---

## R-05 — Reply on a different channel than the inbound one

**Decision**: The reply route resolves the target `CommunicationChannel` for the chosen channel type, calls the existing adapter's `sendMessage`, and writes the resulting `Message` with the *same* `threadId`, plus a `MessageChannelLink` binding it to that channel's external conversation.

**Rationale**: FR-013 is the sharpest test of the composition decision. The existing `ChannelAdapter.sendMessage` (`lib/adapter.ts:55`) already takes `credentials` and `scope` and returns `externalMessageId` + `conversationId`, and `MessageChannelLink` (`data/entities.ts:269`) already carries `message_id`, `external_conversation_id`, `provider_key`, `channel_type`, `direction` and `delivery_status`. So cross-channel reply is a routing decision at send time, not new delivery machinery. Delivery failure surfaces through `delivery_status`, which the thread renders per the "send fails after submission" edge case.

**Alternatives considered**:
- *Force replies onto the inbound channel* — rejected; contradicts FR-013 and one of the product's headline behaviours.
- *A new outbound abstraction over adapters* — rejected as redundant; `sendMessage` is already that abstraction.

---

## R-06 — Telephony provider contract

**Decision**: A new `TelephonyAdapter` interface in `contact-center/src/modules/telephony/lib/adapter.ts`, deliberately mirroring the shape and lifecycle of the existing `ChannelAdapter`: a `capabilities` object, credential validation and refresh, webhook verification, inbound normalisation, and an outbound action set. Vendor packages live in `packages/telephony-<vendor>/`.

**Rationale**: FR-100 and SC-022 require the vendor to be replaceable with changes confined to the integration surface. The `ChannelAdapter` is a proven in-repo answer to the same problem — `packages/channel-gmail` and `packages/channel-imap` are existing provider packages implementing it — so mirroring it means reviewers already know the shape, and `integrations` (`lib/registry-service.ts`, `credentials-service.ts`, `health-service.ts`) supplies registry, credentials and health without new infrastructure.

**Alternatives considered**:
- *Extend `ChannelAdapter` itself to cover voice* — rejected. Voice needs call-lifecycle, queue-state and agent-state operations that have no meaning for a text channel; widening the shared interface would force every existing adapter to carry dead surface, and it would be a FROZEN-surface change.
- *Direct vendor SDK calls from the telephony module* — rejected; violates FR-100 by construction.

---

## R-07 — Voice as a channel in the unified thread

**Decision**: Calls appear in the thread as `Message` rows of a `call` type, written by a subscriber on telephony call events, carrying duration, direction, recording reference and transcript reference — not the media itself.

**Rationale**: FR-095 requires call events attached to the correct conversation and visible in the unified thread alongside other channels; US1 acceptance scenario 1 shows a phone call and a WhatsApp message in one list. Writing them as messages means the thread renderer, search indexing and the customer timeline all get calls for free. Media stays with the provider (FR-092), so the row holds references.

**Alternatives considered**:
- *A separate call-history panel beside the thread* — rejected. Reintroduces exactly the context-switching the product exists to remove, and fails US1 scenario 1.

---

## R-08 — AI assistance wiring

**Decision**: Use `@open-mercato/ai-assistant` — `defineAiAgent` for the case-summary and suggestion agents, `defineAiTool` for the next-action tools, and `prepareMutation` for any tool that writes. Suggestion sources are returned as structured citations, not prose.

**Rationale**: FR-019 (never auto-send), FR-021 (every suggestion cites sources) and FR-022 (next actions execute and report explicitly) map exactly onto the package's existing mutation-approval flow, which already requires human confirmation before a tool mutates. Reimplementing approval would be both redundant and a weaker guarantee than the audited path. Provider and model selection stay with the operator's existing AI configuration (Assumption 8), so no provider is hard-coded.

**Alternatives considered**:
- *Direct SDK calls from the conversations module* — rejected. Bypasses mutation approval, tool-pack RBAC and per-tenant model settings, and would make FR-019 an implementation promise rather than an enforced boundary.

---

## R-09 — Declaring voice capability on channels

**Decision**: Add an optional `voice?: boolean` to `ChannelCapabilities` in `communication_channels/lib/adapter.ts`.

**Rationale**: The channel list, filters and reporting are channel-type-driven across every screen; voice must be selectable there. `ChannelCapabilities` already carries optional capability flags with exactly this shape — `realtimePush?: boolean` at line 50 is the precedent, with the same "omit means legacy default" semantics. `BACKWARD_COMPATIBILITY.md` classifies adding an optional field to a public type as ADDITIVE-ONLY, so no deprecation protocol applies and no existing adapter breaks.

**Alternatives considered**:
- *A separate voice-capability registry* — rejected. Splits one question ("what can this channel do?") across two sources.
- *Making the field required* — rejected; that **would** be a breaking change to a STABLE surface and would need the deprecation protocol.

---

## R-10 — First telephony vendor · **open, carried to `/speckit-tasks`**

**Decision deferred.** The `TelephonyAdapter` contract (R-06) is vendor-neutral by construction, so the choice changes only which `packages/telephony-<vendor>/` gets written first.

**What the choice must satisfy**, so it can be made quickly later: inbound webhooks with verifiable signatures; call-lifecycle events (started, answered, queued, transferred, ended); programmable routing that accepts context supplied at call time (FR-094); recording with a retrievable reference; queue and agent state readable during a call (FR-096); bidirectional agent-state sync (FR-097); and a publish/verify path for flow configuration (FR-098).

**Note for planning**: `.ai/specs/2026-04-21-crm-call-transcriptions.md` plus the tldv and Zoom adapter specs already establish an in-repo transcription-adapter pattern. Where the telephony vendor supplies transcripts, prefer its own; where it does not, that existing pattern fills the gap (spec Assumption 14).

---

## R-11 — Module decomposition and toggle boundary

**Decision**: Eight modules in one new workspace package, one module per independently-toggleable capability: `conversations` (core, non-disableable), `service_tickets`, `contact_queues`, `contact_analytics`, `contact_campaigns`, `bot_intents`, `telephony`, `contact_quality`.

**Rationale**: FR-071 to FR-074 make the toggle boundary a product requirement — each capability enableable, dependencies declared, disabling removes it from navigation, disabling the current screen returns the user somewhere valid. Since the platform's unit of enable/disable *is* the module, capability granularity and module granularity must coincide. `packages/enterprise` establishes the multi-module-package precedent (`record_locks`, `security`, `sso`, `system_status_overlays`).

Dependency declarations, matching the prototype's own settings copy: `service_tickets` → `conversations`; `contact_queues` → `conversations` + at least one real-time channel; `contact_campaigns` → `telephony` or SMS; `bot_intents` → `conversations`; `contact_quality` → `telephony`; `contact_analytics` → none; `telephony` → a connected provider.

**Alternatives considered**:
- *One `contact_center` module* — rejected; makes every capability all-or-nothing and fails FR-071/072/073 and US6 outright.
- *Modules inside `packages/core`* — rejected; grows the mandatory surface for tenants who will never run a contact centre, against the direction `staff` is already moving in.

---

## R-12 — Reporting aggregation strategy · **open, carried to `/speckit-tasks`**

**Decision deferred**, with a default to start from: aggregate through the existing `query_index` projections, and only introduce a purpose-built rollup table if measured list and dashboard latency misses SC-003.

**Rationale for deferring**: the right answer depends on real cardinality — contact volume per tenant per period — which no amount of up-front reasoning substitutes for. Starting on `query_index` costs nothing to reverse (the rollup can be added behind the same read API), whereas building a rollup pipeline first risks unnecessary machinery. The read API shape in [contracts/rest-api.md](./contracts/rest-api.md) is deliberately identical under either implementation, so the decision stays reversible.

**Trigger to revisit**: dashboard or list p90 exceeding the SC-003 budget on representative data, or per-agent aggregation showing N+1 behaviour under the `query_index` path.

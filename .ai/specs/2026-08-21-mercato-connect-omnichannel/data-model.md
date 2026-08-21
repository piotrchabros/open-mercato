# Phase 1 Data Model: Mercato Connect

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

## Conventions

Applies to every entity below; not repeated per row.

- Tables are plural `snake_case`, prefixed with the owning module. Columns are `snake_case`; TypeScript fields are `camelCase`.
- Every entity carries `id uuid PK`, `tenant_id uuid NOT NULL`, `organization_id uuid NOT NULL`, `created_at timestamptz NOT NULL`, and a composite index on `(tenant_id, organization_id)`.
- Soft-deletable entities add `deleted_at timestamptz NULL`.
- **User-editable entities add `updated_at timestamptz NULL`** (`onCreate`/`onUpdate`) and return `updatedAt` in list/detail responses so OSS optimistic locking (default ON) works. Entities marked *append-only* below take the documented exemption (append-only logs, junction rows, background-job rows).
- **No cross-module ORM relations.** References to another module's records are plain `uuid` columns plus a denormalised `*_snapshot jsonb` where the read must survive the peer being absent or changed. `@ManyToOne` is used only within a module.
- Entity ids follow `<module>:<entity>` and are consumed from `E.<module>.<entity>` generated ids, never hard-coded strings.
- GDPR-relevant columns are declared in each module's `encryption.ts` `defaultEncryptionMaps`; reads use `findWithDecryption` / `findOneWithDecryption`.

---

## Module: `conversations` (P1, core — non-disableable)

### `ServiceConversation` → `conversations_service_conversations`

The aggregate that makes a cross-channel thread a unit of work. Keys on the existing `Message.threadId` (research R-01).

| Column | Type | Notes |
|---|---|---|
| `thread_id` | uuid NOT NULL | Join key into `messages.messages.thread_id`. Unique per `(tenant_id, organization_id, thread_id)`. |
| `customer_id` | uuid NULL | FK-id into `customers.person`. Null until identity is resolved (unrecognised-caller edge case). |
| `customer_snapshot` | jsonb NULL | Denormalised name, initials, e-mail, VIP flag, value metrics — read survives `customers` being absent. |
| `primary_channel_type` | varchar(32) NOT NULL | Channel the conversation originated on. |
| `reply_channel_type` | varchar(32) NULL | Agent's currently selected reply channel (FR-013). |
| `assigned_user_id` | uuid NULL | Null = unassigned. |
| `queue_id` | uuid NULL | FK-id into `contact_queues`; null when that module is disabled. |
| `state` | varchar(24) NOT NULL | See state machine below. |
| `priority` | smallint NOT NULL | Routing priority, derived from SLA and customer value. |
| `sla_deadline_at` | timestamptz NULL | Mirrors the linked ticket's deadline when one exists. |
| `last_activity_at` | timestamptz NOT NULL | Drives list ordering and "time since" display. |
| `closed_at` | timestamptz NULL | |
| `closing_summary` | text NULL | After-contact summary (FR-016, FR-024). Encrypted. |
| `updated_at` | timestamptz NULL | Optimistic locking — two agents must not silently overwrite (FR-038). |

Indexes: `(tenant_id, organization_id, state, last_activity_at DESC)` for the inbox list; `(tenant_id, organization_id, assigned_user_id, state)`; unique `(tenant_id, organization_id, thread_id)`.

**State machine** (FR-016, US1):

```
open ──assign──> assigned ──close──> closed
 │                   │                  │
 │                   └──unassign────────┘ (back to open)
 └──close──> closed          closed ──reopen──> open
```

`closed` requires `closing_summary` to be non-null when after-contact summarisation is enabled.

### `ConversationChannelBinding` → `conversations_channel_bindings`  *(append-only)*

Records which `ExternalConversation` rows were folded into this thread, and when. Makes the merge auditable and lets an incorrectly-folded channel be detached.

| Column | Type | Notes |
|---|---|---|
| `service_conversation_id` | uuid NOT NULL | `@ManyToOne` — same module, allowed. |
| `external_conversation_id` | uuid NOT NULL | FK-id into `communication_channels.external_conversations`. |
| `channel_type` | varchar(32) NOT NULL | |
| `bound_at` / `detached_at` | timestamptz | `detached_at` null while active. **Do not enforce "one active binding per external conversation" with a partial unique index** — lesson *"PostgreSQL partial unique indexes are not constraints"*. Enforce it in the command layer. |
| `bound_by_user_id` | uuid NULL | Null when bound automatically. |

### `CustomerIdentity` → `conversations_customer_identities`

Cross-channel identifier → customer, with the confidence FR-026 requires.

| Column | Type | Notes |
|---|---|---|
| `customer_id` | uuid NOT NULL | FK-id into `customers.person`. |
| `channel_type` | varchar(32) NOT NULL | |
| `identifier` | varchar(320) NOT NULL | Phone, e-mail, social handle, portal account id. **Encrypted** (GDPR). |
| `identifier_hash` | varchar(64) NOT NULL | Deterministic hash for lookup without decryption. Unique per `(tenant, org, channel_type, identifier_hash)`. |
| `confidence` | numeric(4,3) NOT NULL | 0.000–1.000 (FR-026). |
| `match_method` | varchar(32) NOT NULL | `exact` \| `verified` \| `heuristic` \| `manual`. |
| `verified_at` | timestamptz NULL | Set when an agent confirms the match. |
| `updated_at` | timestamptz NULL | User-editable (agents confirm/reject matches). |

### `IdentityMergeAudit` → `conversations_identity_merge_audits`  *(append-only)*

Makes FR-027 (reversal) possible: every merge and split, with enough prior state to undo it.

| Column | Type | Notes |
|---|---|---|
| `operation` | varchar(16) NOT NULL | `merge` \| `split`. |
| `source_customer_id` / `target_customer_id` | uuid NOT NULL | |
| `identity_ids` | jsonb NOT NULL | Identities moved by this operation. |
| `prior_state` | jsonb NOT NULL | Enough to reverse the operation. |
| `confidence` | numeric(4,3) NULL | |
| `actor_user_id` | uuid NULL | Null when automatic. |

### `AiSuggestionOutcome` → `conversations_ai_suggestion_outcomes`  *(append-only)*

Every suggestion the assist panel shows, and what the agent did with it. Without this row FR-020 ("rejections MUST be recorded") and FR-025 / SC-004 (acceptance rate ≥ 70%) have nowhere to be measured from.

| Column | Type | Notes |
|---|---|---|
| `service_conversation_id` | uuid NOT NULL | |
| `suggestion_kind` | varchar(24) NOT NULL | `reply` \| `summary` \| `next_action`. |
| `template_key` | varchar(128) NULL | Groups outcomes into the suggestion library for per-template acceptance (FR-025). |
| `outcome` | varchar(16) NOT NULL | `inserted` \| `inserted_edited` \| `rejected` \| `rewrite_requested` \| `ignored`. |
| `agent_user_id` | uuid NOT NULL | |
| `sources` | jsonb NOT NULL | Structured citations shown with the suggestion (FR-021). Empty array is a contract violation, not a valid value. |
| `edit_distance` | integer NULL | Set on `inserted_edited` — separates "accepted as-is" from "accepted after rework" so SC-004 is not gamed by heavy edits. |
| `model_ref` | varchar(128) NULL | Which model produced it, for regression analysis across model changes. |
| `occurred_at` | timestamptz NOT NULL | |

Indexes: `(tenant_id, organization_id, occurred_at)` for period reporting; `(tenant_id, organization_id, template_key, outcome)` for the library view.

`ignored` is written when a conversation closes with a suggestion shown but never acted on — otherwise acceptance rate is computed only over suggestions agents engaged with, which flatters the number.

---

## Module: `service_tickets` (P2)

### `ServiceTicket` → `service_tickets_tickets`

| Column | Type | Notes |
|---|---|---|
| `ticket_number` | varchar(32) NOT NULL | Human-facing id (`ZG-1042`). Unique per tenant. From a `configs` numbering sequence. |
| `subject` | varchar(255) NOT NULL | |
| `customer_id` + `customer_snapshot` | uuid NULL + jsonb NULL | FK-id + snapshot. |
| `service_conversation_id` | uuid NULL | FK-id — the originating conversation (FR-036, navigable both ways). |
| `origin_channel_type` | varchar(32) NOT NULL | |
| `owner_user_id` | uuid NULL | Null = explicitly unassigned (FR-033). |
| `priority` | varchar(16) NOT NULL | `low` \| `medium` \| `high`. |
| `status` | varchar(32) NOT NULL | See state machine. |
| `sla_target_minutes` | integer NOT NULL | Snapshot of the rule at creation — later rule changes must not retroactively breach past cases. |
| `sla_deadline_at` | timestamptz NULL | Computed at create/resume from target + working hours (research R-03). |
| `sla_paused_ms` | bigint NOT NULL DEFAULT 0 | Accumulated while `waiting_on_customer`. |
| `first_response_at` / `resolved_at` | timestamptz NULL | `first_response_at` drives SC-014. |
| `updated_at` | timestamptz NULL | Optimistic locking (FR-038). |

Indexes: `(tenant_id, organization_id, status, sla_deadline_at)` for the at-risk list; `(tenant_id, organization_id, owner_user_id, status)`.

**State machine** (FR-034):

```
new ──> in_progress ──> waiting_on_customer ──> resolved
 │           ▲                   │                  │
 │           └───────────────────┘                  │
 └──────────────────────────────────────────────────┘
                    resolved ──reopen──> in_progress
```

Entering `waiting_on_customer` starts SLA pause accumulation; leaving it ends the pause and recomputes `sla_deadline_at`. `resolved` sets `resolved_at`. Every transition emits `service_tickets.ticket.status_changed` with actor and timestamp.

### `TicketStatusHistory` → `service_tickets_status_history`  *(append-only)*

`ticket_id`, `from_status`, `to_status`, `actor_user_id`, `changed_at`, `note`. Satisfies FR-034's "records who changed it and when" and feeds FR-086/SC-015.

---

## Module: `contact_queues` (P2)

### `ContactQueue` → `contact_queues_queues`

`name`, `channel_types jsonb` (covered channels), `target_agent_count smallint`, `service_level_target numeric(5,2)`, `routing_strategy varchar(32)` (`sla_then_value` | `longest_wait` | `manual`), `is_active bool`, `updated_at`.

### `QueueMembership` → `contact_queues_memberships`  *(junction — exempt)*

`queue_id`, `user_id`, `skill_level smallint`, `is_active`.

### `AgentSession` → `contact_queues_agent_sessions`

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid NOT NULL | One active session per user per tenant. |
| `availability` | varchar(16) NOT NULL | `available` \| `busy` \| `break` \| `offline` (FR-002). |
| `provider_state` | varchar(32) NULL | Last known state at the telephony provider — the two are reconciled, not assumed equal (FR-097). |
| `provider_state_at` | timestamptz NULL | Age, for the staleness guard (FR-096). |
| `current_conversation_id` | uuid NULL | |
| `team_label` | varchar(64) NULL | Snapshot from `staff` when present; plain label when absent. |
| `shift_start_at` / `shift_end_at` | timestamptz NULL | |
| `handled_today` / `avg_handle_seconds` | integer | Rolling counters. |
| `updated_at` | timestamptz NULL | |

### `QueueSnapshot` → `contact_queues_snapshots`  *(append-only)*

Periodic point-in-time counters (`queue_id`, `waiting_count`, `in_handling_count`, `longest_wait_seconds`, `service_level`, `abandoned_count`, `captured_at`) — the source for wallboard history and the abandonment rate. Live figures come over SSE (research R-04); this table is the durable record behind them.

---

## Module: `telephony` (P2/P3)

### `TelephonyProviderConnection` → `telephony_provider_connections`

`provider_key varchar(64)`, `display_name`, `credentials_ref varchar(255)` (resolved through `integrations` credentials service — never raw secrets in this table), `capabilities jsonb`, `status varchar(24)`, `last_error text`, `last_health_check_at`, `is_active`, `updated_at`.

### `VoiceFlow` → `telephony_voice_flows`

`name`, `definition jsonb` (ordered steps: `step`, `title`, `detail`, `category`), `version integer`, `published_version integer NULL`, `published_at`, `last_edited_by_user_id`, `updated_at`.

`published_version < version` is exactly the "authored differs from published" state FR-098 and the drift edge case require — no separate flag needed.

### `VoiceRoutingRule` → `telephony_routing_rules`

`flow_id`, `priority smallint`, `condition jsonb`, `target_queue_id uuid NULL`, `is_active`, `updated_at`. Conditions reference customer value, SLA state and open cases (FR-094).

### `CallRecord` → `telephony_call_records`

`external_call_id varchar(128)`, `direction`, `from_identifier` / `to_identifier` (**encrypted**), `customer_id NULL`, `service_conversation_id NULL`, `queue_id NULL`, `agent_user_id NULL`, `started_at`, `answered_at`, `ended_at`, `duration_seconds`, `disposition varchar(32)`, `recording_ref varchar(512) NULL`, `transcript_ref varchar(512) NULL`, `notification_played bool` (FR-083, auditable per contact).

Unique on `(tenant_id, organization_id, provider_key, external_call_id)` so replayed provider webhooks are idempotent.

### `CallEvent` → `telephony_call_events`  *(append-only)*

`call_record_id`, `event_type varchar(32)` (`started` | `answered` | `queued` | `transferred` | `ended` | `recording_available` | `transcript_available`), `payload jsonb`, `occurred_at`, `received_at`. Late or out-of-order provider events are ordered by `occurred_at`; a missing `ended` event is reconciled by a sweep worker so no conversation sticks in-progress (edge case).

### `RecordingPolicy` → `telephony_recording_policies`

`is_enabled`, `notification_required bool`, `notification_locale_key varchar(128)`, `retention_days integer NULL`, `updated_at`. Policy lives here; capture is the provider's (FR-093).

---

## Module: `contact_campaigns` (P3)

### `Campaign` → `contact_campaigns_campaigns`

`name`, `channel_type`, `mode varchar(32)` (`predictive_dialer` | `automated_send` | `bot_sequence` | `recurring_send`), `owner_label varchar(64)`, `run_state varchar(16)` (`draft` | `running` | `paused` | `completed`), `audience_definition jsonb`, `target_contact_count`, `completed_contact_count`, `connect_rate numeric(5,2)`, `conversion_measure varchar(64)`, `updated_at`.

**Run-state machine**: `draft → running ⇄ paused → completed`. `completed` is terminal.

### `CampaignRule` → `contact_campaigns_rules`

`campaign_id`, `max_attempts smallint`, `window_start_time` / `window_end_time` (time), `priority_order varchar(32)`, `fallback_channel_type varchar(32) NULL`, `suppress_on_closed_case bool NOT NULL DEFAULT true` (FR-052), `updated_at`.

### `CampaignAttempt` → `contact_campaigns_attempts`  *(append-only)*

`campaign_id`, `customer_id`, `attempt_number`, `channel_type`, `outcome varchar(32)`, `attempted_at`, `suppressed_reason varchar(64) NULL`. `suppressed_reason` records consent withdrawal or closed-case suppression, making FR-052 auditable rather than merely enforced.

---

## Module: `bot_intents` (P3)

### `BotIntent` → `bot_intents_intents`

`name`, `example_phrasings jsonb`, `is_enabled bool`, `confidence_threshold numeric(4,3)`, `updated_at`. One row serves chatbot, voicebot and IVR (FR-054).

### `IntentMetric` → `bot_intents_metrics`  *(append-only)*

`intent_id`, `period_start`, `period_end`, `volume`, `contained_count`, `handoff_count`, `avg_confidence`.

### `HandoffRule` → `bot_intents_handoff_rules`

`condition jsonb`, `description_key varchar(128)`, `is_active`, `sort_order`, `updated_at`. Carries the conversation summary on handoff (FR-056).

### `KnowledgeGap` → `bot_intents_knowledge_gaps`

`topic varchar(255)`, `question_volume integer`, `reason varchar(32)` (`missing_article` | `stale_article` | `missing_intent`), `source_ref varchar(512) NULL`, `period_start`, `period_end`, `resolved_at NULL`, `updated_at`.

---

## Module: `contact_quality` (P3)

### `QualityReview` → `contact_quality_reviews`

`call_record_id uuid NULL` (null for non-voice reviews), `service_conversation_id uuid NULL`, `channel_type`, `topic varchar(255)`, `customer_snapshot jsonb`, `agent_user_id`, `duration_seconds NULL`, `automatic_score smallint NULL`, `sentiment varchar(32) NULL`, `selection_reason varchar(32)` (`low_nps` | `repeat_contact` | `procedure_deviation` | `new_agent`), `review_state varchar(16)` (`pending` | `in_review` | `approved`), `reviewer_user_id NULL`, `approved_at NULL`, `updated_at`.

`automatic_score`, `duration_seconds` and `sentiment` are all nullable — a contact with no recording must review without breaking (FR-065).

### `ScorecardCriterion` → `contact_quality_criteria`

`name_key varchar(128)`, `max_score smallint`, `sort_order`, `is_active`, `updated_at`. Template definition.

### `ScorecardResult` → `contact_quality_results`

`review_id`, `criterion_id`, `score smallint NULL` (null = could not be assessed), `automatic_note text NULL`, `reviewer_note text NULL`, `updated_at`.

---

## Module: `contact_analytics` (P3)

### `ContactMetricRollup` → `contact_analytics_metric_rollups`  *(append-only)*

`metric_key varchar(64)`, `dimension jsonb` (`{ agentUserId?, channelType?, queueId? }`), `period_start`, `period_end`, `value numeric(14,4)`, `sample_count integer`, `computed_at`.

Covers FR-045 to FR-047 under one shape. Whether this table is the primary read path or a cache over `query_index` projections is research **R-12**, still open — the read API in [contracts/rest-api.md](./contracts/rest-api.md) is identical either way, so the decision stays reversible.

---

## Cross-module reference map

Every arrow is an FK-id (plus snapshot where noted), never an ORM relation.

| From | → To | Mechanism |
|---|---|---|
| `ServiceConversation.thread_id` | `messages.messages.thread_id` | Join key (research R-01). **Read only via `messagesThreadReader` DI facade** — never a direct query against peer tables (ANALYSIS-051 C1) |
| `ConversationChannelBinding.external_conversation_id` | `communication_channels.external_conversations.id` | FK-id. **Read only via `communicationChannelsThreadReader` DI facade** (ANALYSIS-051 C1) |
| `ServiceConversation.customer_id` | `customers.person` | FK-id + `customer_snapshot` |
| `ServiceTicket.service_conversation_id` | `conversations` | FK-id, both directions navigable |
| `ServiceConversation.queue_id` | `contact_queues` | FK-id, nullable when module disabled |
| `CallRecord.service_conversation_id` | `conversations` | FK-id |
| `QualityReview.call_record_id` | `telephony` | FK-id, nullable |
| `TelephonyProviderConnection.credentials_ref` | `integrations` credentials service | Reference only — no secrets stored here |

## Validation rules

Derived from the spec; enforced with Zod schemas in each module's `data/validators.ts`, with types via `z.infer`.

- `CustomerIdentity.confidence` ∈ [0, 1]; `match_method` = `manual` requires `verified_at` and an actor.
- `ServiceTicket.status` transitions must follow the state machine; illegal transitions are rejected with a field error, not silently coerced.
- `ServiceTicket.sla_target_minutes` is snapshotted at creation and immutable thereafter.
- `Campaign.run_state` = `running` requires at least one `CampaignRule` with `max_attempts ≥ 1`.
- `CampaignRule.window_start_time < window_end_time`.
- `ContactQueue.service_level_target` ∈ [0, 100]; `target_agent_count ≥ 0`.
- `ScorecardResult.score` ≤ its criterion's `max_score` when non-null.
- `VoiceFlow.published_version` ≤ `version`.
- `ServiceConversation.state` = `closed` requires `closed_at`; requires `closing_summary` when after-contact summarisation is enabled.
- Every list endpoint caps `pageSize` at 100 (root `AGENTS.md` § UI & HTTP).

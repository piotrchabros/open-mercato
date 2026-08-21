# REST API Contract: Mercato Connect

Conventions in [README.md](./README.md). Entities in [../data-model.md](../data-model.md).

## Shared rules

- **CRUD routes** use `makeCrudRoute` with `indexer: { entityType: '<module>:<entity>' }` so records stay query-indexed. Every route file exports `openApi`, built from a per-module `api/openapi.ts` factory (`createCrudOpenApiFactory`).
- **Every route file exports per-method `metadata`** carrying `requireAuth` and `requireFeatures`. The mutation-guard registry covers writes; read authorisation lives in route metadata and nowhere else. A top-level `export const requireAuth` is a violation (ANALYSIS-051 C4).
- **Custom write routes** (`POST`/`PUT`/`PATCH`/`DELETE` outside `makeCrudRoute`) MUST map to a mutation-guard registry operation, collect guards via `getAllMutationGuardInstances()` + `bridgeLegacyGuard(container)`, and call `runMutationGuards(...)` with `{ userFeatures }` before mutating. The mapped operation is given per route below. State-changing action endpoints map to `update`.
- **Optimistic locking** is on by default. Mutating requests against a user-editable record send `x-om-ext-optimistic-lock-expected-updated-at`; a mismatch returns **409** with the standard conflict body, which the UI surfaces via `surfaceRecordConflict`. `CrudForm` attaches the header automatically from `initialValues.updatedAt` — routes therefore MUST return `updatedAt` in list and detail responses.
- **Pagination**: `page` (1-indexed), `pageSize` (max 100), returning `{ items, total, page, pageSize }`.
- **Validation**: Zod schemas in `data/validators.ts`; types via `z.infer`. No `any`.
- **Errors**: `{ error: { code, message } }` where `message` is an i18n key for user-facing failures.
- **Outbound provider calls** made inside a route MUST carry an explicit timeout and map expiry to a defined response, never an open-ended wait (ANALYSIS-052 D2).

---

## `conversations`

| Method | Route | Purpose | Guard op |
|---|---|---|---|
| GET | `/api/conversations/conversations` | Inbox list. Filters: `state`, `channelType`, `assignedUserId`, `queueId`, `q`. Returns SLA state, channel, VIP flag, last-message preview, `updatedAt`. | — |
| GET | `/api/conversations/conversations?id=` | Detail: full cross-channel thread, customer snapshot, order context. | — |
| POST | `/api/conversations/conversations` | Create (manual outbound-initiated conversation). | `create` |
| PUT | `/api/conversations/conversations` | Update assignment / reply channel / priority. | `update` |
| POST | `/api/conversations/conversations/take-next` | Assign the next case per active routing mode. Returns the assigned conversation, or `204` when the queue is empty (FR-012, empty-state edge case). | `update` |
| POST | `/api/conversations/conversations/[id]/reply` | Send on any connected channel (FR-013). Body: `{ channelType, body, bodyFormat, attachments[] }`. Resolves the channel, calls the existing `ChannelAdapter.sendMessage` **under an explicit timeout** (configurable, default 15 s), writes a `Message` on the same `threadId` plus a `MessageChannelLink`. Returns `{ messageId, deliveryStatus }`. A provider rejection **or a timeout expiry** returns **422** naming the channel and reason, preserving the draft client-side — an outbound call must never hang the request (ANALYSIS-052 D2). | `update` |
| POST | `/api/conversations/conversations/[id]/transfer` | Transfer to agent or queue (FR-015). | `update` |
| POST | `/api/conversations/conversations/[id]/close` | Close with after-contact summary (FR-016). Body: `{ summary?, ticketResolution? }`. | `update` |
| GET | `/api/conversations/identities?customerId=` | Merged identifiers with confidence and match method (FR-026). | — |
| POST | `/api/conversations/identities/merge` | Merge identities. Body: `{ sourceCustomerId, targetCustomerId, identityIds[] }`. Writes `IdentityMergeAudit`. | `update` |
| POST | `/api/conversations/identities/split` | Reverse a merge from its audit row (FR-027). | `update` |
| POST | `/api/conversations/identities/recheck` | Re-run matching, return updated confidence (FR-026). | `update` |

**Portal** (`frontend/[orgSlug]/portal/cases/`): read via `/api/conversations/portal/cases`, guarded by `requireCustomerAuth` + `requireCustomerFeatures`, scoped to the authenticated customer. Portal replies post to `/api/conversations/portal/cases/[id]/reply` and join the same thread (FR-070).

## `service_tickets`

| Method | Route | Purpose | Guard op |
|---|---|---|---|
| GET/POST/PUT/DELETE | `/api/service_tickets/tickets` | CRUD via `makeCrudRoute`, `indexer.entityType: 'service_tickets:ticket'`. List returns number, subject, customer, channel, owner, SLA remaining + health, priority, status, `updatedAt`. | factory |
| POST | `/api/service_tickets/tickets/[id]/status` | Advance status through the state machine (FR-034). Body: `{ toStatus, note? }`. Illegal transitions return **422**. Writes `TicketStatusHistory`. | `update` |
| GET | `/api/service_tickets/tickets/export` | CSV/XLSX export of the current filter (FR-035). Long exports return `progressJobId`. | — |

## `contact_queues`

| Method | Route | Purpose | Guard op |
|---|---|---|---|
| GET/POST/PUT/DELETE | `/api/contact_queues/queues` | Queue CRUD. | factory |
| GET | `/api/contact_queues/wallboard` | Totals + per-queue + per-agent snapshot with `capturedAt` so the client can render age (FR-044, SC-008). Live deltas arrive over SSE, not by polling this route. | — |
| POST | `/api/contact_queues/queues/[id]/take` | Pull the next case from a specific queue (FR-042). | `update` |
| GET/PUT | `/api/contact_queues/agent-session` | Read / set own availability (FR-002). `PUT` reconciles with provider state (FR-097). | `update` |

## `telephony`

| Method | Route | Purpose | Guard op |
|---|---|---|---|
| GET/POST/PUT/DELETE | `/api/telephony/flows` | Voice-flow CRUD. Response includes `version` and `publishedVersion` so drift is visible (FR-098). | factory |
| POST | `/api/telephony/flows/[id]/test` | Validate against the provider without publishing (FR-058). | `update` |
| POST | `/api/telephony/flows/[id]/publish` | Publish authored version; sets `publishedVersion`. | `update` |
| GET/POST/PUT/DELETE | `/api/telephony/routing-rules` | Routing-rule CRUD (FR-093). | factory |
| GET/PUT | `/api/telephony/recording-policy` | Recording policy incl. lawful notification (FR-083). | `update` |
| POST | `/api/telephony/webhook/[provider]` | **Unauthenticated**, signature-verified inbound call events. Idempotent on `(providerKey, externalCallId, eventType, occurredAt)`. Invalid signature → **401**, no side effects. Writes `CallRecord` + `CallEvent`, emits `telephony.call.*`. | n/a — verified by signature, not session |
| GET | `/api/telephony/calls` | Call list/detail with recording and transcript references (never media). | — |

## `contact_campaigns`

| Method | Route | Purpose | Guard op |
|---|---|---|---|
| GET/POST/PUT/DELETE | `/api/contact_campaigns/campaigns` | Campaign CRUD incl. progress and outcome measures. | factory |
| POST | `/api/contact_campaigns/campaigns/[id]/run-state` | Start / pause (FR-050). Body: `{ runState }`. | `update` |
| GET/PUT | `/api/contact_campaigns/campaigns/[id]/rules` | Retry / callback / fallback rules (FR-051). | `update` |

## `bot_intents`

| Method | Route | Purpose | Guard op |
|---|---|---|---|
| GET/POST/PUT/DELETE | `/api/bot_intents/intents` | Intent CRUD with containment, handoff, volume (FR-055). | factory |
| POST | `/api/bot_intents/intents/[id]/toggle` | Enable/disable across every bot channel (FR-055). | `update` |
| GET/POST/PUT/DELETE | `/api/bot_intents/handoff-rules` | Handoff-condition CRUD (FR-056). | factory |
| GET | `/api/bot_intents/knowledge-gaps` | Gaps with topic, volume, reason (FR-057). | — |

## `contact_quality`

| Method | Route | Purpose | Guard op |
|---|---|---|---|
| GET | `/api/contact_quality/reviews` | Review list with score, channel, topic, participants, duration, sentiment. Nullable score/duration for contacts without recordings (FR-065). | — |
| GET/PUT | `/api/contact_quality/reviews/[id]/scorecard` | Read / write per-criterion results. | `update` |
| POST | `/api/contact_quality/reviews/[id]/approve` | Approve the assessment (FR-063). | `update` |
| GET | `/api/contact_quality/review-queue` | Counts grouped by selection reason (FR-064). | — |
| GET/POST/PUT/DELETE | `/api/contact_quality/criteria` | Scorecard template CRUD. | factory |

## `contact_analytics`

| Method | Route | Purpose | Guard op |
|---|---|---|---|
| GET | `/api/contact_analytics/kpis` | `?periodStart&periodEnd` → the six KPIs with previous-period delta and target (FR-045). | — |
| GET | `/api/contact_analytics/volume` | Contact volume by day and share by channel (FR-046). | — |
| GET | `/api/contact_analytics/agents` | Per-agent performance (FR-047). | — |
| GET | `/api/contact_analytics/export` | Report export of the current view (FR-048). | — |

Response shape is identical whether backed by `query_index` projections or a rollup table (research **R-12** — open), keeping that decision reversible.

## AI assistance

Exposed as `ai-assistant` agents and tools, not bespoke HTTP routes — see [../research.md](../research.md) R-08. Next-action tools that write go through `prepareMutation`, so the agent sees the change before it is applied (FR-019, FR-022). Suggestion responses carry structured citations (FR-021); acceptance and rejection are recorded for FR-020 and SC-004.

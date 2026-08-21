# Frozen surfaces — Mercato Connect

**Status: DECIDED. This file is the single source of truth for every identifier Connect freezes.**
Where the App Spec, the Phase 1 spec or the commit plan disagree with this file, **this file wins**.

**Why it exists.** Round 3 found event IDs frozen at three different values across three
documents, widget spots frozen to a pattern whose shipped regex rejects them, ten ACL IDs hidden
inside a wildcard, a module with no feature keys at all, and four `BACKWARD_COMPATIBILITY.md`
categories missing from the list. Each of those costs a deprecation cycle — and for ACL IDs, a
data migration — once the first migration lands.

**Rule:** nothing on this list may change after the commit that first ships it, except through
the deprecation protocol in `BACKWARD_COMPATIBILITY.md`.

---

## 1. Module and package IDs — surface 1 (FROZEN)

Packages kebab-case, module ids snake_case, matching `channel-gmail` / `channel_gmail`.

| Package | Module id | Phase |
|---|---|---|
| `packages/connect` | `connect` | 1 |
| `packages/connect-sla` | `connect_sla` | 2 |
| `packages/connect-analytics` | `connect_analytics` | 2 |
| `packages/connect-routing` | `connect_routing` | 3 |
| `packages/connect-ai` | `connect_ai` | 4 |
| `packages/connect-bots` | `connect_bots` | 5 |
| `packages/connect-portal` | `connect_portal` | 6 |
| `packages/connect-quality` | `connect_quality` | 7a |
| `packages/connect-campaigns` | `connect_campaigns` | 7b |
| `packages/channel-webform` | `channel_webform` | 1 |
| `packages/channel-webchat` | `channel_webchat` | 3 |
| `packages/channel-whatsapp` | `channel_whatsapp` | 3 |
| `packages/channel-sms` | `channel_sms` | 3 |
| `packages/channel-messenger` | `channel_messenger` | 3 |
| `packages/channel-instagram` | `channel_instagram` | 3 |
| `packages/channel-voice` | `channel_voice` | 7a |

## 2. Event IDs — surface 5 (FROZEN)

Declared with `createModuleEvents()` + `as const`. **All ten `connect.*` IDs freeze in Phase 1**,
because Phase 1 ships the status machine, `/close` and `/reopen` and would otherwise emit
undeclared events.

**`connect` (Phase 1, 10):** `connect.case.created` · `connect.case.assigned` ·
`connect.case.status_changed` · `connect.case.transferred` · `connect.case.resolved` ·
`connect.case.closed` · `connect.case.reopened` · `connect.conversation.attached` ·
`connect.identity.linked` · `connect.identity.unlinked`

**Later phases** (frozen when first shipped): `connect.identity.merged`, `connect.identity.relinked`
(3) · `connect_sla.clock.started`, `.breach_warned`, `.breached` (2) ·
`connect_routing.offer.made`, `.accepted`, `.declined`, `.expired`, `.withdrawn`,
`connect_routing.presence.changed` (3) · `connect_ai.suggestion.shown`, `.acted`,
`connect_ai.action.executed`, `.failed` (4) · `connect_bots.intent.published`,
`connect_bots.handoff.performed` (5) · `connect_quality.recording.ingested`,
`connect_quality.scorecard.approved` (7a) · `connect_campaigns.campaign.started`, `.paused`,
`connect_campaigns.contact.attempted`, `.skipped` (7b)

> `connect.shipment.updated` is **not** Connect's to emit — a shipment fact belongs to
> `sales`/`shipping_carriers`, and the portal subscribes to the owning module's event.

## 3. ACL feature IDs — surface 10 (FROZEN, **stored in the DB — renames need a data migration**)

Format is `<module>.<resource>.<verb>` with **no exceptions**. Round 2 caught
`connect.analytics.view`; the rule exists so that class of error is mechanical to spot.

**`connect` (6, Phase 1):** `connect.inbox.view` · `connect.inbox.handle` ·
`connect.cases.view.all` · `connect.cases.manage` · `connect.identities.manage` ·
`connect.settings.manage`

**`connect_sla` (2):** `connect_sla.policies.manage` · `connect_sla.escalations.manage`

**`connect_analytics` (2):** `connect_analytics.view` · `connect_analytics.view.agents`

**`connect_routing` (3):** `connect_routing.queues.manage` · `connect_routing.wallboard.view` ·
`connect_routing.presence.manage.others`

**`connect_ai` (2 + 10 action IDs):** `connect_ai.suggestions.use` · `connect_ai.library.manage`,
plus one per action definition — **enumerated here, not hidden behind a `<key>` wildcard**:
`connect_ai.actions.replacement_shipment` · `.compensation_coupon` · `.carrier_claim` ·
`.refund_on_scan` · `.return_status_sms` · `.invoice_correction` · `.company_billing_data` ·
`.back_in_stock_notify` · `.warehouse_alternative` · `.replacement_discount_code`

**`connect_bots` (2):** `connect_bots.intents.manage` · `connect_bots.gaps.manage`

**`connect_portal` (3)** — absent from every prior list: `connect_portal.cases.view.own` ·
`connect_portal.actions.use` · `connect_portal.settings.manage`

**`connect_quality` (3):** `connect_quality.recordings.listen` ·
`connect_quality.scorecards.review` · `connect_quality.scorecards.view.own`

**`connect_campaigns` (3):** `connect_campaigns.view` · `connect_campaigns.manage` ·
`connect_campaigns.run`

**Total: 36 feature IDs** (v3 claimed "all 21", counting the action family as one).

## 4. Widget injection spot IDs — surface 6 (FROZEN)

Corrected against the shipped hosts. Round 3 found the App Spec and commit plan naming these to
`sales.document.detail.{kind}:{surface}`, whose regex is `kind ∈ {order,quote}` and
`surface ∈ {tabs,details}` — it rejects both `return` and `sidebar`.

| Spot | Status | Notes |
|---|---|---|
| `detail:customers.person:tabs` | **exists** — mounted at `customers/backend/customers/people-v2/[id]/page.tsx:300` | Not declared in `extension-points.ts`; PR B declares it |
| `detail:customers.person:sidebar` | **new**, PR B | Follows the `detail:<module>.<entity>:<surface>` family |
| `detail:customers.company:sidebar` | **new**, PR B | |
| `detail:sales.order:sidebar` | **new**, PR B | Matches the shipped `detail:sales.order:shipping` family — **not** the `sales.document.detail.*` pattern |
| `detail:sales.return:sidebar` | **new**, PR B | `sales` declares no return spots at all today |

So: **four new spots plus one declaration**, not "five new spots".

The orders-list "has open case" column needs **both** a response enricher (supplies the field)
and an `InjectionColumnWidget` (renders the column). v3's Phase 1 said "enricher, **not** a
column widget"; that is wrong.

## 5. Database schema — surface 8 (ADDITIVE-ONLY)

Table names freeze on first migration: `connect_cases` · `connect_conversations` ·
`connect_contact_identities` · `connect_tenant_settings` · `connect_case_tags` ·
`connect_case_tag_assignments` · `connect_case_reopens` · `connect_pending_projections` ·
`connect_case_touches` (Phase 1); `connect_sla_policies` · `connect_sla_case_clocks` ·
`connect_business_calendars` (+ windows, holidays) (2); `connect_service_queues` ·
`connect_agent_presences` · `connect_routing_offers` (3); `connect_ai_suggestions` ·
`connect_ai_action_definitions` · `connect_ai_action_executions` (4); `connect_intents` ·
`connect_handoff_rules` · `connect_knowledge_gaps` (5); `connect_recordings` ·
`connect_scorecards` (+ items, templates) (7a); `connect_campaigns` · `connect_campaign_contacts`
· `connect_callback_rules` (7b); `connect_cost_inputs` (2).

**One change to an existing table**, in PR A: `messages.Message.senderUserId` NOT NULL must be
relaxed for system-authored sends. Needs sign-off.

**`connect_case.status` enum (FROZEN):** `new` · `in_progress` · `waiting_customer` ·
`escalated` · `resolved` · `closed`. `possible_duplicate` is a **tag**, not a status.

## 6. DI service names — surface 9 (STABLE) — absent from every prior list

`connectCaseService` · `connectIdentityResolver` · `connectProjectionService` ·
`connectSettingsService` (1) · `connectSlaClockService` · `connectBusinessCalendarService` (2) ·
`connectRoutingService` · `connectPresenceService` (3) · `connectActionExecutionService` (4).

## 7. Notification type IDs — surface 11 (FROZEN) — absent from every prior list

`connect_sla.warning` · `connect_sla.breached` (2) · `connect_routing.offer_expired` ·
`connect_routing.agent_flipped_busy` (3) · `connect_bots.handoff_received` (5) ·
`connect_quality.scorecard_approved` (7a) · `connect.integration_credential_expiring` (1).

## 8. AI agent / tool IDs — surface 12 (FROZEN) — absent from every prior list

Agents: `connect_ai.summarizer` · `connect_ai.reply_drafter` · `connect_ai.wrap_up_writer` (4) ·
`connect_bots.intent_recognizer` (5) · `connect_quality.auto_scorer` (7a).
Tools: `connect_ai.tool.order_lookup` · `.return_lookup` · `.invoice_lookup` ·
`.knowledge_search` (4).

## 9. Import paths — surface 4 (STABLE) — absent from every prior list

Public entry points: `@open-mercato/connect` (module metadata, `features`) ·
`@open-mercato/connect/commands` (the Case command surface other modules invoke) ·
`@open-mercato/connect/types`. Entity classes are **module-internal** and are not exported —
following `staff/AGENTS.md`'s precedent.

## 10. Query-index entity types and DataTable ids — surface 14 (STABLE)

`indexer: { entityType: E.connect.connect_case }` — the generated id, not a bare string.
DataTable `entityId` / `extensionTableId`: `connect.cases` · `connect.identities` ·
`connect.recordings` · `connect.campaigns`.

---

## Decision log

| Question | Decision |
|---|---|
| Nine packages or one with nine modules? | **Nine packages.** Per-module disable is build-time registration in `apps/<app>/src/modules.ts`; nine packages makes each independently registerable and keeps `connect_sla`'s dependency on `connect` an ordinary package dependency |
| ACL action IDs enumerated or wildcarded? | **Enumerated.** A wildcard hides ten FROZEN, DB-stored IDs behind one line |
| `possible_duplicate` | **A tag.** Keeps the status enum as frozen |
| Widget spot naming | **`detail:<module>.<entity>:<surface>`**, matching the shipped `detail:sales.order:shipping` family. The `sales.document.detail.*` regex cannot express what Connect needs |
| Event IDs frozen when? | **All ten `connect.*` in Phase 1.** Later modules freeze theirs when first shipped |

## Still open — these gate later phases, not Phase 1

- **§1.2's contact base unit** — channel traffic counted as Cases. Not resolvable from the prototype; needs operator data (OQ-3). Affects every business figure, no identifier.
- **§4.6's adoption credit** — over-stated ~4×; the estimate is understated. Affects the schedule, no identifier.
- **`businessMillisBetween` / `addBusinessMillis`** — neither exists repo-wide, neither is specified, and Phase 2 cannot compute a due date without them.

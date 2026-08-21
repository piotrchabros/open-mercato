# Feature Specification: Mercato Connect — Omnichannel Customer Contact Workspace

**Feature Branch**: `cez/a5fd2e52`
**Created**: 2026-08-21
**Status**: Draft
**Source design**: Claude Design project *System omnichannel OpenMercato* → `Mercato Connect.dc.html`
  (https://claude.ai/design/p/bd9bc47f-819f-4ade-9e68-71f8db42a1d6)
**Input**: Interactive design prototype covering 13 screens of an omnichannel contact-centre workspace built on the Open Mercato design system.

## Overview

Mercato Connect is a single workspace where a customer-service team handles every inbound and outbound customer contact — phone, e-mail, web chat, WhatsApp, Messenger, SMS, Instagram DM, web forms and the self-service portal — as one continuous conversation per customer, with commerce context (orders, returns, stock, invoices) and AI assistance available in the same view.

Today a service team switches between a telephony console, a shared mailbox, several social inboxes and the commerce back office. Context is lost at every switch: the customer repeats themselves, agents re-derive order state by hand, and no one can see whether the promised response time is about to be missed. Mercato Connect removes the switching by giving the agent one thread, one customer profile and one set of next actions.

The workspace is **modular**: an operator turns individual capabilities (tickets, wallboard, campaigns, bots, quality, portal, analytics) on or off, and a disabled capability disappears from team navigation entirely. Only the omnichannel inbox is mandatory.

Mercato Connect is **composed on the existing installation** rather than built beside it — it reuses the platform's channel connections, message delivery, contact resolution, customer records, portal framework and integration surfaces, and adds only what is missing. Voice runs through an **external contact-centre provider**: Mercato Connect owns the routing rules, the context, the agent experience and the reporting; the provider owns execution on the call path. See [Platform composition](#platform-composition) and [Voice boundary](#voice-boundary) for the exact delivery boundary.

### Primary user roles

| Role | What they do here |
|------|-------------------|
| **Service agent** | Works the inbox: takes the next case, replies on any channel, uses AI suggestions, closes cases |
| **Team lead / supervisor** | Watches the wallboard, redistributes load, reviews call quality, approves scorecards |
| **Service manager** | Reads KPI dashboards, runs outbound campaigns, tunes bot intents and routing rules |
| **Operator / administrator** | Enables modules, connects channels and integrations, sets SLA targets and working hours |
| **Customer** | Uses the self-service portal to see case status and resolve routine requests without contacting anyone |

## Clarifications

### Session 2026-08-21

- **Q: How does Mercato Connect relate to the platform modules already shipped (`communication_channels`, `messages`, `inbox_ops`, `customers`, `customer_accounts`, `portal`, `notifications`, `staff`, `integrations`, `dashboards`)?**
  **A: Compose on top.** Mercato Connect is a presentation layer and a set of new capability modules built over the existing ones. It reuses their channel connections, message delivery, contact resolution, customer records and integration surfaces, and adds only what is genuinely missing. It does not replace or fork them. See [Platform composition](#platform-composition).

- **Q: How deep does telephony go in this delivery?**
  **A: External provider.** Mercato Connect owns routing rules, customer and commerce context, the agent experience and all reporting. Call transport, softphone media, queue execution, IVR execution and recording capture live with an external contact-centre provider reached through the integrations surface. See [Voice boundary](#voice-boundary).

## Platform composition

Mercato Connect composes on the existing installation. This table is the delivery boundary: anything in the *reuse* column is a dependency to integrate with, not work to redo.

| Capability | Reuse (already shipped) | Build (new in this feature) |
|---|---|---|
| Channel connections | `communication_channels`: adapter registry, connection lifecycle, credential refresh and OAuth, channel admin UI, dead-letter handling. Adapters exist for e-mail (incl. Gmail/IMAP), chat, SMS, WhatsApp. | Adapters for Messenger, Instagram DM, web forms and the portal channel, against the existing adapter contract. |
| Conversations & messages | `communication_channels` (`ExternalConversation`, `ExternalMessage`, thread mapping, reactions) and `messages` (composition, delivery, confirmations, access tokens). | The unified **cross-channel** thread: one conversation per customer spanning several channels, with bot and system entries interleaved, and reply-on-a-different-channel. |
| Customer identity | `communication_channels` contact resolver; `customers` and `customer_accounts` records. | Multi-channel identity merging with a confidence score, agent-visible merge inspection, re-check and reversal. |
| Agent inbox UI | `inbox_ops` (inbox settings, e-mail ingestion, proposals, discrepancies). | The three-pane agent workspace: filtered conversation list, thread, context/assist panel, take-next assignment, close-with-summary. |
| Cases / SLA | — | Ticket entity, status progression, SLA clock against target and working hours, list and export. |
| Queues & live ops | — | Queues, routing by service level and customer value, wallboard, agent session state. |
| AI assistance | `ai-assistant` package: agents, tools, mutation approval, provider/model selection. | Case summarisation, grounded reply suggestion with sources, next-action tools, after-contact summary, acceptance-rate reporting. |
| Reporting | `dashboards`. | The contact-centre KPI set, channel mix, contact volume and per-agent performance. |
| Campaigns | `messages` delivery, `notifications`. | Campaign entity, progress and outcome tracking, retry/callback rules, consent enforcement at send time. |
| Bots & voice flows | `ai-assistant`, `workflows`. | Shared intent set across chatbot/voicebot/IVR, containment and handoff reporting, knowledge-gap surfacing, voice-flow configuration. |
| Quality review | `.ai/specs/2026-04-21-crm-call-transcriptions.md` transcription adapters. | Scorecards, automatic scoring, review-queue selection by reason. |
| Customer portal | `portal` module: portal pages, portal auth, portal nav injection, portal event bridge. | Case status, customer-selectable resolutions, case history and self-service actions as portal pages. |
| Integrations | `integrations`, `data_sync`. | The contact-centre provider connection and the operator-facing health surface for it. |
| Modularity | Existing module enable/disable and generated registries. | The operator-facing module switchboard with dependency declarations and counts. |
| Permissions & tenancy | Existing ACL features, declarative guards, tenant/organisation scoping. | Feature definitions for each new capability. |

## Voice boundary

Voice runs through an external contact-centre provider connected via the integrations surface. The split is:

| Owned by Mercato Connect | Owned by the provider |
|---|---|
| Routing **rules** — priority by service level and customer value, skill/queue mapping, callback thresholds | Routing **execution** and call distribution |
| Customer, order and case context supplied to the flow before routing | Call transport, carrier connections, media path |
| IVR flow **definition**, step configuration, test and publish actions | IVR **execution** at call time |
| Intent set shared with chat and bot channels | Speech recognition and text-to-speech at call time |
| Dialer campaign definition, audience, retry and callback rules, consent enforcement | Dial execution and connect detection |
| Recording **policy** — whether to record, notification requirement, retention intent | Recording **capture** and media storage |
| Transcript and recording reference, scorecards, scoring, review queue | Transcription production, where the provider supplies it |
| Queue and agent-state **display**, wallboard, all reporting | Queue and agent-state **source of truth** during a call |
| Agent availability state as the team sees it | Softphone client and media session |

The softphone control in the workspace header hands off to the provider's client and reflects its call state; Mercato Connect does not implement a soft-client.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Resolve a delayed-delivery case that spans three channels (Priority: P1)

A VIP customer phoned yesterday about a missing parcel and was promised a callback that never came. Today she writes on WhatsApp. The agent must see the whole history — the call, the agent note, the bot's tracking check — and resolve the case in one reply.

**Why this priority**: This is the core promise of the product. Without it the remaining twelve screens have no reason to exist. It is independently valuable and independently demonstrable.

**Independent test**: Seed one customer with contacts on two channels and one delayed order; open the inbox; confirm a single thread shows both channels in order, the customer's order context is visible without navigating away, and a reply sent on a different channel than the inbound one is delivered and appended to the same thread.

**Acceptance Scenarios**:

1. **Given** a customer has contacted on phone and later on WhatsApp about the same order, **When** the agent opens the conversation, **Then** both contacts appear in one chronological thread, each labelled with its channel and timestamp, including system entries (call ended, note added, channel switched) and bot entries.
2. **Given** the conversation is open, **When** the agent looks at the case panel, **Then** the customer's lifetime value, order count, last NPS, churn risk, tags and the related order (id, status, items, carrier and last tracking event) are visible without leaving the screen.
3. **Given** the conversation is open, **When** the agent selects a reply channel different from the inbound channel, **Then** the composer targets that channel and the sent message is appended to the same thread attributed to the agent and the chosen channel.
4. **Given** the agent has typed a reply, **When** the agent presses Enter, **Then** the message is sent; **When** the agent presses Shift+Enter, **Then** a newline is inserted instead.
5. **Given** the case is resolved, **When** the agent closes it, **Then** the conversation leaves the open list, an after-contact summary is written to the customer record, and the agent is moved to the next open conversation.
6. **Given** the agent has no conversation selected or wants a new one, **When** the agent requests the next case, **Then** the system assigns the highest-priority open conversation according to the active routing mode and confirms the assignment with the customer name and channel.

---

### User Story 2 — AI assistance the agent stays in control of (Priority: P1)

The agent should not start from "how can I help you". The workspace summarises the case, drafts a reply grounded in real sources, and offers the concrete next actions the case needs.

**Why this priority**: Ships with US1 and is what makes US1 fast rather than merely convenient. Testable on its own against a seeded conversation.

**Independent test**: Open a seeded conversation with AI assistance enabled; confirm a case summary, a draft reply, a list of next actions and a list of cited sources are shown; insert the draft into the composer, edit it, and send.

**Acceptance Scenarios**:

1. **Given** a conversation is open and AI assistance is enabled, **When** the assist panel loads, **Then** it shows a case summary, a suggested reply, at least one suggested next action with a one-line rationale, and the sources the suggestion draws on (knowledge-base article, policy, order data or prior contact).
2. **Given** a suggested reply is shown, **When** the agent inserts it, **Then** the full text lands in the composer as editable text and is **not** sent automatically.
3. **Given** a suggested reply is shown, **When** the agent rejects or asks to rewrite it, **Then** the rejection is recorded so acceptance rate can be reported.
4. **Given** a suggested next action is shown, **When** the agent runs it, **Then** the action executes against the connected commerce/logistics system and the outcome is confirmed to the agent.
5. **Given** AI assistance is disabled for the workspace, **When** the agent opens a conversation, **Then** the assist panel is absent and every other inbox function still works.
6. **Given** after-contact summarisation is enabled, **When** a case is closed, **Then** a summary is generated and the agent may correct it before it is stored.

---

### User Story 3 — Cases with a clock: tickets and SLA (Priority: P2)

Some contacts become cases that outlive a single conversation. They need an identifier, an owner, a priority and a countdown that is visible before it is breached.

**Independent test**: Open the tickets screen with seeded tickets; confirm number, subject, customer, channel, owner, SLA countdown, priority and status are listed; advance one ticket's status and confirm the change persists and is reflected in the customer's case history.

**Acceptance Scenarios**:

1. **Given** tickets exist, **When** the ticket list is opened, **Then** each row shows number, subject, customer, originating channel, owner (or explicitly "unassigned"), remaining SLA time, priority and status.
2. **Given** a ticket's remaining SLA time is below the warning threshold, **When** the list renders, **Then** that ticket's time is visually distinguished from tickets in a healthy state, and a breach-imminent state is distinguished from a warning state.
3. **Given** a ticket in any non-final status, **When** the user advances its status, **Then** it moves to the next status in the sequence *new → in progress → waiting on customer → resolved*, the update time is refreshed, and the change is confirmed.
4. **Given** the ticket list is open, **When** the user exports it, **Then** the currently listed tickets are exported in a spreadsheet-readable format.
5. **Given** a case originated in a conversation, **When** its ticket is viewed, **Then** the originating conversation is reachable from the ticket and vice versa.

---

### User Story 4 — Customer 360 across channels, orders and cases (Priority: P2)

Before promising anything, the agent needs to know who they are talking to — including the fact that the WhatsApp number, the e-mail address and the Instagram handle are the same person.

**Independent test**: Open a customer profile seeded with contacts across ≥3 channels, ≥2 orders and ≥2 tickets; confirm the header metrics, the unified timeline and each tab render the seeded data; confirm the identity-match confidence is shown.

**Acceptance Scenarios**:

1. **Given** a customer profile is open, **When** the header renders, **Then** lifetime value, order count, last NPS, churn risk and preferred channel are shown, with VIP status flagged when applicable.
2. **Given** the profile is open on the overview tab, **When** the timeline renders, **Then** contacts, orders, automated notifications and bot interactions appear in one chronological list, each labelled with its channel.
3. **Given** the profile is open, **When** the user switches between the overview, conversations, orders and cases tabs, **Then** each tab shows the corresponding records for that customer and the header metrics remain visible.
4. **Given** identities from several channels have been merged into one profile, **When** the agent views the identity section, **Then** the merged identifiers and a match-confidence score are shown, and the agent can request a re-check of the match.
5. **Given** the profile is open, **When** the consent section renders, **Then** each marketing/communication consent is shown with its state and the date it was granted, and call-recording notification status is shown.
6. **Given** the agent came from a conversation, **When** they open the full profile and return, **Then** they land back on the same conversation.

---

### User Story 5 — Live queue and team visibility (Priority: P2)

A supervisor needs to see, without asking anyone, how many people are waiting, how long the oldest has waited, who is free and where the service level is slipping.

**Independent test**: Open the wallboard with seeded queues and agent states; confirm totals and per-queue metrics render, update on the live refresh interval, and that pulling a case from a queue assigns it.

**Acceptance Scenarios**:

1. **Given** queues are active, **When** the wallboard is open, **Then** total waiting, total in handling, today's service level and abandonment rate are shown, and the view refreshes automatically without user action.
2. **Given** queues are active, **When** the wallboard renders, **Then** each queue shows its name, waiting count, longest wait, staffed-vs-target agent count, service level and the channels it covers.
3. **Given** a queue's service level is below target, **When** it renders, **Then** it is visually distinguished, with a separate distinction for a critical breach.
4. **Given** a queue has waiting contacts, **When** the supervisor pulls a case from it, **Then** the case is assigned and the assignment is confirmed.
5. **Given** agents are logged in, **When** the team panel renders, **Then** each agent shows current state (on contact, wrapping up, ready, on break), team, cases handled today and average handling time.

---

### User Story 6 — Operator turns the product into the product they bought (Priority: P2)

An installation that ships every capability to every team is a training cost. The operator decides which modules exist, which channels are connected and which external systems feed customer context.

**Independent test**: Open settings; disable a non-core module and confirm it disappears from navigation; connect and disconnect a channel; renew an integration flagged as needing attention; confirm counts update.

**Acceptance Scenarios**:

1. **Given** the settings screen is open, **When** the operator disables a module, **Then** that module's navigation entry disappears for the team, the active-module count decreases, and the change is confirmed.
2. **Given** the operator is viewing the currently open module, **When** they disable it, **Then** they are returned to settings rather than left on a dead screen.
3. **Given** the inbox module is core, **When** the operator attempts to disable it, **Then** the attempt is refused with an explanation and the module stays enabled.
4. **Given** a module has dependencies, **When** the module list renders, **Then** each module states its dependency (or that it has none).
5. **Given** channels are listed, **When** the operator connects or disconnects one, **Then** the channel's state and the connected-channel count update and the change is confirmed.
6. **Given** an integration's credential has expired, **When** the settings screen is open, **Then** an attention notice names the affected system, states the consequence in business terms, and offers a direct renewal action.
7. **Given** service rules are shown, **When** the operator changes the first-response target, working hours, after-contact summarisation or call recording, **Then** the selection is persisted and reflected wherever those rules are applied.

---

### User Story 7 — Performance reporting (Priority: P3)

**Independent test**: Open the KPI dashboard for a period with seeded data; confirm each KPI shows value, period-over-period delta and target; confirm the contact-volume and channel-mix breakdowns and the per-agent table render; export a report.

**Acceptance Scenarios**:

1. **Given** a reporting period is selected, **When** the dashboard renders, **Then** first-contact resolution, average handling time, first-response service level, NPS, AI-handled share and cost per contact are each shown with a comparison against the previous period and against target where a target exists.
2. **Given** the dashboard is open, **When** the breakdowns render, **Then** contact volume by day and share of contacts by channel are shown for the selected period.
3. **Given** the dashboard is open, **When** the team table renders, **Then** each agent shows cases handled, first-contact resolution, average handling time, NPS and AI-suggestion acceptance rate.
4. **Given** the dashboard is open, **When** the user changes the period or exports the report, **Then** the view recalculates for the new period, or a report of the current view is produced.

---

### User Story 8 — Outbound campaigns from the same customer base (Priority: P3)

**Independent test**: Open campaigns with seeded campaigns; confirm progress, connect rate and conversion render; start and pause a campaign; confirm callback rules are stated.

**Acceptance Scenarios**:

1. **Given** campaigns exist, **When** the screen renders, **Then** each campaign shows name, mode, channel, owner, running/paused state, contacts done vs total with progress, connect rate and conversion.
2. **Given** a campaign is running, **When** the user pauses it, **Then** it stops contacting and its state and action label update; **Given** it is paused, **When** the user starts it, **Then** it resumes.
3. **Given** callback rules are configured, **When** the screen renders, **Then** the maximum retry count, permitted calling window, priority ordering, fallback channel and the suppression rule for closed cases are all stated.
4. **Given** a contact attempt fails, **When** the retry limit is reached, **Then** the configured fallback channel is used instead of further attempts.

---

### User Story 9 — Bots and voice flows share one set of intents (Priority: P3)

**Independent test**: Open the bots screen with seeded intents; confirm containment, handoff and volume per intent; disable an intent and confirm it stops being served; confirm the handoff rules and knowledge gaps render. Open the IVR screen and confirm the flow steps and publish/test actions.

**Acceptance Scenarios**:

1. **Given** intents are configured, **When** the bots screen renders, **Then** each intent shows name, example phrasings, monthly volume, share contained without an agent, share handed off, and enabled state.
2. **Given** an intent is enabled, **When** the user disables it, **Then** the bot stops handling it across every channel that shares the intent set, and the state is reflected immediately.
3. **Given** an intent's containment is below the acceptable threshold, **When** it renders, **Then** it is visually distinguished from healthy intents.
4. **Given** the bot failed to answer questions in the reporting period, **When** the knowledge-gap panel renders, **Then** each gap shows the topic, its volume and the reason (missing article, stale article, missing intent).
5. **Given** handoff rules are configured, **When** they render, **Then** each condition that forces a human handoff is listed, and the handoff carries the conversation summary to the agent.
6. **Given** a voice flow exists, **When** the IVR screen renders, **Then** its steps are shown in order with a description and category per step, the flow's last editor and edit time are shown, and the flow can be tested before publishing.
7. **Given** intent-recognition confidence drops below the configured threshold, **When** a voice contact arrives, **Then** the fallback menu is offered rather than a mis-route.

---

### User Story 10 — Contact quality review (Priority: P3)

**Independent test**: Open the quality screen with seeded recordings; confirm each shows score, channel, topic, participants, duration and sentiment; open a scorecard, review criteria, and approve it.

**Acceptance Scenarios**:

1. **Given** recordings exist, **When** the list renders, **Then** each shows identifier, channel, topic, customer, agent, duration, automatic score out of 100 and detected sentiment.
2. **Given** a recording's score is below threshold, **When** it renders, **Then** it is visually distinguished, with separate treatment for borderline and failing scores.
3. **Given** a recording is listed, **When** the reviewer plays it or opens its transcript, **Then** the corresponding content is available.
4. **Given** a scorecard is open, **When** it renders, **Then** each criterion shows its score out of its maximum, any automatic reviewer note is shown, and the reviewer can approve the assessment.
5. **Given** a review backlog exists, **When** the review-queue panel renders, **Then** contacts selected for review are grouped by selection reason (low NPS, repeat contact, procedure deviation, new-agent contact) with counts.

---

### User Story 11 — Customers resolve routine requests themselves (Priority: P3)

**Independent test**: Open the portal preview as a customer with an active delayed-delivery case; confirm the case status, its history and the offered resolutions render; confirm the self-service actions and the contact-channel choices.

**Acceptance Scenarios**:

1. **Given** a customer has an open case, **When** they open the portal, **Then** the case is shown with its current status, the last update time and a plain-language explanation of what is happening and what the company will do next.
2. **Given** a case offers customer-selectable resolutions, **When** the customer chooses one, **Then** that choice is recorded on the case and is visible to the agent in the same thread.
3. **Given** the customer opens the portal, **When** the case history renders, **Then** past events are shown with their channel and time, matching the agent-side timeline for the same case.
4. **Given** self-service actions are available, **When** the customer uses one (return or exchange, invoice download, delivery reschedule), **Then** it completes without agent involvement.
5. **Given** the customer chooses to write in, **When** they pick a channel, **Then** the message joins the same customer thread the agent sees.

---

### User Story 12 — AI programme oversight (Priority: P3)

**Independent test**: Open the AI screen; confirm the four programme metrics, the suggestion library with per-template acceptance, and the stated operating principles render.

**Acceptance Scenarios**:

1. **Given** AI features are in use, **When** the AI screen renders, **Then** share of cases closed without an agent, agent acceptance rate of suggestions, time recovered per case and average intent-recognition confidence are shown.
2. **Given** suggestion templates exist, **When** the library renders, **Then** each shows name, owner, usage count and acceptance rate, so low-performing templates can be found.
3. **Given** the screen is open, **When** the operating principles render, **Then** they state that the agent always sees content before it is sent, that every suggestion carries a source, that after-contact summaries are editable, and that customer data does not leave the installation.

---

### Edge Cases

- **No open conversations**: the inbox shows an empty state naming what is missing and the action that resolves it, and "take next" reports that there is nothing to take rather than failing silently.
- **Channel filter yields nothing**: the filtered list shows an empty state that names the active filter and offers to clear it.
- **Last conversation closed**: closing the only open conversation leaves the agent on a valid empty state, not a broken selection.
- **Unrecognised caller**: a contact from an unknown identifier opens with an explicit "unrecognised" state and an action to link it to an existing customer.
- **Wrong identity merge**: a merged profile can be split again, and the agent can see which identifiers were merged and on what confidence.
- **Reply channel unavailable**: if the selected reply channel is disconnected or its provider rejects the send (expired token, template not approved, outside the permitted window), the agent is told which channel failed and why, the draft is preserved, and an alternative channel is offered.
- **Send fails after submission**: a failed delivery is surfaced on the message in the thread with a retry, never silently dropped.
- **SLA already breached**: a breached case is visually distinct from one merely at risk, and remains actionable.
- **Concurrent handling**: two agents opening the same conversation, or two users advancing the same ticket, must not silently overwrite each other — the second writer is told the record changed and shown the current state.
- **Module disabled while a user is on it**: the user is returned to a valid screen with an explanation.
- **Module disabled with dependents**: disabling a module that other enabled modules depend on either cascades with explicit confirmation or is refused with the dependency named.
- **Integration credential expired**: dependent data is shown as stale with its last-successful-sync time rather than shown as current, and the affected capability degrades explicitly.
- **Live view loses its data source**: the wallboard states that data is stale and how old it is, rather than continuing to show numbers as if live.
- **AI unavailable or low confidence**: the assist panel states that no suggestion is available and why; the inbox remains fully usable.
- **AI action fails**: a next action that fails against an external system reports the failure and leaves the case unchanged, never partially applied.
- **Recording disabled or consent refused**: quality review handles contacts with no recording without breaking, and the scorecard reflects what could not be assessed.
- **Campaign contact opted out**: a contact who withdrew consent, or whose case is closed, is excluded from outbound attempts.
- **Outside working hours**: contacts arriving outside configured hours are handled by the configured out-of-hours behaviour and their SLA clock reflects the working-hours setting rather than wall-clock time.
- **Very long threads and attachments**: a thread with hundreds of messages, or messages carrying multiple attachments, remains navigable and does not degrade the agent's ability to reply.
- **Voice provider unreachable**: voice capabilities state that they are unavailable and why; every non-voice channel keeps working, and the workspace does not present the last-known queue figures as current.
- **Call ends without a clean event**: a call that drops, or whose end event never arrives, must not leave a conversation stuck in an in-progress state indefinitely — it resolves to a definite state and the gap is visible.
- **Published configuration drifts from authored**: when a flow, routing rule, intent or campaign has been edited but not published, the workspace shows that the live behaviour differs from what is on screen.
- **Provider and workspace disagree on agent state**: if an agent is on a call at the provider but marked available in the workspace (or the reverse), the discrepancy is reconciled rather than silently tolerated, and the agent is not routed work they cannot take.
- **Reused platform module disabled**: disabling a module Mercato Connect builds on degrades the dependent capability explicitly, naming what is missing, instead of failing opaquely.
- **Same conversation reached from two surfaces**: opening a conversation from Mercato Connect and from a pre-existing platform surface acts on one record; a change made in one is reflected in the other.

## Requirements *(mandatory)*

### Functional Requirements

#### Workspace shell and navigation

- **FR-001**: The workspace MUST present a persistent header carrying the installation brand name, a global search across customers, orders and cases, the agent's own availability state, and the agent's identity with their team and shift.
- **FR-002**: The agent MUST be able to change their own availability between available, busy and on-break from the header, and the current state MUST be visible at all times.
- **FR-003**: Navigation MUST group capabilities into service, traffic, analytics and configuration sections, and MUST show only the capabilities enabled for the installation.
- **FR-004**: The inbox navigation entry MUST show the count of open conversations, and the tickets entry MUST show the count of open tickets.
- **FR-005**: The workspace MUST display the active routing mode (automatic next-best assignment, or manual queue) and state in one sentence what that mode does.
- **FR-006**: Every action that changes state MUST confirm the outcome to the user in specific terms (what changed, to what), not a generic acknowledgement.
- **FR-007**: All user-facing text MUST be translatable; the workspace MUST ship with Polish and English locales, with no user-facing string hard-coded.

#### Omnichannel inbox

- **FR-008**: The system MUST support these contact channels as first-class citizens: phone, e-mail, web chat, WhatsApp, Messenger, SMS, Instagram DM, web form, and the customer portal. Each channel MUST be consistently identifiable by name and by a stable visual marker used across every screen.
- **FR-009**: Contacts from all channels concerning the same customer MUST be presented as a single chronological thread, including agent messages, customer messages, bot messages and system events.
- **FR-010**: The conversation list MUST show, per conversation: customer name, originating channel, time since last activity, remaining SLA time with health state, a preview of the last message, and VIP status where applicable.
- **FR-011**: The agent MUST be able to filter the conversation list by channel, including an "all channels" option, and the active filter MUST be visible.
- **FR-012**: The agent MUST be able to request the next case; the system MUST select it according to the active routing mode, assign it, and confirm which customer and channel was assigned.
- **FR-013**: The agent MUST be able to reply on any connected channel, independently of the channel the contact arrived on, and the chosen reply channel MUST be visible before sending.
- **FR-014**: The composer MUST send on Enter and insert a newline on Shift+Enter, and MUST offer inserting an AI suggestion, inserting a saved template, and attaching a file.
- **FR-015**: The agent MUST be able to transfer a conversation to another agent or queue, and MUST be able to open the customer's full profile from the conversation.
- **FR-016**: The agent MUST be able to close a case; closing MUST remove it from the open list, record an after-contact summary on the customer record, and move the agent to the next open case.
- **FR-017**: Remaining SLA time for the active conversation MUST be visible while the agent works, and MUST be visually distinguished at warning and breach levels.

#### AI assistance

- **FR-018**: When AI assistance is enabled, the workspace MUST present, per conversation: a case summary, a suggested reply, a set of suggested next actions each with a one-line rationale, and the sources the suggestion is grounded in.
- **FR-019**: A suggested reply MUST never be sent without the agent seeing it; inserting a suggestion MUST place editable text in the composer.
- **FR-020**: The agent MUST be able to insert, request a rewrite of, or reject a suggestion, and rejections MUST be recorded for acceptance-rate reporting.
- **FR-021**: Every suggestion MUST cite its sources, where a source is a knowledge-base article, a policy, order or stock data, or a prior contact.
- **FR-022**: A suggested next action MUST execute against the connected system when run, and MUST report success or failure explicitly.
- **FR-023**: AI assistance MUST be switchable off for the installation; with it off, every other inbox capability MUST remain fully functional.
- **FR-024**: After-contact summarisation MUST be switchable on or off; when on, the generated summary MUST be editable by the agent before it is stored.
- **FR-025**: The workspace MUST report on the AI programme: share of cases closed without an agent, agent acceptance rate, time recovered per case, average intent-recognition confidence, and per-template usage and acceptance.

#### Customer identity and profile

- **FR-026**: The system MUST resolve identifiers from different channels (phone number, e-mail address, social handle, portal account) to a single customer profile, MUST record a match-confidence score, and MUST let an agent inspect and re-check the match.
- **FR-027**: An incorrect merge MUST be reversible.
- **FR-028**: The customer profile MUST show lifetime value, order count, last NPS, churn risk and preferred channel, and MUST flag VIP status.
- **FR-029**: The customer profile MUST present a unified timeline of contacts, orders, automated notifications and bot interactions, each labelled with its channel.
- **FR-030**: The customer profile MUST provide separate views of the customer's conversations, orders and cases.
- **FR-031**: The customer profile MUST show each communication and marketing consent with its state and grant date, and MUST show call-recording notification status.
- **FR-032**: Commerce context — current order identifier, status, items, carrier and last tracking event — MUST be reachable from the conversation without leaving it, together with the case actions that context enables (return, credit/coupon, invoice).

#### Cases and service levels

- **FR-033**: A case MUST carry an identifier, subject, customer, originating channel, owner (or an explicit unassigned state), priority, status and remaining SLA time.
- **FR-034**: Case status MUST progress through *new → in progress → waiting on customer → resolved*, and the status change MUST record who changed it and when.
- **FR-035**: The case list MUST be filterable and exportable in a spreadsheet-readable format.
- **FR-036**: A case MUST be creatable manually as well as from a conversation, and the link between a case and its originating conversation MUST be navigable in both directions.
- **FR-037**: Remaining SLA time MUST be computed against the configured first-response target and the configured working hours, and MUST be distinguishable at healthy, at-risk and breached levels.
- **FR-038**: Concurrent edits to the same case or conversation MUST NOT silently overwrite one another; the later writer MUST be told the record changed and shown the current state.

#### Queues and live operations

- **FR-039**: The system MUST support named queues, each covering one or more channels, with a target agent count and a service-level target.
- **FR-040**: The live view MUST show total waiting, total in handling, today's service level and abandonment rate, and MUST refresh automatically.
- **FR-041**: The live view MUST show, per queue: waiting count, longest wait, staffed-vs-target agents, service level, and the channels the queue covers, with below-target and critical states visually distinguished.
- **FR-042**: A supervisor MUST be able to pull a case from a specific queue and have it assigned.
- **FR-043**: The live view MUST show, per agent: current state (on contact, wrapping up, ready, on break), team, cases handled today and average handling time.
- **FR-044**: When live data cannot be refreshed, the view MUST say so and state how old the displayed data is.

#### Reporting

- **FR-045**: The workspace MUST report first-contact resolution, average handling time, first-response service level, NPS, AI-handled share and cost per contact, each against the previous period and against target where one exists.
- **FR-046**: The workspace MUST report contact volume over time and share of contacts by channel for the selected period.
- **FR-047**: The workspace MUST report per agent: cases handled, first-contact resolution, average handling time, NPS and AI-suggestion acceptance rate.
- **FR-048**: The reporting period MUST be selectable, and the current view MUST be exportable as a report.

#### Outbound campaigns

- **FR-049**: A campaign MUST carry a name, contact mode, channel, owner, running state, target contact count, completed count, connect rate and conversion measure.
- **FR-050**: A campaign MUST be startable and pausable, and its state MUST be visible.
- **FR-051**: Callback and retry behaviour MUST be configurable: maximum attempts, permitted contact window, priority ordering, and the fallback channel used once attempts are exhausted.
- **FR-052**: Outbound contact MUST respect consent and MUST NOT contact customers whose related case is already closed.
- **FR-053**: Campaigns MUST draw on the same customer base as service, with no separate contact list to maintain.

#### Bots and voice flows

- **FR-054**: Intents MUST be defined once and shared across chatbot, voicebot and the voice menu.
- **FR-055**: Each intent MUST report example phrasings, volume, share contained without an agent, and share handed off, and MUST be individually switchable on or off.
- **FR-056**: Handoff to a human MUST be triggered by configurable conditions, and MUST carry the conversation summary to the receiving agent.
- **FR-057**: The system MUST surface knowledge gaps — questions the bot could not answer — with volume and the reason (missing article, stale article, missing intent).
- **FR-058**: A voice flow MUST be viewable as an ordered set of steps with a description and category per step, MUST record its last editor and edit time, and MUST be testable before publishing.
- **FR-059**: Voice routing MUST use spoken intent recognition as the primary path, falling back to a menu only when recognition confidence drops below the configured threshold.
- **FR-060**: Voice routing MUST consult commerce context (last order, open return, open cases) and route by service level and customer value before it reaches an agent.
- **FR-061**: When wait time exceeds the configured threshold, the system MUST offer a callback in a customer-chosen window instead of continued waiting.

#### Quality review

- **FR-062**: Contacts MUST be reviewable with identifier, channel, topic, customer, agent, duration, an automatic score and detected sentiment, with recording and transcript available where they exist.
- **FR-063**: A scorecard MUST assess named criteria, each with a score and maximum, MUST carry automatic reviewer notes, and MUST be approvable by a reviewer.
- **FR-064**: The system MUST select contacts for review by reason (low NPS, repeat contact on the same case, procedure deviation, new-agent contact) and report the count per reason.
- **FR-065**: Quality review MUST handle contacts with no recording without failing, and the scorecard MUST reflect what could not be assessed.

#### Customer self-service portal

- **FR-066**: The portal MUST show the customer their open cases with current status, last update time and a plain-language explanation of what is happening next.
- **FR-067**: Where a case offers customer-selectable resolutions, the portal MUST present them, and the customer's choice MUST be recorded on the case and visible to the agent.
- **FR-068**: The portal MUST show case history with channel and time, consistent with what the agent sees.
- **FR-069**: The portal MUST offer self-service actions that complete without agent involvement: return or exchange, invoice download, delivery reschedule.
- **FR-070**: A message the customer sends from the portal MUST join the same thread the agent works in.

#### Modularity, channels and integrations

- **FR-071**: Each capability MUST be individually enableable, and a disabled capability MUST disappear from team navigation.
- **FR-072**: The omnichannel inbox MUST be non-disableable, and an attempt to disable it MUST be refused with an explanation.
- **FR-073**: Each capability MUST declare its dependencies; disabling a capability that others depend on MUST either cascade with explicit confirmation or be refused with the dependency named.
- **FR-074**: Disabling the capability the current user is viewing MUST return them to a valid screen with an explanation.
- **FR-075**: Each channel MUST be individually connectable and disconnectable, and MUST report its operational status, volume and service level.
- **FR-076**: Each integration MUST report the data it covers, its permission scope (read, or read and write), its last successful synchronisation and its status.
- **FR-077**: When an integration's credential has expired or is about to expire, the system MUST raise it with the affected system named, the business consequence stated, and a direct renewal action offered.
- **FR-078**: Data from a failing integration MUST be presented as stale with its last-successful-sync time, never as current.
- **FR-079**: The settings screen MUST show the counts of active capabilities, connected channels and working integrations.
- **FR-080**: Service rules MUST be configurable: first-response target, team working hours, after-contact summarisation, and call recording with its lawful notification.

#### Access, tenancy and data protection

- **FR-081**: Every capability MUST be permission-gated, and a user MUST see only the capabilities and data their permissions allow.
- **FR-082**: All customer, conversation, case and reporting data MUST be scoped to its tenant and organisation, and MUST never be readable across that boundary.
- **FR-083**: Call recording MUST play its lawful notification at the start of a call, and the notification's status MUST be auditable per contact.
- **FR-084**: Consent state MUST be enforced at the point of outbound contact, not merely displayed.
- **FR-085**: Customer data MUST remain within the installation; no customer content may be sent to a third party that the operator has not explicitly connected.
- **FR-086**: Every state change to a conversation, case, module activation, channel connection and integration connection MUST be attributable to an actor and a time.

#### Composition with the existing platform

- **FR-087**: Mercato Connect MUST be delivered as capabilities composed on the installation's existing modules. It MUST NOT duplicate a capability listed in the *reuse* column of [Platform composition](#platform-composition), and MUST NOT fork or replace those modules.
- **FR-088**: A customer contact MUST be represented once across the installation. A conversation surfaced in Mercato Connect and the same conversation reached through an existing surface MUST be the same record, with the same message history, not two copies kept in step.
- **FR-089**: New contact channels MUST be added through the existing channel-adapter contract, so that connection lifecycle, credential refresh, health reporting and failure handling behave identically to channels already supported.
- **FR-090**: Existing surfaces MUST keep working when Mercato Connect is installed, and MUST keep working when it is uninstalled or its capabilities are disabled. Any change to a shared contract surface MUST follow the platform's deprecation protocol rather than breaking existing consumers.
- **FR-091**: Mercato Connect capabilities MUST degrade explicitly rather than fail when an underlying module is absent or disabled — the dependent capability states what is missing and why it is unavailable.

#### Voice through an external provider

- **FR-092**: Voice MUST be delivered through an external contact-centre provider connected via the integrations surface. Mercato Connect MUST NOT implement call transport, media handling or a softphone client.
- **FR-093**: The division of responsibility in [Voice boundary](#voice-boundary) MUST hold: Mercato Connect owns routing rules, flow and campaign definitions, recording policy, context supply, the agent experience and all reporting; the provider owns execution of those rules on the call path.
- **FR-094**: The workspace MUST supply customer, order and case context to the provider before routing occurs, so that a call is routed on service level and customer value rather than on menu selection alone.
- **FR-095**: Call events from the provider — call started, answered, queued, transferred, ended, recording available, transcript available — MUST be received and attached to the correct conversation and customer, and MUST be visible in the unified thread alongside other channels.
- **FR-096**: Live queue and agent state during a call MUST be sourced from the provider and displayed with its age; the workspace MUST NOT present provider-sourced figures as live when the provider connection is degraded.
- **FR-097**: The softphone control MUST hand off to the provider's client and reflect its call state, and the agent's availability state in Mercato Connect MUST stay consistent with their state at the provider in both directions.
- **FR-098**: Voice configuration authored in Mercato Connect — flow steps, routing rules, intents, dialer campaigns, recording policy — MUST be published to the provider as an explicit, testable action, and the workspace MUST show whether published configuration matches what is currently authored.
- **FR-099**: When the provider connection fails or its credential expires, the workspace MUST name the affected capability, state the business consequence, keep non-voice channels fully functional, and offer a direct renewal action.
- **FR-100**: The provider MUST be replaceable: no voice capability may depend on a single named vendor's specifics in a way that prevents connecting a different provider through the same surface.

### Key Entities

- **Conversation**: a continuous exchange with one customer, spanning one or more channels. Carries assigned agent, queue, originating channel, current reply channel, activity timestamps, SLA state and open/closed state.
- **Message**: a single entry in a conversation. Carries direction (inbound, outbound, bot, system event), author, channel, timestamp, body, attachments and delivery state.
- **Channel**: a connection to one contact medium. Carries type, connection state, credential validity, volume, service level and configuration.
- **Customer profile**: the unified view of one customer. Carries merged channel identifiers with match confidence, value metrics (lifetime value, orders, NPS, churn risk), tags, preferred channel, and consent records.
- **Case (ticket)**: a unit of work that may outlive one conversation. Carries identifier, subject, customer, originating channel, owner, priority, status, SLA deadline and links to conversations and orders.
- **Queue**: a routing target. Carries name, covered channels, staffing target, service-level target and current waiting/handling state.
- **Agent session**: an agent's current working state. Carries availability state, team, shift, current assignment, and handled/average-time counters for the day.
- **Campaign**: an outbound contact programme. Carries name, channel, mode, owner, audience, running state, progress, connect rate, conversion and retry/callback rules.
- **Bot intent**: a recognised customer purpose shared across bot channels. Carries name, example phrasings, enabled state, containment and handoff rates and volume.
- **Voice flow**: an ordered set of call-handling steps. Carries steps with category and description, publication state, last editor and edit time.
- **Recording & scorecard**: an assessable contact and its evaluation. Recording carries identifier, channel, participants, duration, transcript, sentiment and automatic score; scorecard carries criteria, per-criterion score, reviewer notes and approval state.
- **Integration connection**: a link to an external system. Carries system name, data scope, permission scope, last successful sync, status and credential expiry.
- **Module activation**: whether a capability is enabled for the installation, and its declared dependencies.
- **AI suggestion outcome**: a record of a suggestion the workspace showed and what the agent did with it — inserted, inserted after editing, rejected, sent back for rewrite, or left unused. Carries the sources shown with it and which agent acted. Without it FR-020 (rejections recorded) and FR-025 / SC-004 (acceptance rate) cannot be measured.
- **Service rules**: installation-level policy. Carries first-response target, working hours, after-contact summarisation setting and call-recording setting.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An agent handling a case that spans three channels resolves it without opening any other application, and without asking the customer to repeat information already given on a previous channel.
- **SC-002**: An agent opening a conversation can state what the case is about and what the customer's order status is within 10 seconds of the conversation appearing.
- **SC-003**: 90% of conversation views present the full cross-channel history and customer context within 2 seconds of selection.
- **SC-004**: At least 70% of AI-suggested replies are accepted or accepted-with-edits by agents, measured over a full reporting month.
- **SC-005**: No reply is sent to a customer that an agent did not see first — verified as zero occurrences across the trial period.
- **SC-006**: Identity merging correctly unifies at least 95% of multi-channel customers, and every merge is reversible.
- **SC-007**: A supervisor can identify the queue at greatest risk of a service-level breach within 5 seconds of opening the live view.
- **SC-008**: Live queue figures are never more than 10 seconds stale, and staleness beyond that is stated on screen rather than hidden.
- **SC-009**: An operator can enable or disable a capability and see team navigation reflect it without any restart or re-login.
- **SC-010**: An expired integration credential is surfaced to the operator, with its business consequence named, before dependent data has been stale for more than one working day.
- **SC-011**: At least 35% of contacts are resolved without agent involvement once bots, automations and the self-service portal are live.
- **SC-012**: Customers with an open case find its current status in the portal without contacting the team in at least 60% of cases where they log in.
- **SC-013**: Cost per contact falls measurably against the pre-deployment baseline over the first full reporting quarter.
- **SC-014**: First-response service level is met on at least 93% of contacts, measured against the configured target and working hours.
- **SC-015**: Every state change to a conversation, case, module, channel or integration is attributable to an actor and a time, with no unattributed changes in the audit record.
- **SC-016**: No customer, conversation, case or reporting record is ever readable outside its own tenant and organisation.
- **SC-017**: A new agent completes their first end-to-end case — take next, read context, reply, close — with no assistance after a single walkthrough.
- **SC-018**: A conversation is stored once. Opening the same conversation from Mercato Connect and from an existing platform surface shows identical message history, with zero divergence observed across the trial period.
- **SC-019**: Installing Mercato Connect breaks no existing surface, and disabling or removing it leaves every pre-existing surface working — verified as zero regressions in the existing surfaces' own test coverage.
- **SC-020**: A voice call reaches the right agent using customer and case context rather than menu navigation in at least 80% of calls, measured once the flow is published.
- **SC-021**: When the voice provider connection is degraded, no provider-sourced figure is presented as current — verified as zero occurrences of stale data shown without its age.
- **SC-022**: Switching to a different contact-centre provider requires changes only at the integration surface, with no change to routing rules, flow definitions, intents, campaigns or reporting.

## Assumptions

The following are reasonable defaults chosen where the design prototype did not specify. They are recorded here so they can be challenged rather than discovered later.

1. **Design system**: the workspace uses the existing Open Mercato design system and its tokens, primitives and content voice as documented in the design project's `_ds/` bundle. No new visual language is introduced. The prototype's inline styling is a prototyping artefact, not a specification of implementation.
2. **Language**: the prototype's copy is Polish. The delivered workspace is fully localisable, ships Polish and English, and hard-codes no user-facing string. Polish is the reference copy for tone and terminology.
3. **Density and platform**: this is a desktop-first, information-dense professional workspace for agents working a full shift, consistent with the prototype's three-pane inbox at ~1400px and its 336/660/344px column budget. The customer-facing portal is the exception and is single-column and responsive.
4. **Live refresh cadence**: the prototype refreshes live figures every 4 seconds. The specification requires only that live views refresh automatically and declare staleness; the exact cadence is a tuning decision.
5. **SLA targets**: selectable first-response targets are 30 minutes, 2 hours and 8 hours, and working-hours options are 8:00–16:00, 8:00–20:00, and 24/7 with bot coverage — matching the prototype. These are defaults, not a closed set.
6. **Ticket status model**: the four-state sequence *new → in progress → waiting on customer → resolved* is taken from the prototype and treated as the initial model; per-installation customisation is out of scope for this delivery.
7. **Commerce context source**: order, return, stock and invoice context comes from the Open Mercato commerce data already present in the installation. Third-party commerce systems (marketplace, shop platform, external CRM) reach the workspace through the integrations surface.
8. **AI provider**: AI capabilities run through the installation's existing AI assistant configuration; the operator chooses the provider and model there. No provider is assumed by this specification.
9. **Consent and recording**: the workspace enforces consent at the point of outbound contact and plays the lawful recording notification at call start. Jurisdiction-specific legal review of that notification text is outside this specification.
10. **Reporting periods**: monthly comparison against the previous month is the default reporting period, matching the prototype; other periods are selectable.
11. **Data residency**: customer data stays within the operator's installation. Any third party that processes customer content must be a connection the operator explicitly made.
12. **Softphone**: the header softphone control hands off to the external provider's client and reflects its call state. Mercato Connect does not embed a soft-client of its own (FR-092, FR-097).
13. **One voice provider at a time**: an installation connects a single contact-centre provider. The provider is replaceable (FR-100), but running two simultaneously — splitting queues or numbers across vendors — is not assumed.
14. **Provider-supplied transcription**: where the connected provider produces transcripts, those are used. Where it does not, the installation's existing transcription adapters supply them. Quality review does not assume transcription is always available (FR-065).
15. **Composition, not migration**: existing conversations and messages already held by the platform's channel modules are surfaced by Mercato Connect in place. This feature assumes no bulk data migration between platform modules.

## Out of Scope

- Workforce management: shift planning, forecasting and adherence scheduling.
- Field-service dispatch and on-site appointment scheduling.
- Knowledge-base authoring. The workspace *consumes* knowledge articles and *reports gaps* in them; writing and approving them is a separate surface.
- Building the commerce back office. Orders, returns, stock and invoicing are consumed here, not defined here.
- Billing, licensing and metering of the capabilities that the module switches enable.
- Migration of historical contact data from a legacy contact-centre platform.
- Voice biometrics, speaker identification and real-time in-call agent coaching.
- Public status pages and mass incident communication.
- **Voice execution**: call transport, carrier contracts and number provisioning, softphone media, queue and IVR execution, recording capture and media storage. These belong to the connected contact-centre provider (see [Voice boundary](#voice-boundary)).
- **Re-implementing reused platform capability**: channel connection lifecycle, credential refresh, message delivery, contact resolution, customer records, portal framework, integration sync and the permission model are consumed as they are (see [Platform composition](#platform-composition)).
- Running more than one voice provider concurrently in a single installation.

## Dependencies

- An Open Mercato installation with customer and commerce data present.
- The platform modules listed in the *reuse* column of [Platform composition](#platform-composition), present and enabled: `communication_channels`, `messages`, `inbox_ops`, `customers`, `customer_accounts`, `portal`, `notifications`, `integrations`, `dashboards`, `workflows`, and the AI assistant package.
- **An external contact-centre provider** connected through the integrations surface, supplying call transport, softphone, queue and IVR execution, and recording capture — plus transcription where it offers it. Every voice capability in this specification depends on it.
- Per non-voice channel, a working connection to that channel's provider (mailbox, chat widget host, WhatsApp Business, Meta pages, SMS gateway, Instagram, form endpoints).
- An AI assistant configuration for suggestion, summarisation and intent recognition.
- A knowledge source for suggestion grounding and gap reporting.
- Carrier/logistics connections for tracking and transport-damage claims.
- Permission and tenancy model already established in the installation.

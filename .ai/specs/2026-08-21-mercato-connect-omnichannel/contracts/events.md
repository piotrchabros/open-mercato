# Events Contract: Mercato Connect

Declared per module in `events.ts` via `createModuleEvents({ moduleId, events })` with `as const`. Run `yarn generate` after any change. Conventions in [README.md](./README.md).

## Broadcast budget

`clientBroadcast: true` streams to the browser over SSE; `portalBroadcast: true` streams to the customer portal. The bridge caps payloads at **4096 bytes**, sends heartbeats every 30 s and dedupes client-side within 500 ms (`packages/events/AGENTS.md` § DOM Event Bridge).

Therefore **broadcast payloads carry identifiers and counters only — never message bodies, customer PII or queue contents.** Consumers refetch on signal. This keeps SC-008 achievable without leaking content through the audience filter.

## `conversations`

| Event ID | Category | Payload | Broadcast |
|---|---|---|---|
| `conversations.conversation.created` | crud | `{ id, threadId, customerId?, primaryChannelType }` | client |
| `conversations.conversation.assigned` | crud | `{ id, assignedUserId, queueId? }` | client |
| `conversations.conversation.replied` | custom | `{ id, messageId, channelType, deliveryStatus }` | client + portal |
| `conversations.conversation.channel_bound` | custom | `{ id, externalConversationId, channelType }` | client |
| `conversations.conversation.closed` | crud | `{ id, closedAt, hasSummary }` | client + portal |
| `conversations.conversation.reopened` | crud | `{ id }` | client |
| `conversations.identity.merged` | custom | `{ auditId, targetCustomerId, identityCount, confidence }` | — |
| `conversations.identity.split` | custom | `{ auditId, sourceCustomerId, identityCount }` | — |
| `conversations.delivery.failed` | custom | `{ id, messageId, channelType, reasonKey }` | client |

`delivery.failed` is what makes the "send fails after submission" edge case visible rather than silent: the thread renders the failure against the message with a retry.

## `service_tickets`

| Event ID | Category | Payload | Broadcast |
|---|---|---|---|
| `service_tickets.ticket.created` | crud | `{ id, ticketNumber, customerId?, originChannelType, priority }` | client |
| `service_tickets.ticket.updated` | crud | `{ id, ticketNumber }` | client |
| `service_tickets.ticket.deleted` | crud | `{ id }` | client |
| `service_tickets.ticket.status_changed` | crud | `{ id, fromStatus, toStatus, actorUserId }` | client + portal |
| `service_tickets.ticket.sla_at_risk` | custom | `{ id, ticketNumber, deadlineAt }` | client |
| `service_tickets.ticket.sla_breached` | custom | `{ id, ticketNumber, breachedAt }` | client |

`sla_at_risk` / `sla_breached` are emitted by a scheduled worker, not on read — so alerting does not depend on someone having the list open.

## `contact_queues`

| Event ID | Category | Payload | Broadcast |
|---|---|---|---|
| `contact_queues.queue.state_changed` | custom | `{ queueId, waitingCount, inHandlingCount, longestWaitSeconds, serviceLevel, capturedAt }` | client |
| `contact_queues.queue.degraded` | system | `{ queueId?, sinceAt, reasonKey }` | client |
| `contact_queues.agent_session.state_changed` | custom | `{ userId, availability, providerState?, providerStateAt? }` | client |
| `contact_queues.case.pulled` | custom | `{ queueId, conversationId, userId }` | client |

`queue.degraded` is the SC-021 mechanism — the wallboard stops presenting figures as current the moment it arrives.

## `telephony`

| Event ID | Category | Payload | Broadcast |
|---|---|---|---|
| `telephony.call.started` | custom | `{ callRecordId, direction, queueRef?, conversationId? }` | client |
| `telephony.call.answered` | custom | `{ callRecordId, agentUserId }` | client |
| `telephony.call.ended` | custom | `{ callRecordId, disposition, durationSeconds }` | client |
| `telephony.call.recording_available` | custom | `{ callRecordId, recordingRef }` | — |
| `telephony.call.transcript_available` | custom | `{ callRecordId, transcriptRef }` | — |
| `telephony.call.reconciled` | system | `{ callRecordId, reasonKey }` | — |
| `telephony.flow.published` | custom | `{ flowId, version, actorUserId }` | client |
| `telephony.provider.degraded` | system | `{ providerKey, reasonKey, sinceAt }` | client |

`call.reconciled` is emitted by the sweep worker that closes calls whose `ended` event never arrived (edge case: unclean termination).

## `contact_campaigns`

| Event ID | Category | Payload | Broadcast |
|---|---|---|---|
| `contact_campaigns.campaign.run_state_changed` | crud | `{ id, runState, actorUserId }` | client |
| `contact_campaigns.campaign.progressed` | custom | `{ id, completedContactCount, targetContactCount }` | client |
| `contact_campaigns.attempt.suppressed` | custom | `{ campaignId, customerId, reasonKey }` | — |

`attempt.suppressed` makes consent and closed-case suppression auditable, not just enforced (FR-052).

## `bot_intents`

| Event ID | Category | Payload | Broadcast |
|---|---|---|---|
| `bot_intents.intent.toggled` | crud | `{ id, isEnabled, actorUserId }` | client |
| `bot_intents.conversation.handed_off` | custom | `{ conversationId, intentId, reasonKey, hasSummary }` | client |
| `bot_intents.knowledge_gap.detected` | custom | `{ id, topic, reason, questionVolume }` | — |

## `contact_quality`

| Event ID | Category | Payload | Broadcast |
|---|---|---|---|
| `contact_quality.review.queued` | custom | `{ id, selectionReason, channelType }` | — |
| `contact_quality.review.scored` | custom | `{ id, automaticScore }` | — |
| `contact_quality.review.approved` | crud | `{ id, reviewerUserId }` | client |

## Subscribers

| Subscriber | Listens to | Persistent | Why |
|---|---|---|---|
| `conversations/subscribers/bind-inbound-channel` | `communication_channels.*.message.received` | yes | Folds an inbound external conversation into a service conversation; must retry. |
| `conversations/subscribers/index-conversation` | `conversations.conversation.*` | no | Query-index upsert — read-your-writes path stays inline. |
| `service_tickets/subscribers/open-ticket-from-conversation` | `conversations.conversation.created` | yes | Optional; degrades when the module is disabled. |
| `telephony/subscribers/append-call-to-thread` | `telephony.call.ended` | yes | Writes the call as a `Message` on the thread (research R-07). |
| `contact_quality/subscribers/queue-review` | `telephony.call.ended`, `conversations.conversation.closed` | yes | Applies selection-reason rules. |
| `contact_analytics/subscribers/rollup-metrics` | `conversations.*`, `service_tickets.*`, `telephony.*` | yes | Feeds `ContactMetricRollup`. |
| `contact_campaigns/subscribers/suppress-on-close` | `service_tickets.ticket.status_changed` | yes | Enforces "no calling after a closed case" (FR-052). |

Persistent subscribers MUST be idempotent — they are retried. Cross-module subscribers resolve their peer through a module-local `tryResolve` and no-op when the peer is absent (FR-091), verified by `packages/core/src/__tests__/module-decoupling.test.ts`.

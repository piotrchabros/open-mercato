# Connect successor frozen-surface ledger

This file is authoritative for the nine successor specs; where another successor artifact disagrees, this file wins. Legacy merged/source packages are evidence, not implementation inputs.

| BC surface | Frozen Phase 1 contract |
|---|---|
| Module/package IDs | package/module `connect`; entity namespace `connect:*` |
| Events | `communication_channels.message.received` consumed; `communication_channels.delivery.outcome_recorded`; `connect.inbound.claimed`; `connect.inbound.disposed`; `connect.contact_identity.unresolved`; `connect.case.assigned`; `connect.case.resolved`; `connect.case.reopened`; `connect.outbound.attempted`; `connect.outbound.status_changed`; `connect.projection.status_changed` |
| ACL IDs | `communication_channels.shared_inbox.read`, `.send`, `.manage`; `customers.interactions.retract`; `connect.inbox.handle`; `connect.cases.view.all`, `.assign`, `.manage`; `connect.customer_match.read`, `.link`, `.unlink`, `.recover`, `.audit`; `connect.metrics.view`, `.manage` |
| DI/service IDs | `communicationChannelsSendAsUser`; `communicationChannelsThreadReader`; `communicationChannelsInboundEnvelopeReader`; `resolveInboundReplyTarget`; `customersInteractionLifecycle` with `resolveCustomerReference`, `createInteraction`, `beginRetractionSaga`, `listRetractions`, `commitRetractionSaga`, `abortRetractionSaga`, `finalizeRetractionSaga` |
| HTTP APIs | Foundation settings and receipt replay/ack; Inbox inbox/Case/thread/assign/message/read/retry/lifecycle routes; Projection manual-match/link/unlink/status and Case/customer-keyed context routes; Metrics summary/exceptions/rebuild; Contract E exact `/api/communication-channels/shared-inboxes...` routes enumerated in its API section |
| Commands | `ingest-message-received`, `assign-case`, `transition-case`, `enqueue-outbound`; source operations named in the DI row |
| Tables/entities | Foundation: `connect_case`, `connect_conversation`, `connect_conversation_case_binding`, `connect_contact_identity`, `connect_identity_case_binding`, `connect_case_transition`, `connect_inbound_receipt`, `connect_settings`, `connect_domain_outbox`; Inbox: `connect_outbound_message`, `connect_case_read_state`, `connect_outbound_attempt`, `connect_outbox`, `connect_assignment_audit`; Projection: `connect_identity_link_audit`, `connect_manual_match_task`, `connect_pending_projection`, `connect_pending_retraction`, `connect_retraction_saga`; Metrics: `connect_operational_fact`, `connect_metric_daily` |
| Queues | `connect.domain_outbox.publish`, `connect.inbound.receipts`, `connect.outbound.dispatch`, `connect.case.auto-close`, `connect.projection.drain`, `connect.projection.recovery`, `connect.metrics.aggregate` |
| Schedules | `connect:{organizationId}:domain-outbox-sweep`, `:inbound-receipt-sweep`, `:outbound-dispatch-sweep`, `:case-auto-close-sweep`, `:projection-drain-sweep`, `:projection-recovery-sweep`, `:metrics-daily` |
| Widget/DataTable IDs | `customers.people.list`, `customers.companies.list`, `detail:customers.person:footer`, `detail:customers.company:footer`; context `customers.detail.v1`; enriched property `connectContext` |
| Import/type surfaces | `SendAsUserInput`, `SendMessageInput`, bounded thread/envelope/reply schemas, delivery-outcome schema, Contract B lifecycle types; documented owner-module import paths only |
| Notifications | Inbox unknown-delivery notification ID must be `connect.outbound.unknown`; no other Phase 1 notification ID |
| Search/query-index IDs | `connect:connect_case`; no core-only query-index import; subject/wrap-up/handles/content excluded |
| AI agent/tool/UI override IDs | None introduced |
| Generated/discovery surfaces | workspace/app/create-app registries and generated module/entity registries updated through generators, never hand-edited except sanctioned typed registries |

Counts: **14/14 BC surface categories covered; 0 conflicts across successor specs; 0 wildcard-hidden identifier groups.** Braced `{organizationId}` is a runtime schedule scope parameter, not an undisclosed identifier family.

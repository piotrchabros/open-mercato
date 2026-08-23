import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Connect domain events.
 *
 * All of them are IDENTIFIER-ONLY. A Case subject or an inbound body would put
 * customer PII into persistent event storage, which is exactly what the
 * identifier-only upstream inbound event exists to avoid — repeating the
 * mistake one layer up would defeat it.
 *
 * They are published through the transactional outbox (`lib/domain-outbox.ts`),
 * not emitted inline, so an event can never describe a state that was rolled
 * back and a crash after commit does not lose the announcement.
 */
const events = [
  {
    id: 'connect.inbound.claimed',
    label: 'Inbound Receipt Claimed',
    entity: 'inbound_receipt',
    category: 'lifecycle',
  },
  {
    id: 'connect.inbound.disposed',
    label: 'Inbound Receipt Disposed',
    entity: 'inbound_receipt',
    category: 'lifecycle',
  },
  {
    id: 'connect.case.opened',
    label: 'Case Opened',
    entity: 'case',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'connect.case.attached',
    label: 'Inbound Attached To Case',
    entity: 'case',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'connect.case.status_changed',
    label: 'Case Status Changed',
    entity: 'case',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'connect.case.assigned',
    label: 'Case Assigned',
    entity: 'case',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'connect.case.resolved',
    label: 'Case Resolved',
    entity: 'case',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'connect.case.reopened',
    label: 'Case Reopened',
    entity: 'case',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  /**
   * Case reparenting. These three carry LINEAGE INSTRUCTIONS, not consumer
   * state: Connect says what it did to which Case, and an optional consumer such
   * as an SLA module decides under its own contract what that means for a clock.
   * Connect never imports, resolves or requires such a consumer, so its absence
   * changes no reparenting outcome.
   *
   * `sourceEventId` is the reparenting row's own id, which makes it stable
   * across the outbox's at-least-once publication.
   */
  {
    id: 'connect.case.split',
    label: 'Case Split',
    entity: 'case',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'connect.case.merged',
    label: 'Case Merged',
    entity: 'case',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'connect.case.reparenting_undone',
    label: 'Case Reparenting Undone',
    entity: 'case',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'connect.outbound.attempted',
    label: 'Outbound Reply Attempted',
    entity: 'outbound_attempt',
    category: 'lifecycle',
  },
  {
    id: 'connect.outbound.status_changed',
    label: 'Outbound Delivery Status Changed',
    entity: 'outbound_attempt',
    category: 'lifecycle',
    clientBroadcast: true,
  },
  {
    id: 'connect.projection.status_changed',
    label: 'Customer Projection Status Changed',
    entity: 'pending_projection',
    category: 'lifecycle',
  },
  /**
   * Emitted when a handle could not be matched to a customer with enough
   * confidence. Downstream matching/curation reacts to this; it deliberately
   * carries no handle value, only the identity id.
   */
  {
    id: 'connect.contact_identity.unresolved',
    label: 'Contact Identity Unresolved',
    entity: 'contact_identity',
    category: 'lifecycle',
  },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'connect', events })
export const emitConnectEvent = eventsConfig.emit
export type ConnectEventId = (typeof events)[number]['id']

export default eventsConfig

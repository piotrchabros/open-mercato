import type { EntityExtension } from '@open-mercato/shared/modules/entities'

/**
 * Cross-module links Connect declares.
 *
 * These are QUERY-ENGINE links, not ORM relations: Connect stores peer
 * identifiers as plain uuid columns and never imports a peer entity or queries a
 * peer table. Declaring them here is what lets a listing resolve an assignee's
 * name or a Case's customer without Connect reaching across the boundary itself.
 *
 * The direction is one-way (Connect → peers), so `auth`, `customers` and
 * `communication_channels` stay unaware of Connect and remain isomorphic.
 */
const entityExtensions: EntityExtension[] = [
  {
    base: 'auth:user',
    extension: 'connect:connect_case',
    join: { baseKey: 'id', extensionKey: 'assignee_user_id' },
    cardinality: 'one-to-many',
    description: 'Cases assigned to an agent',
  },
  {
    base: 'customers:customer_entity',
    extension: 'connect:connect_case',
    join: { baseKey: 'id', extensionKey: 'customer_id' },
    cardinality: 'one-to-many',
    description: 'Cases raised by a customer',
  },
  {
    base: 'customers:customer_entity',
    extension: 'connect:connect_contact_identity',
    join: { baseKey: 'id', extensionKey: 'customer_id' },
    cardinality: 'one-to-many',
    description: 'Contact handles linked to a customer',
  },
  {
    base: 'communication_channels:communication_channel',
    extension: 'connect:connect_case',
    join: { baseKey: 'id', extensionKey: 'channel_id' },
    cardinality: 'one-to-many',
    description: 'Cases raised through a shared inbox',
  },
  {
    base: 'communication_channels:external_conversation',
    extension: 'connect:connect_conversation',
    join: { baseKey: 'id', extensionKey: 'external_conversation_id' },
    cardinality: 'one-to-one',
    description: 'Connect state for a hub conversation',
  },
]

export const extensions = entityExtensions
export default entityExtensions

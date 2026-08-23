import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

/**
 * Connect encryption map.
 *
 * A Case subject and an agent's wrap-up are the customer's own account of their
 * problem, and a contact handle is a direct identifier — all three are
 * encrypted at rest.
 *
 * `connect_contact_identities.handle_value` declares a sibling `handleHash`
 * because equality lookup is the ONLY way Connect finds an identity, and an
 * encrypted column is not queryable by value. The hash is written even when
 * tenant data encryption is disabled, so turning encryption on later cannot
 * strand existing identities outside every lookup.
 *
 * `display_label` and `handle_display_label` stay plaintext on purpose: they are
 * masked, non-PII values that lists, logs and search documents may show.
 */
export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'connect:connect_case',
    fields: [{ field: 'subject' }, { field: 'wrap_up' }],
  },
  {
    entityId: 'connect:connect_contact_identity',
    fields: [{ field: 'handle_value', hashField: 'handle_hash' }],
  },
  {
    // The agent's reply to the customer. Retention erases the ciphertext once
    // no retry or reconciliation still needs it; the row itself is kept so the
    // delivery history stays auditable.
    entityId: 'connect:connect_outbound_message',
    fields: [{ field: 'payload' }],
  },
  {
    // An operator's note about why an identity was linked or unlinked. It
    // routinely names the customer and the mistake, so it is encrypted like any
    // other free text about a person.
    entityId: 'connect:connect_identity_link_audit',
    fields: [{ field: 'reason' }],
  },
  {
    // A supervisor's note about why two Cases were merged, or why conversations
    // were split out. It names the customer and the mistake, so it is encrypted
    // like the link audit's reason.
    //
    // Only `reason`. The before/after snapshots on the same row stay plaintext
    // deliberately: undo compares them field-by-field to decide whether a
    // reversal is safe, they hold identifiers, enums and timestamps only, and
    // encrypting them would make that comparison require decrypting the row.
    entityId: 'connect:connect_case_reparenting',
    fields: [{ field: 'reason' }],
  },
]

export default defaultEncryptionMaps

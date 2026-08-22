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
]

export default defaultEncryptionMaps

import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

/**
 * Cost descriptions are operator free text on a financial row — in practice
 * they carry account numbers, contract references and occasionally a named
 * individual. They are encrypted at rest and excluded from search, report
 * DTOs, event payloads, audit snapshots, logs and errors.
 *
 * The revision-secret columns are in the same map so undo can restore a prior
 * description without the audit trail ever holding one in clear.
 */
export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'connect_analytics:cost_input',
    fields: [
      { field: 'description' },
    ],
  },
  {
    entityId: 'connect_analytics:cost_input_revision_secret',
    fields: [
      { field: 'description_before' },
      { field: 'description_after' },
    ],
  },
]

export default defaultEncryptionMaps

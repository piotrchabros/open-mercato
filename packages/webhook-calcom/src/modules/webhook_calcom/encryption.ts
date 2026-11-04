import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'webhook_calcom:calcom_unassigned_transcript',
    fields: [
      { field: 'title' },
      { field: 'organizer_email' },
      { field: 'participants_summary' },
      { field: 'summary_text' },
      { field: 'payload' },
    ],
  },
]

export default defaultEncryptionMaps

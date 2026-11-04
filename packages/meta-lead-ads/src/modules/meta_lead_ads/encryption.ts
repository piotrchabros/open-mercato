import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'meta_lead_ads:meta_connection',
    fields: [{ field: 'user_access_token' }],
  },
  {
    entityId: 'meta_lead_ads:meta_page',
    fields: [{ field: 'page_access_token' }],
  },
  {
    entityId: 'meta_lead_ads:meta_lead_event',
    fields: [
      { field: 'raw_notification' },
      { field: 'raw_payload' },
      { field: 'ad_name' },
      { field: 'adset_name' },
      { field: 'campaign_name' },
    ],
  },
  {
    entityId: 'meta_lead_ads:meta_consent',
    fields: [{ field: 'consent_text' }],
  },
]

export default defaultEncryptionMaps

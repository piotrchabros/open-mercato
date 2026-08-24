import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'connect_sla:business_holiday',
    fields: [{ field: 'label' }],
  },
]

export default defaultEncryptionMaps

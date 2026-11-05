import type { ModuleEncryptionMap } from '@open-mercato/shared/modules/encryption'

export const defaultEncryptionMaps: ModuleEncryptionMap[] = [
  {
    entityId: 'offer_generator:offer',
    fields: [{ field: 'prompt' }, { field: 'notes' }],
  },
  {
    entityId: 'offer_generator:offer_generation_run',
    fields: [{ field: 'input_text' }],
  },
]

export default defaultEncryptionMaps

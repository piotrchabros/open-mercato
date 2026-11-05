import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { ensureSettingsRow } from './lib/settings'

const ADMIN_FEATURES = [
  'offer_generator.*',
  'offer_generator.view',
  'offer_generator.manage',
  'offer_generator.generate',
  'offer_generator.settings.manage',
]

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ADMIN_FEATURES,
    admin: ADMIN_FEATURES,
    employee: ['offer_generator.view', 'offer_generator.manage', 'offer_generator.generate'],
  },
  async onTenantCreated({ em, tenantId, organizationId }) {
    await ensureSettingsRow(em, { tenantId, organizationId })
  },
  async seedDefaults({ em, tenantId, organizationId }) {
    await ensureSettingsRow(em, { tenantId, organizationId })
  },
}

export default setup

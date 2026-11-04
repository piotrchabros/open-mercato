import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { applyMetaLeadAdsEnvPreset } from './lib/preset'
import { registerMetaLeadAdsSchedules } from './lib/schedules'
import { ensureSettingsRow } from './lib/settings'

const logger = createLogger('meta_lead_ads')

const ADMIN_FEATURES = ['meta_lead_ads.*', 'meta_lead_ads.manage', 'meta_lead_ads.view_logs']

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ADMIN_FEATURES,
    admin: ADMIN_FEATURES,
    employee: ['meta_lead_ads.view_logs'],
  },
  async onTenantCreated({ em, tenantId, organizationId }) {
    await ensureSettingsRow(em, { tenantId, organizationId })
  },
  async seedDefaults({ container, em, tenantId, organizationId }) {
    const scope = { tenantId, organizationId }
    await ensureSettingsRow(em, scope)
    try {
      await applyMetaLeadAdsEnvPreset({ container, scope })
    } catch (error) {
      logger.warn('Failed to apply Meta Lead Ads environment preset', { err: error })
    }
    await registerMetaLeadAdsSchedules(container, scope)
  },
}

export default setup

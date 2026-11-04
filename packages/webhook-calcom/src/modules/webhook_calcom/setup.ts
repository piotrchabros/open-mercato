import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { applyCalcomEnvPreset } from './lib/preset'

const logger = createLogger('webhook_calcom').child({ component: 'setup' })

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    admin: [
      'webhook_calcom.*',
    ],
    employee: [
      'webhook_calcom.transcripts.view',
      'webhook_calcom.transcripts.manage',
    ],
  },

  async seedDefaults({ tenantId, organizationId, container }) {
    try {
      const result = await applyCalcomEnvPreset({ container, scope: { tenantId, organizationId } })
      if (result.status === 'skipped') {
        logger.debug('env preset not applied', { reason: result.reason })
      } else {
        logger.info('env preset applied')
      }
    } catch (err) {
      logger.warn('failed to apply the env preset during tenant setup', { err })
    }
  },
}

export default setup

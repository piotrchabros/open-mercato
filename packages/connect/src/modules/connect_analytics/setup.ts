import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

/**
 * Analytics owns no storage, so setup is grants only.
 *
 * A manager gets the report; a front-line agent does not. Organization-wide
 * volume, response percentiles and the suppression safety criterion are an
 * operations audience, not something an agent needs to handle their own Cases.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['connect_analytics.*'],
    admin: ['connect_analytics.*'],
    manager: ['connect_analytics.view'],
  },
}

export default setup

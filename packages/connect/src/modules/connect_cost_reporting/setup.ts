import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['connect_cost_reporting.*'],
    admin: ['connect_cost_reporting.*'],
    manager: ['connect_cost_reporting.view'],
  },
}

export default setup

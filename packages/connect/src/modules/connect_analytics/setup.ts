import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'

/**
 * Connect analytics setup.
 *
 * Grants only. There is no tenant state to create: the operational report is a
 * pure projection of Phase 1 aggregates, and cost rows are entered by a human,
 * never seeded — a seeded cost would be indistinguishable from a recorded one
 * in every downstream total.
 *
 * A manager reads operational analytics and recorded spend but cannot record
 * it; an employee gets neither, because organization-wide volume and invoice
 * amounts are both outside a front-line agent's remit.
 */
export const setup: ModuleSetupConfig = {
  defaultRoleFeatures: {
    superadmin: ['connect_analytics.*'],
    admin: ['connect_analytics.*'],
    manager: ['connect_analytics.view', 'connect_analytics.cost_inputs.view'],
  },
}

export default setup

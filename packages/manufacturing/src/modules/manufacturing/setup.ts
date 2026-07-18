import type { ModuleSetupConfig } from '@open-mercato/shared/modules/setup'
import { seedScrapReasonDictionary } from './cli.js'

/**
 * Default role grants (spec § Access Control). The module-specific roles
 * mirror the manufacturing personas: technolog (technology), planista
 * (orders + MRP), kierownik (reports oversight), magazynier-lite (stock),
 * operator (shop-floor surface ONLY — spec decision e).
 */
export const setup: ModuleSetupConfig = {
  seedDefaults: async (ctx) => {
    // New-tenant path (task 4.2); existing tenants use the
    // `manufacturing seed-scrap-reasons` CLI backfill in `cli.ts`.
    await seedScrapReasonDictionary(ctx.em, { tenantId: ctx.tenantId, organizationId: ctx.organizationId })
  },

  defaultRoleFeatures: {
    admin: ['manufacturing.*'],
    employee: [
      'manufacturing.technology.view',
      'manufacturing.orders.view',
      'manufacturing.reports.view',
    ],
    technolog: [
      'manufacturing.technology.view',
      'manufacturing.technology.manage',
      'manufacturing.orders.view',
    ],
    planista: [
      'manufacturing.technology.view',
      'manufacturing.stock.view',
      'manufacturing.orders.view',
      'manufacturing.orders.manage',
      'manufacturing.reports.view',
      // `manufacturing.operator.report` (not just `reports.manage`) is required
      // to POST /api/manufacturing/reports — see the route metadata doc comment
      // in `api/reports/route.ts` for why the report-submission route is
      // gated on this single feature instead of an OR of two features.
      'manufacturing.operator.report',
      'manufacturing.mrp.view',
      'manufacturing.mrp.manage',
    ],
    kierownik: [
      'manufacturing.technology.view',
      'manufacturing.stock.view',
      'manufacturing.orders.view',
      'manufacturing.reports.view',
      'manufacturing.reports.manage',
      'manufacturing.operator.report',
      'manufacturing.mrp.view',
    ],
    'magazynier-lite': [
      'manufacturing.stock.view',
      'manufacturing.stock.manage',
      'manufacturing.orders.view',
    ],
    operator: [
      'manufacturing.operator.view',
      'manufacturing.operator.report',
    ],
  },
}

export default setup

import type { ModuleInjectionTable } from '@open-mercato/shared/modules/widgets/injection'

/**
 * Connect's contributions to the Customers screens.
 *
 * Both hosts are FROZEN contracts owned by the customers module; Connect reuses
 * them and introduces no host address of its own. Every entry is inert when
 * customers is absent, because each is keyed on a spot only that module renders
 * — so this stays one static object literal rather than a branch on module
 * presence (a computed table folds to zero contributions in the fact extractor).
 *
 * The list columns read `_connect` from the row, which the response enrichers in
 * `data/enrichers.ts` add in one batched query per page. The detail footers
 * fetch their own single-reference context, because a detail page renders one
 * record and batching buys nothing there.
 */
export const injectionTable: ModuleInjectionTable = {
  'data-table:customers.people.list:columns': {
    widgetId: 'connect.injection.customer-cases-column',
    priority: 20,
  },
  'data-table:customers.companies.list:columns': {
    widgetId: 'connect.injection.customer-cases-column',
    priority: 20,
  },
  'detail:customers.person:footer': [
    {
      widgetId: 'connect.injection.customer-cases',
      kind: 'stack' as const,
      priority: 60,
    },
  ],
  'detail:customers.company:footer': [
    {
      widgetId: 'connect.injection.customer-cases',
      kind: 'stack' as const,
      priority: 60,
    },
  ],
}

export default injectionTable

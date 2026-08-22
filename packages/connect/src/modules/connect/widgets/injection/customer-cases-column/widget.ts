import type { InjectionColumnWidget } from '@open-mercato/shared/modules/widgets/injection'

/**
 * "Open conversations" on the People and Companies lists.
 *
 * Reads `_connect.openCaseCount`, which the response enrichers supply in one
 * batched query per page — the column itself issues no request, so adding it
 * cannot turn a list render into a burst of round trips.
 *
 * A row with no `_connect` renders an em dash rather than `0`. Absence means
 * Connect contributed nothing (out of scope, inert, or not permitted); a zero
 * would assert that this customer has no conversations, which is a different
 * claim and not one this column is entitled to make.
 */
const widget: InjectionColumnWidget = {
  metadata: {
    id: 'connect.injection.customer-cases-column',
    title: 'Open conversations',
    description: 'Shows how many Connect conversations are open for a customer.',
    features: ['connect.customer_match.read'],
    requiredModules: ['customers'],
    priority: 20,
    enabled: true,
  },
  columns: [
    {
      id: 'connect_open_cases',
      headerKey: 'connect.customerContext.column.openCases',
      header: 'Open conversations',
      accessorKey: '_connect.openCaseCount',
      // Server-side sorting would require the customers list query to join a
      // Connect table, which is exactly the cross-module coupling enrichers
      // exist to avoid.
      sortable: false,
      cell: ({ getValue }) => {
        const value = getValue()
        return typeof value === 'number' ? String(value) : '—'
      },
    },
  ],
}

export default widget

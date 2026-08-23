import { createModuleEvents } from '@open-mercato/shared/modules/events'

/**
 * Connect analytics domain events.
 *
 * IDENTIFIER-ONLY, and more strictly than usual: a cost event carries the row
 * id, its scope and its version, and nothing else. An amount or a provider
 * invoice reference in persistent event storage would put commercially
 * sensitive data somewhere with a different retention and a different audience
 * from the table it came from, and a description would put personal data
 * there in clear.
 */
const events = [
  {
    id: 'connect_analytics.cost_input.created',
    label: 'Cost Input Created',
    entity: 'cost_input',
    category: 'crud',
  },
  {
    id: 'connect_analytics.cost_input.updated',
    label: 'Cost Input Updated',
    entity: 'cost_input',
    category: 'crud',
  },
  {
    id: 'connect_analytics.cost_input.deleted',
    label: 'Cost Input Deleted',
    entity: 'cost_input',
    category: 'crud',
  },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'connect_analytics', events })
export const emitConnectAnalyticsEvent = eventsConfig.emit
export type ConnectAnalyticsEventId = (typeof events)[number]['id']

export default eventsConfig

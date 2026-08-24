import { createModuleEvents } from '@open-mercato/shared/modules/events'

const events = [
  { id: 'connect_sla.clock.started', label: 'SLA Clock Started', entity: 'case_clock', category: 'lifecycle' },
  { id: 'connect_sla.clock.responded', label: 'SLA Clock Responded', entity: 'case_clock', category: 'lifecycle' },
  { id: 'connect_sla.clock.response_breached', label: 'SLA Response Breached', entity: 'case_clock', category: 'lifecycle' },
  { id: 'connect_sla.clock.resolved', label: 'SLA Clock Resolved', entity: 'case_clock', category: 'lifecycle' },
  { id: 'connect_sla.clock.resolution_breached', label: 'SLA Resolution Breached', entity: 'case_clock', category: 'lifecycle' },
  { id: 'connect_sla.clock.merged', label: 'SLA Clock Merged', entity: 'case_clock', category: 'lifecycle' },
  { id: 'connect_sla.clock.superseded', label: 'SLA Clock Superseded', entity: 'case_clock', category: 'lifecycle' },
] as const

export const eventsConfig = createModuleEvents({ moduleId: 'connect_sla', events })
export const emitConnectSlaEvent = eventsConfig.emit
export type ConnectSlaEventId = (typeof events)[number]['id']

export default eventsConfig

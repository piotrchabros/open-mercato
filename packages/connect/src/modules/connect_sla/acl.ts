export const features = [
  { id: 'connect_sla.policy.view', title: 'View Connect SLA policies', module: 'connect_sla' },
  {
    id: 'connect_sla.policy.manage',
    title: 'Manage Connect SLA policies',
    module: 'connect_sla',
    dependsOn: ['connect_sla.policy.view'],
  },
  { id: 'connect_sla.calendar.view', title: 'View Connect SLA calendars', module: 'connect_sla' },
  {
    id: 'connect_sla.calendar.manage',
    title: 'Manage Connect SLA calendars',
    module: 'connect_sla',
    dependsOn: ['connect_sla.calendar.view'],
  },
  { id: 'connect_sla.clock.view', title: 'View Connect SLA clocks', module: 'connect_sla' },
  {
    id: 'connect_sla.clock.rebuild',
    title: 'Rebuild Connect SLA clocks',
    module: 'connect_sla',
    dependsOn: ['connect_sla.clock.view'],
  },
] as const

export default features

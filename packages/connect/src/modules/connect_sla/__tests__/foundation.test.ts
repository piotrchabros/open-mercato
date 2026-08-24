import { features } from '../acl'
import eventsConfig from '../events'
import { setup } from '../setup'

describe('connect SLA foundation contracts', () => {
  it('declares the six approved ACL identifiers and dependencies', () => {
    expect(features.map((feature) => feature.id)).toEqual([
      'connect_sla.policy.view',
      'connect_sla.policy.manage',
      'connect_sla.calendar.view',
      'connect_sla.calendar.manage',
      'connect_sla.clock.view',
      'connect_sla.clock.rebuild',
    ])
    expect(features.filter((feature) => 'dependsOn' in feature).map((feature) => feature.dependsOn)).toEqual([
      ['connect_sla.policy.view'],
      ['connect_sla.calendar.view'],
      ['connect_sla.clock.view'],
    ])
  })

  it('grants wildcard administration without granting front-line roles', () => {
    expect(setup.defaultRoleFeatures?.superadmin).toEqual(['connect_sla.*'])
    expect(setup.defaultRoleFeatures?.admin).toEqual(['connect_sla.*'])
    expect(setup.defaultRoleFeatures?.manager).toBeUndefined()
    expect(setup.defaultRoleFeatures?.employee).toBeUndefined()
  })

  it('declares only the seven approved clock lifecycle events', () => {
    expect(eventsConfig.events.map((event) => event.id)).toEqual([
      'connect_sla.clock.started',
      'connect_sla.clock.responded',
      'connect_sla.clock.response_breached',
      'connect_sla.clock.resolved',
      'connect_sla.clock.resolution_breached',
      'connect_sla.clock.merged',
      'connect_sla.clock.superseded',
    ])
  })
})

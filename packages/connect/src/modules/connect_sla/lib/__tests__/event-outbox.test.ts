import type { EntityManager } from '@mikro-orm/postgresql'
import { SlaEventOutbox } from '../../data/entities'
import { stageClockEvent } from '../event-outbox'
import { createClock, type PolicyMatchCandidate } from '../clock-domain'

const policy: PolicyMatchCandidate = {
  policyId: 'policy', policyVersionId: 'policy-version', calendarVersionId: 'calendar-version', channelId: null,
  priority: 1, effectiveFrom: new Date('2026-08-24T00:00:00Z'), isActive: true,
  responseTargetMinutes: 30, resolutionTargetMinutes: 120,
}
const calendar = { timezone: 'UTC', windows: [{ weekday: 1, startSecond: 0, endSecond: 86400 }], holidays: [] }

describe('Connect SLA transactional event outbox', () => {
  it('stages the exact identifier-only V1 payload without publishing', () => {
    const persist = jest.fn()
    const create = jest.fn((_entity, values) => values)
    const em = { create, persist } as unknown as EntityManager
    const clock = createClock({ id: 'clock', caseId: 'case', generation: 4, sourceEventId: 'generation', startedAt: new Date('2026-08-24T09:00:00Z'), policy, calendar })

    stageClockEvent(em, { tenantId: 'tenant', organizationId: 'organization' }, 'connect_sla.clock.started', clock, 'source', new Date('2026-08-24T09:00:00Z'))

    expect(create).toHaveBeenCalledWith(SlaEventOutbox, expect.objectContaining({ tenantId: 'tenant', organizationId: 'organization', sourceEventId: 'source', eventType: 'connect_sla.clock.started', status: 'pending' }))
    expect(create.mock.calls[0][1].payload).toEqual({
      schemaVersion: 1,
      clockId: 'clock',
      caseId: 'case',
      generation: 4,
      responseState: 'open',
      resolutionState: 'open',
      occurredAt: '2026-08-24T09:00:00.000Z',
      sourceEventId: 'source',
    })
    expect(persist).toHaveBeenCalledTimes(1)
  })
})

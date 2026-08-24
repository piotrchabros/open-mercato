import { createContainer, InjectionMode, asValue } from 'awilix'
import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { register } from '../di'

function makeContainer(extra: Record<string, unknown> = {}) {
  const container = createContainer({ injectionMode: InjectionMode.CLASSIC }) as unknown as AppContainer
  container.register({
    em: asValue({ find: jest.fn(), findOne: jest.fn() }),
    ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, asValue(value)])),
  })
  register(container)
  return container
}

describe('connect SLA DI', () => {
  it('resolves scoped readers with CLASSIC named em injection', () => {
    const container = makeContainer()
    expect(container.resolve('connectSlaCalendarReader')).toEqual(expect.objectContaining({ findById: expect.any(Function) }))
    expect(container.resolve('connectSlaPolicyReader')).toEqual(expect.objectContaining({ listCandidates: expect.any(Function) }))
    expect(container.resolve('connectSlaClockReader')).toEqual(expect.objectContaining({ findForCase: expect.any(Function) }))
    expect(container.resolve('connectSlaSourceConsumer')).toEqual(expect.objectContaining({ apply: expect.any(Function) }))
    expect(container.resolve('connectSlaGenerationConsumer')).toEqual(expect.objectContaining({ apply: expect.any(Function) }))
    expect(container.resolve('connectSlaReparentConsumer')).toEqual(expect.objectContaining({ apply: expect.any(Function) }))
    expect(container.resolve('connectSlaDeadlineSweepService')).toEqual(expect.objectContaining({ sweep: expect.any(Function) }))
    expect(container.resolve('connectSlaRebuildService')).toEqual(expect.objectContaining({ rebuild: expect.any(Function) }))
  })

  it('reports both optional Connect facades as missing without throwing', () => {
    const health = makeContainer().resolve('connectSlaDependencyHealth') as { available: boolean; missing: string[] }
    expect(health).toEqual(expect.objectContaining({
      available: false,
      missing: ['connectCaseSlaReader', 'connectCaseReparentingReader'],
    }))
  })

  it('reports healthy when both Connect facades are registered', () => {
    const sourceReader = { listGenerations: jest.fn() }
    const reparentingReader = { listReparentings: jest.fn() }
    const health = makeContainer({
      connectCaseSlaReader: sourceReader,
      connectCaseReparentingReader: reparentingReader,
    }).resolve('connectSlaDependencyHealth') as { available: boolean; connectCaseSlaReader: unknown; connectCaseReparentingReader: unknown }
    expect(health).toEqual(expect.objectContaining({
      available: true,
      connectCaseSlaReader: sourceReader,
      connectCaseReparentingReader: reparentingReader,
    }))
  })
})

import { asFunction, asValue, createContainer, InjectionMode } from 'awilix'

// `createRequestContainer()` pins the request container to InjectionMode.CLASSIC
// (container.ts). Every module `di.ts` in the repo is written against the
// resolution semantics asserted here, and `packages/core/src/__tests__/di-classic-proxy.test.ts`
// enforces the `.proxy()` rule those semantics imply.
//
// This suite pins the semantics themselves so an awilix upgrade that changes how
// CLASSIC parses factory parameters fails here — loudly — instead of silently
// re-breaking (or silently fixing) dozens of registrations. Issue #4201.

type Dependencies = { em: unknown; eventBus: unknown }

const em = { tag: 'entity-manager' }
const eventBus = { tag: 'event-bus' }

function buildClassicContainer() {
  const container = createContainer({ injectionMode: InjectionMode.CLASSIC })
  container.register({ em: asValue(em), eventBus: asValue(eventBus) })
  return container
}

describe('Awilix CLASSIC injection mode semantics', () => {
  it('resolves named parameters positionally', () => {
    const container = buildClassicContainer()
    container.register({
      service: asFunction((em: unknown, eventBus: unknown) => ({ em, eventBus })).scoped(),
    })

    expect(container.resolve<Dependencies>('service')).toEqual({ em, eventBus })
  })

  it('injects undefined into a shorthand-destructured factory that omits .proxy()', () => {
    const container = buildClassicContainer()
    container.register({
      service: asFunction(({ em, eventBus }: Dependencies) => ({ em, eventBus })).scoped(),
    })

    // CLASSIC resolves `em` and `eventBus` and passes them as two POSITIONAL
    // arguments; the factory then destructures the first one — the EntityManager
    // itself — so both bindings come out undefined. This is the dangerous failure
    // mode: no error, just missing dependencies. A service guarding with
    // `dep ?? null` then reports "no data" instead of "misconfigured".
    expect(container.resolve<Dependencies>('service')).toEqual({ em: undefined, eventBus: undefined })
  })

  it('throws for a renamed-binding destructured factory that omits .proxy()', () => {
    const container = buildClassicContainer()
    container.register({
      service: asFunction(({ em: entityManager }: Dependencies) => ({ em: entityManager })).scoped(),
    })

    // The renamed binding is what CLASSIC parses as the dependency name, so it
    // looks for a registration called `entityManager` rather than `em`.
    expect(() => container.resolve('service')).toThrow(/entityManager/)
  })

  it('throws for a `cradle`-named factory that omits .proxy()', () => {
    const container = buildClassicContainer()
    container.register({
      service: asFunction((cradle: Dependencies) => ({ em: cradle.em })).scoped(),
    })

    expect(() => container.resolve('service')).toThrow(/cradle/)
  })

  it('resolves every shape correctly once the registration chains .proxy()', () => {
    const container = buildClassicContainer()
    container.register({
      shorthand: asFunction(({ em, eventBus }: Dependencies) => ({ em, eventBus }))
        .scoped()
        .proxy(),
      renamed: asFunction(({ em: entityManager, eventBus: bus }: Dependencies) => ({
        em: entityManager,
        eventBus: bus,
      }))
        .scoped()
        .proxy(),
      viaCradle: asFunction((cradle: Dependencies) => ({ em: cradle.em, eventBus: cradle.eventBus }))
        .scoped()
        .proxy(),
    })

    expect(container.resolve<Dependencies>('shorthand')).toEqual({ em, eventBus })
    expect(container.resolve<Dependencies>('renamed')).toEqual({ em, eventBus })
    expect(container.resolve<Dependencies>('viaCradle')).toEqual({ em, eventBus })
  })
})

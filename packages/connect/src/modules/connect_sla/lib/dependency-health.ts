import type { AppContainer } from '@open-mercato/shared/lib/di/container'

export const CONNECT_SLA_SOURCE_READER_KEY = 'connectCaseSlaReader'
export const CONNECT_SLA_REPARENTING_READER_KEY = 'connectCaseReparentingReader'

export type ConnectSlaDependencyHealth = {
  available: boolean
  missing: string[]
  connectCaseSlaReader: unknown | null
  connectCaseReparentingReader: unknown | null
}

function tryResolve(container: AppContainer, key: string): unknown | null {
  const registry = container as { hasRegistration?: (name: string) => boolean }
  if (typeof registry.hasRegistration !== 'function' || !registry.hasRegistration(key)) return null
  try {
    return container.resolve(key)
  } catch {
    return null
  }
}

export function createConnectSlaDependencyHealth(container: AppContainer): ConnectSlaDependencyHealth {
  const connectCaseSlaReader = tryResolve(container, CONNECT_SLA_SOURCE_READER_KEY)
  const connectCaseReparentingReader = tryResolve(container, CONNECT_SLA_REPARENTING_READER_KEY)
  const missing = [
    ...(connectCaseSlaReader === null ? [CONNECT_SLA_SOURCE_READER_KEY] : []),
    ...(connectCaseReparentingReader === null ? [CONNECT_SLA_REPARENTING_READER_KEY] : []),
  ]
  return { available: missing.length === 0, missing, connectCaseSlaReader, connectCaseReparentingReader }
}

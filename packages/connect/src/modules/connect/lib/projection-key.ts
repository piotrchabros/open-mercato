/**
 * Deterministic source keys for Customer-timeline projections.
 *
 * Derived from the Case id and a projection VERSION, never from retry time or a
 * random id. That is what lets a retried projection be recognised by the source
 * as the same one instead of creating a second timeline entry — and what lets a
 * retraction reference exactly the entry it means to hide.
 *
 * Relinking bumps the version rather than reusing the key, so a new projection
 * is a genuinely new entry and the tombstoned one is never revived.
 */

export const CONNECT_PROJECTION_NAMESPACE = 'connect'

export function buildProjectionKey(caseId: string, projectionVersion: number): string {
  return `case:${caseId}:v${projectionVersion}`
}

/** Stable identity of a retraction saga for one identity + association epoch. */
export function buildSagaId(identityId: string, associationEpoch: number): string {
  return `unlink:${identityId}:e${associationEpoch}`
}

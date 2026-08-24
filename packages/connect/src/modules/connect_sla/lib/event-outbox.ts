import type { EntityManager } from '@mikro-orm/postgresql'
import { SlaEventOutbox } from '../data/entities'
import type { ConnectSlaEventId } from '../events'
import type { ClockState } from './clock-domain'
import type { SlaScope } from './async'

export const CONNECT_SLA_OUTBOX_LEASE_MS = 5 * 60 * 1000

export type ClockEventPayloadV1 = {
  schemaVersion: 1
  clockId: string
  caseId: string
  generation: number
  responseState: ClockState['responseState']
  resolutionState: ClockState['resolutionState']
  occurredAt: string
  sourceEventId: string
}

export function stageClockEvent(em: EntityManager, scope: SlaScope, eventType: ConnectSlaEventId, clock: ClockState, sourceEventId: string, occurredAt: Date): SlaEventOutbox {
  const payload: ClockEventPayloadV1 = {
    schemaVersion: 1,
    clockId: clock.id,
    caseId: clock.caseId,
    generation: clock.generation,
    responseState: clock.responseState,
    resolutionState: clock.resolutionState,
    occurredAt: occurredAt.toISOString(),
    sourceEventId,
  }
  const row = em.create(SlaEventOutbox, { ...scope, sourceEventId, eventType, payload, status: 'pending' })
  em.persist(row)
  return row
}

export async function claimClockEventBatch(em: EntityManager, limit: number, now = new Date()) {
  const lease = new Date(now.getTime() + CONNECT_SLA_OUTBOX_LEASE_MS)
  return em.execute<Array<{ id: string; event_type: string; payload: ClockEventPayloadV1 }>>(
    `update "connect_sla_event_outbox" set "lease_expires_at" = ?, "attempts" = "attempts" + 1, "updated_at" = ? where "id" in (select "id" from "connect_sla_event_outbox" where "status" = 'pending' and ("lease_expires_at" is null or "lease_expires_at" < ?) order by "created_at", "id" limit ? for update skip locked) returning "id", "event_type", "payload"`,
    [lease, now, now, limit],
  )
}

export async function markClockEventPublished(em: EntityManager, id: string, now = new Date()): Promise<void> {
  await em.execute(`update "connect_sla_event_outbox" set "status" = 'published', "published_at" = ?, "lease_expires_at" = null, "updated_at" = ? where "id" = ? and "status" = 'pending'`, [now, now, id])
}

import { z } from 'zod'
import type { ConnectCaseSlaReader, SlaCursor, SlaDeliveryDto, SlaGenerationDto, SlaWaitDto } from '../../connect/lib/sla-source-reader'
import type { BusinessCalendar } from './business-time'
import { applyClockSourceEvent, evaluateDue, type ClockSourceEvent, type ClockState, type ClockTransition } from './clock-domain'

export const CONNECT_SLA_QUEUES = { deadlineSweep: 'connect_sla.deadline_sweep', rebuild: 'connect_sla.rebuild', eventOutbox: 'connect_sla.event_outbox.publish' } as const
export const CONNECT_SLA_CONSUMER_VERSION = 1
export const CONNECT_SLA_DEADLINE_BATCH_SIZE = 100

export const deadlineSweepPayloadSchema = z.object({ tenantId: z.string().uuid(), organizationId: z.string().uuid(), now: z.string().datetime({ offset: true }).optional() }).strict()
export const rebuildPayloadSchema = z.object({ tenantId: z.string().uuid(), organizationId: z.string().uuid(), runId: z.string().uuid(), pageSize: z.number().int().min(1).max(100).default(100) }).strict()

export type SlaScope = { tenantId: string; organizationId: string }
export type StagedClockEvent = { id: string; clock: ClockState; sourceEventId: string; occurredAt: Date }

export interface ClockPersistence {
  transaction<T>(work: (transaction: ClockTransaction) => Promise<T>): Promise<T>
  processDue(scope: SlaScope, now: Date, limit: number, work: (clock: ClockState, transaction: ClockTransaction) => Promise<number>): Promise<number>
}

export interface ClockTransaction {
  hasReceipt(scope: SlaScope, sourceEventId: string, consumerVersion: number): Promise<boolean>
  addReceipt(scope: SlaScope, sourceEventId: string, consumerVersion: number): Promise<void>
  findClock(scope: SlaScope, caseId: string, generation: number): Promise<ClockState | null>
  saveClock(scope: SlaScope, clock: ClockState, expectedInternalVersion: number): Promise<boolean>
  stageEvent(scope: SlaScope, event: StagedClockEvent): Promise<void>
}

export type ClockRuntime = { calendar: BusinessCalendar; resolutionTargetMinutes: number }

export interface GenerationPersistence {
  createWithReceipt(scope: SlaScope, sourceEventId: string, clock: ClockState): Promise<'created' | 'duplicate'>
}

export function createGenerationConsumer(persistence: GenerationPersistence, buildClock: (payload: Record<string, unknown>) => Promise<{ scope: SlaScope; sourceEventId: string; clock: ClockState } | null>) {
  return { async apply(payload: Record<string, unknown>): Promise<'created' | 'duplicate' | 'no_policy'> {
    const built = await buildClock(payload)
    return built ? persistence.createWithReceipt(built.scope, built.sourceEventId, built.clock) : 'no_policy'
  } }
}

export interface ReparentPersistence {
  split(payload: Record<string, unknown>): Promise<'applied' | 'duplicate' | 'manual_review'>
  merge(payload: Record<string, unknown>): Promise<'applied' | 'duplicate' | 'manual_review'>
  undo(payload: Record<string, unknown>): Promise<'applied' | 'duplicate' | 'manual_review'>
}

export function createReparentConsumer(persistence: ReparentPersistence) {
  return { apply(type: 'split' | 'merged' | 'reparenting_undone', payload: Record<string, unknown>) {
    if (type === 'split') return persistence.split(payload)
    if (type === 'merged') return persistence.merge(payload)
    return persistence.undo(payload)
  } }
}

export function createConnectSlaSourceConsumer(persistence: ClockPersistence, resolveRuntime: (clock: ClockState) => Promise<ClockRuntime>) {
  return {
    async apply(scope: SlaScope, caseId: string, generation: number, source: ClockSourceEvent): Promise<'applied' | 'duplicate' | 'clock_missing' | 'conflict'> {
      return persistence.transaction(async (transaction) => {
        if (await transaction.hasReceipt(scope, source.sourceEventId, CONNECT_SLA_CONSUMER_VERSION)) return 'duplicate'
        const clock = await transaction.findClock(scope, caseId, generation)
        if (!clock) return 'clock_missing'
        const runtime = await resolveRuntime(clock)
        const transition = applyClockSourceEvent(clock, source, new Set(), runtime.calendar, runtime.resolutionTargetMinutes)
        if (transition.clock !== clock) {
          const saved = await transaction.saveClock(scope, transition.clock, clock.internalVersion)
          if (!saved) return 'conflict'
        }
        await transaction.addReceipt(scope, source.sourceEventId, CONNECT_SLA_CONSUMER_VERSION)
        if (transition.event) await transaction.stageEvent(scope, toStagedEvent(transition, source.sourceEventId, source.occurredAt))
        return 'applied'
      })
    },
  }
}

export function createDeadlineSweepService(persistence: ClockPersistence) {
  return {
    async sweep(scope: SlaScope, now: Date): Promise<number> {
      return persistence.processDue(scope, now, CONNECT_SLA_DEADLINE_BATCH_SIZE, async (candidate, transaction) => {
        let applied = 0
        const transitions = evaluateDue(candidate, now)
        for (const transition of transitions) {
          const current = await transaction.findClock(scope, candidate.caseId, candidate.generation)
          if (!current || current.internalVersion !== transition.clock.internalVersion - 1) continue
          const didSave = await transaction.saveClock(scope, transition.clock, current.internalVersion)
          if (!didSave) continue
          await transaction.stageEvent(scope, toStagedEvent(transition, `deadline:${transition.event}:${candidate.id}`, now))
          applied += 1
        }
        return applied
      })
    },
  }
}

export type RebuildCursorState = { generation: SlaCursor | null; wait: SlaCursor | null; delivery: SlaCursor | null }
export interface RebuildSink {
  applyGeneration(scope: SlaScope, value: SlaGenerationDto): Promise<void>
  applyWait(scope: SlaScope, value: SlaWaitDto): Promise<void>
  applyDelivery(scope: SlaScope, value: SlaDeliveryDto): Promise<void>
  saveCursor(runId: string, stream: keyof RebuildCursorState, cursor: SlaCursor | null): Promise<void>
}

export function createRebuildService(reader: ConnectCaseSlaReader | null, sink: RebuildSink) {
  return {
    healthy: reader !== null,
    async rebuild(scope: SlaScope, runId: string, pageSize: number): Promise<'completed' | 'dependency_unavailable'> {
      if (!reader) return 'dependency_unavailable'
      const through = await reader.captureHighWatermark(scope)
      await drain('generation', (input) => reader.listGenerations(scope, input), (item) => sink.applyGeneration(scope, item))
      await drain('wait', (input) => reader.listWaitIntervals(scope, input), (item) => sink.applyWait(scope, item))
      await drain('delivery', (input) => reader.listConfirmedDeliveries(scope, input), (item) => sink.applyDelivery(scope, item))
      return 'completed'

      async function drain<T>(stream: keyof RebuildCursorState, list: (input: { after?: SlaCursor; through: SlaCursor; limit: number }) => Promise<{ items: T[]; nextCursor: SlaCursor | null }>, apply: (item: T) => Promise<void>): Promise<void> {
        let after: SlaCursor | undefined
        do {
          const page = await list({ after, through, limit: pageSize })
          for (const item of page.items) await apply(item)
          await sink.saveCursor(runId, stream, page.nextCursor)
          after = page.nextCursor ?? undefined
          if (!page.nextCursor) return
        } while (after)
      }
    },
  }
}

function toStagedEvent(transition: ClockTransition, sourceEventId: string, occurredAt: Date): StagedClockEvent {
  return { id: `connect_sla.clock.${transition.event}`, clock: transition.clock, sourceEventId, occurredAt }
}

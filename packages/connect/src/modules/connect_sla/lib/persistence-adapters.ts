import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@mikro-orm/postgresql'
import { CaseClock, ClockRevision, EventReceipt, RebuildRun } from '../data/entities'
import type { ConnectSlaEventId } from '../events'
import type { ClockPersistence, ClockTransaction, GenerationPersistence, RebuildCursorState, RebuildSink, ReparentPersistence, SlaScope } from './async'
import { mergeClock, splitClock, supersedeClock, type ClockSourceEvent, type ClockState } from './clock-domain'
import type { SlaDeliveryDto, SlaGenerationDto, SlaWaitDto } from '../../connect/lib/sla-source-reader'
import { stageClockEvent } from './event-outbox'

function toState(row: CaseClock): ClockState {
  return {
    id: row.id,
    caseId: row.caseId,
    generation: row.generation,
    sourceEventId: row.sourceEventId,
    policyVersionId: row.policyVersionId,
    calendarVersionId: row.calendarVersionId,
    startedAt: row.startedAt,
    responseDueAt: row.responseDueAt,
    resolutionDueAt: row.resolutionDueAt,
    responseState: row.responseState,
    resolutionState: row.resolutionState,
    respondedAt: row.respondedAt,
    resolvedAt: row.resolvedAt,
    resolutionPausedSeconds: row.resolutionPausedSeconds,
    waitStartedAt: row.waitStartedAt,
    parentClockId: row.parentClockId,
    supersededByClockId: row.supersededByClockId,
    nextDueAt: row.nextDueAt,
    internalVersion: row.internalVersion,
  }
}

function clockValues(scope: SlaScope, clock: ClockState) {
  return { ...scope, ...clock }
}

function transactionAdapter(em: EntityManager): ClockTransaction {
  return {
    async hasReceipt(scope, sourceEventId, consumerVersion) {
      return (await em.count(EventReceipt, { ...scope, sourceEventId, consumerVersion })) > 0
    },
    async addReceipt(scope, sourceEventId, consumerVersion) {
      em.persist(em.create(EventReceipt, { id: randomUUID(), ...scope, sourceEventId, consumerVersion }))
      await em.flush()
    },
    async findClock(scope, caseId, generation) {
      const row = await em.findOne(CaseClock, { ...scope, caseId, generation })
      return row ? toState(row) : null
    },
    async saveClock(scope, clock, expectedInternalVersion) {
      const updated = await em.nativeUpdate(CaseClock, { ...scope, id: clock.id, internalVersion: expectedInternalVersion }, clockValues(scope, clock))
      return updated === 1
    },
    async stageEvent(scope, event) {
      stageClockEvent(em, scope, event.id as ConnectSlaEventId, event.clock, event.sourceEventId, event.occurredAt)
    },
  }
}

export function createMikroClockPersistence(em: EntityManager): ClockPersistence {
  return {
    transaction(work) {
      return em.transactional((transactionalEm) => work(transactionAdapter(transactionalEm)))
    },
    async processDue(scope, now, limit, work) {
      return em.transactional(async (transactionalEm) => {
        const rows = await transactionalEm.execute<{ id: string }[]>(
          `select "id" from "connect_sla_case_clocks" where "tenant_id" = ? and "organization_id" = ? and "next_due_at" <= ? order by "next_due_at" asc, "id" asc limit ? for update skip locked`,
          [scope.tenantId, scope.organizationId, now, limit],
        )
        if (!rows.length) return 0
        const clocks = await transactionalEm.find(CaseClock, { ...scope, id: { $in: rows.map((row) => row.id) } })
        const byId = new Map(clocks.map((clock) => [clock.id, clock]))
        const adapter = transactionAdapter(transactionalEm)
        let applied = 0
        for (const row of rows) {
          const clock = byId.get(row.id)
          if (clock) applied += await work(toState(clock), adapter)
        }
        return applied
      })
    },
  }
}

export function createMikroGenerationPersistence(em: EntityManager): GenerationPersistence {
  return {
    async createWithReceipt(scope, sourceEventId, clock) {
      return em.transactional(async (transactionalEm) => {
        if (await transactionalEm.count(EventReceipt, { ...scope, sourceEventId, consumerVersion: 1 })) return 'duplicate'
        const existing = await transactionalEm.findOne(CaseClock, { ...scope, caseId: clock.caseId, generation: clock.generation })
        if (existing) {
          const before = toState(existing)
          const after = { ...clock, id: existing.id, parentClockId: before.parentClockId, internalVersion: before.internalVersion + 1 }
          const updated = await transactionalEm.nativeUpdate(CaseClock, { ...scope, id: existing.id, internalVersion: before.internalVersion }, clockValues(scope, after))
          if (updated !== 1) return 'duplicate'
          transactionalEm.persist(transactionalEm.create(ClockRevision, { id: randomUUID(), ...scope, clockId: existing.id, internalVersion: after.internalVersion, reason: 'rebuild_replacement', before, after }))
        } else transactionalEm.persist(transactionalEm.create(CaseClock, clockValues(scope, clock)))
        transactionalEm.persist(transactionalEm.create(EventReceipt, { id: randomUUID(), ...scope, sourceEventId, consumerVersion: 1 }))
        stageClockEvent(transactionalEm, scope, 'connect_sla.clock.started', clock, sourceEventId, clock.startedAt)
        await transactionalEm.flush()
        return 'created'
      })
    },
  }
}

export function createMikroReparentPersistence(em: EntityManager): ReparentPersistence {
  return {
    split: (payload) => applyReparent(em, 'split', payload),
    merge: (payload) => applyReparent(em, 'merge', payload),
    undo: (payload) => undoReparent(em, payload),
  }
}

async function undoReparent(em: EntityManager, payload: Record<string, unknown>): Promise<'applied' | 'duplicate' | 'manual_review'> {
  const scope = readScope(payload)
  const sourceEventId = readString(payload, 'sourceEventId')
  const operation = readString(payload, 'operation')
  const sourceCaseId = readString(payload, 'sourceCaseId')
  const destinationCaseId = readString(payload, 'destinationCaseId')
  const sourceGeneration = readInteger(payload, 'sourceSlaGeneration')
  const destinationGeneration = readInteger(payload, 'destinationSlaGeneration')
  const occurredAt = readDate(payload, 'occurredAt')
  if (!scope || !sourceEventId || !sourceCaseId || !destinationCaseId || readInteger(payload, 'lineageVersion') !== 1 || sourceGeneration === null || destinationGeneration === null || (operation !== 'undo_split' && operation !== 'undo_merge')) return 'manual_review'
  return em.transactional(async (transactionalEm) => {
    if (await transactionalEm.count(EventReceipt, { ...scope, sourceEventId, consumerVersion: 1 })) return 'duplicate'
    const [source, destination] = await Promise.all([
      transactionalEm.findOne(CaseClock, { ...scope, caseId: sourceCaseId, generation: sourceGeneration }),
      transactionalEm.findOne(CaseClock, { ...scope, caseId: destinationCaseId, generation: destinationGeneration }),
    ])
    const target = operation === 'undo_split' ? destination : source
    if (!source || !destination || !target || (operation === 'undo_split' && destination.parentClockId !== source.id) || (operation === 'undo_merge' && source.resolutionState !== 'merged')) return 'manual_review'
    const before = toState(target)
    const after = operation === 'undo_split'
      ? supersedeClock(before, source.id).clock
      : { ...before, resolutionState: 'open' as const, nextDueAt: before.responseState === 'open' && before.responseDueAt < before.resolutionDueAt ? before.responseDueAt : before.resolutionDueAt, internalVersion: before.internalVersion + 1 }
    const updated = await transactionalEm.nativeUpdate(CaseClock, { ...scope, id: target.id, internalVersion: before.internalVersion }, clockValues(scope, after))
    if (updated !== 1) return 'manual_review'
    transactionalEm.persist(transactionalEm.create(ClockRevision, { id: randomUUID(), ...scope, clockId: target.id, internalVersion: after.internalVersion, reason: operation, before, after }))
    transactionalEm.persist(transactionalEm.create(EventReceipt, { id: randomUUID(), ...scope, sourceEventId, consumerVersion: 1 }))
    await transactionalEm.flush()
    return 'applied'
  })
}

async function applyReparent(em: EntityManager, operation: 'split' | 'merge', payload: Record<string, unknown>): Promise<'applied' | 'duplicate' | 'manual_review'> {
  const scope = readScope(payload)
  const sourceEventId = readString(payload, 'sourceEventId')
  const sourceCaseId = readString(payload, 'sourceCaseId')
  const destinationCaseId = readString(payload, 'destinationCaseId')
  const sourceGeneration = readInteger(payload, 'sourceSlaGeneration')
  const destinationGeneration = readInteger(payload, 'destinationSlaGeneration')
  const occurredAt = readDate(payload, 'occurredAt')
  if (!scope || !sourceEventId || !sourceCaseId || !destinationCaseId || sourceGeneration === null || destinationGeneration === null) return 'manual_review'
  return em.transactional(async (transactionalEm) => {
    if (await transactionalEm.count(EventReceipt, { ...scope, sourceEventId, consumerVersion: 1 })) return 'duplicate'
    const source = await transactionalEm.findOne(CaseClock, { ...scope, caseId: sourceCaseId, generation: sourceGeneration })
    if (!source) return 'manual_review'
    if (operation === 'split') {
      const existing = await transactionalEm.findOne(CaseClock, { ...scope, caseId: destinationCaseId, generation: destinationGeneration })
      if (!existing) {
        const child = splitClock(toState(source), { id: randomUUID(), caseId: destinationCaseId, sourceEventId })
        child.generation = destinationGeneration
        transactionalEm.persist(transactionalEm.create(CaseClock, clockValues(scope, child)))
        stageClockEvent(transactionalEm, scope, 'connect_sla.clock.started', child, sourceEventId, occurredAt ?? new Date())
      }
    } else {
      const transition = mergeClock(toState(source))
      if (transition.applied) {
        await transactionalEm.nativeUpdate(CaseClock, { ...scope, id: source.id, internalVersion: source.internalVersion }, clockValues(scope, transition.clock))
        stageClockEvent(transactionalEm, scope, 'connect_sla.clock.merged', transition.clock, sourceEventId, occurredAt ?? new Date())
      }
    }
    transactionalEm.persist(transactionalEm.create(EventReceipt, { id: randomUUID(), ...scope, sourceEventId, consumerVersion: 1 }))
    await transactionalEm.flush()
    return 'applied'
  })
}

function readScope(payload: Record<string, unknown>): SlaScope | null {
  const tenantId = readString(payload, 'tenantId')
  const organizationId = readString(payload, 'organizationId')
  return tenantId && organizationId ? { tenantId, organizationId } : null
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  return typeof payload[key] === 'string' && payload[key] ? payload[key] : null
}

function readInteger(payload: Record<string, unknown>, key: string): number | null {
  return typeof payload[key] === 'number' && Number.isInteger(payload[key]) && payload[key] >= 0 ? payload[key] : null
}

function readDate(payload: Record<string, unknown>, key: string): Date | null {
  const value = payload[key]
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date : null
}

export function createMikroRebuildSink(em: EntityManager, consumers: {
  generation: { apply: (payload: Record<string, unknown>) => Promise<unknown> }
  source: { apply: (scope: SlaScope, caseId: string, generation: number, source: ClockSourceEvent) => Promise<unknown> }
}): RebuildSink {
  return {
    async applyGeneration(scope, value: SlaGenerationDto) {
      await consumers.generation.apply({ ...scope, ...value, sourceEventId: value.id })
      if (value.resolvedAt) await consumers.source.apply(scope, value.caseId, value.generation, { type: 'resolved', sourceEventId: `${value.id}:resolved`, occurredAt: new Date(value.resolvedAt) })
    },
    async applyWait(scope, value: SlaWaitDto) {
      await consumers.source.apply(scope, value.caseId, value.generation, { type: 'wait_started', sourceEventId: `${value.id}:started`, occurredAt: new Date(value.startedAt) })
      if (value.endedAt) await consumers.source.apply(scope, value.caseId, value.generation, { type: 'wait_ended', sourceEventId: `${value.id}:ended`, occurredAt: new Date(value.endedAt), waitStartedAt: new Date(value.startedAt) })
    },
    async applyDelivery(scope, value: SlaDeliveryDto) {
      await consumers.source.apply(scope, value.caseId, value.generation, { type: 'response', sourceEventId: value.id, occurredAt: new Date(value.confirmedAt), evidence: value.responseEvidence })
    },
    async saveCursor(runId, stream, cursor) {
      const field: Record<keyof RebuildCursorState, 'generationCursor' | 'waitCursor' | 'deliveryCursor'> = {
        generation: 'generationCursor',
        wait: 'waitCursor',
        delivery: 'deliveryCursor',
      }
      await em.nativeUpdate(RebuildRun, { id: runId }, { [field[stream]]: cursor ? JSON.stringify(cursor) : null })
    },
  }
}
